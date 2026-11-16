import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import type { FeedFormat, Run } from "../../src/core/ports";
import { deleteRuns, deleteTestTopics } from "./cleanup";

// Each test gets its own Topic and Sources, so it controls exactly which fixtures a Run reads.
// Entry counts per fixture come from inspecting the files with Python (see the unit tests).
const TOPIC = "test-feeds";
const store = new D1RunStore(env.DB);

async function addSource(id: string, format: FeedFormat, fixtureRef: string | null) {
  await env.DB.prepare(
    "INSERT INTO sources (id, topic_id, kind, format, fixture_ref) VALUES (?, ?, 'feed', ?, ?)",
  )
    .bind(id, TOPIC, format, fixtureRef)
    .run();
}

/** Starts a manual Run of the test Topic and waits for it to end. */
async function runTopic(
  id: string,
  opts: { expect?: "complete" | "errored"; failStep?: string } = {},
): Promise<Run> {
  await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, id);
  await instance.modify(async (m) => {
    await m.disableRetryDelays();
    if (opts.failStep) await m.mockStepError({ name: opts.failStep }, new Error("injected"));
  });
  await env.RUN_WORKFLOW.create({
    id,
    params: { topic_id: TOPIC, kind: "manual", scheduled_slot: null },
  });
  await instance.waitForStatus(opts.expect ?? "complete");
  const run = await store.getRun(id);
  if (!run) throw new Error(`Run ${id} not found`);
  return run;
}

interface DedupeOutput {
  recorded: number;
  passed: number;
  items: { source_id: string; item_key: string }[];
}

function dedupe(runId: string): Promise<DedupeOutput> {
  return stepOutput<DedupeOutput>(runId, "dedupe");
}

/** Items whose first-seen Run is this one. */
async function itemCount(runId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM items WHERE first_seen_run_id = ?")
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function stepOutput<T>(runId: string, step: string): Promise<T> {
  const object = await env.ARTIFACTS.get(`runs/${runId}/steps/${step}.json`);
  if (!object) throw new Error(`No ${step} artifact for ${runId}`);
  return ((await object.json()) as { output: T }).output;
}

describe("Runs read fixture feeds and record deduplicated Items", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_time_utc)
       VALUES (?, 'Test feeds', 'Test', 'daily', '12:00')`,
    )
      .bind(TOPIC)
      .run();
  });

  afterEach(async () => {
    await deleteRuns();
    await deleteTestTopics();
  });

  it("returns each Source's parsed entries in the fetch Step artifact", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");
    await addSource("t-hf", "hf_daily_papers", "hf-daily-papers-2026-11-13.json");
    const run = await runTopic("items-fetch");

    expect(run.status).toBe("completed_no_new_findings");
    const output = await stepOutput<{ sources: { source_id: string; items: unknown[] }[] }>(
      run.id,
      "fetch",
    );
    expect(output.sources.map((s) => [s.source_id, s.items.length])).toEqual([
      ["t-hf", 34],
      ["t-vllm", 50],
    ]);
  });

  it("ends the Run failed at stage fetch, with a reason, when a fixture is unreadable", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");
    await addSource("t-missing", "atom", "missing.atom.xml");
    const run = await runTopic("items-fetch-missing", { expect: "errored" });

    expect(run).toMatchObject({ status: "failed", failed_stage: "fetch" });
    expect(run.failure_reason).toContain("missing.atom.xml");
  });

  it("ends the Run failed at stage fetch when a fixture is not the format its Source declares", async () => {
    await addSource("t-wrong", "atom", "vllm-blog.rss.xml");
    const run = await runTopic("items-fetch-wrong", { expect: "errored" });

    expect(run).toMatchObject({ status: "failed", failed_stage: "fetch" });
    expect(run.failure_reason).toContain("t-wrong");
  });

  it("records a Source's Items once: a second Run on unchanged fixtures records none", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");

    const first = await runTopic("items-first");
    expect(first.status).toBe("completed_no_new_findings");
    expect(await dedupe(first.id)).toMatchObject({ recorded: 50 });
    expect(await itemCount(first.id)).toBe(50);

    const second = await runTopic("items-second");
    expect(second.status).toBe("completed_no_new_findings");
    expect(await dedupe(second.id)).toMatchObject({ recorded: 0, passed: 0, items: [] });
    expect(await itemCount(second.id)).toBe(0);
  });

  it("records exactly the one new Item when the feed gains one entry", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");
    await runTopic("items-base");
    await env.DB.prepare(
      "UPDATE sources SET fixture_ref = 'vllm-blog-plus-one.rss.xml' WHERE id = 't-vllm'",
    ).run();

    const run = await runTopic("items-plus-one");
    expect(run.status).toBe("completed_no_new_findings");
    const output = await dedupe(run.id);
    expect(output).toMatchObject({ recorded: 1, passed: 1 });
    expect(output.items.map((i) => i.item_key)).toEqual([
      "https://vllm.ai/blog/fixture-extra-entry",
    ]);
    expect(await itemCount(run.id)).toBe(1);
  });

  it("writes each new Item's content to R2 under its content key", async () => {
    await addSource("t-arxiv", "atom", "arxiv-serving.atom.xml");
    const run = await runTopic("items-content");

    const row = await env.DB.prepare(
      "SELECT item_key, content_key FROM items WHERE source_id = 't-arxiv' AND item_key = 'arxiv:2611.17097'",
    ).first<{ item_key: string; content_key: string }>();
    expect(row?.content_key).toBe(`items/t-arxiv/arxiv%3A2611.17097/${run.id}.md`);
    const object = await env.ARTIFACTS.get(row?.content_key ?? "");
    const text = (await object?.text()) ?? "";
    expect(text).toContain(
      "Broadcast, Don't Replicate: Eliminating Weight HBM in Datacenter LLM Serving",
    );
    expect(text).toContain("https://arxiv.org/abs/2611.17097v1");
    expect(text).toContain("Large language model (LLM) inference at datacenter scale is");
  });
});
