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

interface PollRow {
  source_id: string;
  outcome: string;
  attempts: number;
  items_read: number;
  items_new: number | null;
  items_filtered: number | null;
  failure_reason: string | null;
  duration_ms: number;
}

/** The Run's Poll rows, ordered by Source. */
async function polls(runId: string): Promise<PollRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT source_id, outcome, attempts, items_read, items_new, items_filtered, failure_reason,
            duration_ms
     FROM polls WHERE run_id = ? ORDER BY source_id`,
  )
    .bind(runId)
    .all<PollRow>();
  return results;
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

  it("records one succeeded Poll per Source with its counts", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");
    await addSource("t-hf", "hf_daily_papers", "hf-daily-papers-2026-11-13.json");
    const run = await runTopic("polls-succeeded");

    expect(run.status).toBe("completed_no_new_findings");
    const rows = await polls(run.id);
    expect(rows).toEqual([
      {
        source_id: "t-hf",
        outcome: "succeeded",
        attempts: 1,
        items_read: 34,
        items_new: 34,
        items_filtered: 0,
        failure_reason: null,
        duration_ms: expect.any(Number),
      },
      {
        source_id: "t-vllm",
        outcome: "succeeded",
        attempts: 1,
        items_read: 50,
        items_new: 50,
        items_filtered: 0,
        failure_reason: null,
        duration_ms: expect.any(Number),
      },
    ]);
    for (const row of rows) expect(row.duration_ms).toBeGreaterThanOrEqual(0);

    // A second Run reads the same entries and finds nothing new.
    const second = await runTopic("polls-succeeded-again");
    expect((await polls(second.id)).map((p) => [p.source_id, p.items_read, p.items_new])).toEqual([
      ["t-hf", 34, 0],
      ["t-vllm", 50, 0],
    ]);
  });

  it("skips an unreadable Source and completes with the other Sources' Items", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");
    await addSource("t-missing", "atom", "missing.atom.xml");
    const run = await runTopic("polls-one-failed");

    expect(run).toMatchObject({ status: "completed_no_new_findings", failure_reason: null });
    expect(await itemCount(run.id)).toBe(50);
    expect(await dedupe(run.id)).toMatchObject({ recorded: 50, passed: 10 });
    const rows = await polls(run.id);
    expect(rows.find((p) => p.source_id === "t-missing")).toEqual({
      source_id: "t-missing",
      outcome: "failed",
      attempts: 1,
      items_read: 0,
      items_new: null,
      items_filtered: null,
      failure_reason: "Fixture not found: missing.atom.xml",
      duration_ms: expect.any(Number),
    });
    expect(rows.find((p) => p.source_id === "t-vllm")).toMatchObject({
      outcome: "succeeded",
      items_new: 50,
    });
  });

  it("fails at fetch naming every Source when all fail, and records each failed Poll", async () => {
    await addSource("t-missing", "atom", "missing.atom.xml");
    await addSource("t-wrong", "atom", "vllm-blog.rss.xml");
    const run = await runTopic("polls-all-failed", { expect: "errored" });

    expect(run).toMatchObject({ status: "failed", failed_stage: "fetch" });
    expect(run.failure_reason).toMatch(/^Every Source failed \(2\): /);
    expect(run.failure_reason).toContain("t-missing: Fixture not found: missing.atom.xml");
    expect(run.failure_reason).toContain("t-wrong: ");
    const rows = await polls(run.id);
    expect(rows.map((p) => [p.source_id, p.outcome, p.items_new])).toEqual([
      ["t-missing", "failed", null],
      ["t-wrong", "failed", null],
    ]);
    // Each Poll keeps its own reason, and the Run's reason carries it in full.
    const wrong = rows.find((p) => p.source_id === "t-wrong")?.failure_reason ?? "";
    expect(wrong.length).toBeGreaterThan(0);
    expect(run.failure_reason).toContain(`t-wrong: ${wrong}`);
    expect(rows.find((p) => p.source_id === "t-missing")?.failure_reason).toBe(
      "Fixture not found: missing.atom.xml",
    );
  });

  it("replaces the Run's whole Poll set when fetch records Polls again", async () => {
    await addSource("t-a", "rss2", "vllm-blog.rss.xml");
    await addSource("t-b", "rss2", "vllm-blog.rss.xml");
    await env.DB.prepare(
      "INSERT INTO runs (id, topic_id, kind, status) VALUES ('polls-replace', ?, 'manual', 'running')",
    )
      .bind(TOPIC)
      .run();
    const poll = (source_id: string) => ({
      source_id,
      outcome: "succeeded" as const,
      attempts: 1,
      items_read: 3,
      failure_reason: null,
      duration_ms: 0,
    });
    await store.recordPolls("polls-replace", [poll("t-a"), poll("t-b")]);
    await store.recordPollCounts("polls-replace", [
      { source_id: "t-a", items_new: 2, items_filtered: 0 },
    ]);

    // A retried fetch that no longer sees t-b.
    await store.recordPolls("polls-replace", [poll("t-a")]);
    expect((await polls("polls-replace")).map((p) => [p.source_id, p.items_new])).toEqual([
      ["t-a", null],
    ]);
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

  it("records all of a Source's Items on its first poll but passes only the newest 10", async () => {
    await addSource("t-modal", "atom", "modal-blog.atom.xml");
    const run = await runTopic("items-first-poll");

    expect(await itemCount(run.id)).toBe(157);
    const output = await dedupe(run.id);
    expect(output).toMatchObject({ recorded: 157, passed: 10 });
    // The 10 newest by Atom `updated`, worked out from the fixture with Python.
    expect(output.items.map((i) => i.item_key)).toEqual([
      "https://modal.com/blog/scaling-intelligence",
      "https://modal.com/blog/sandbox-bursting",
      "https://modal.com/blog/modal-gvisor-maintainer",
      "https://modal.com/blog/how-snorkel-runs-realistic-agent-simulations-with-modal",
      "https://modal.com/blog/sakana-case-study",
      "https://modal.com/blog/introducing-training-api",
      "https://modal.com/blog/get-started-with-llm-training-on-modal",
      "https://modal.com/blog/serverless-routing-made-sticky",
      "https://modal.com/blog/nvidia-vera-sandboxes",
      "https://modal.com/blog/how-legora-runs-thousand-scale-parallel-agent-evals-on-modal-sandboxes",
    ]);
  });

  it("caps each Source separately, and only on that Source's first poll", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");
    await runTopic("items-cap-a");
    await addSource("t-arxiv", "atom", "arxiv-serving.atom.xml");
    await env.DB.prepare(
      "UPDATE sources SET fixture_ref = 'vllm-blog-plus-one.rss.xml' WHERE id = 't-vllm'",
    ).run();

    const output = await dedupe((await runTopic("items-cap-b")).id);
    // t-arxiv is on its first poll (50 recorded, 10 passed); t-vllm is not (1 recorded, 1 passed).
    expect(output).toMatchObject({ recorded: 51, passed: 11 });
    const passedBySource = Object.groupBy(output.items, (i) => i.source_id);
    expect(passedBySource["t-arxiv"]).toHaveLength(10);
    expect(passedBySource["t-vllm"]?.map((i) => i.item_key)).toEqual([
      "https://vllm.ai/blog/fixture-extra-entry",
    ]);
  });

  it("counts Items recorded by a Run that later fails as unseen, so the next Run records them", async () => {
    await addSource("t-vllm", "rss2", "vllm-blog.rss.xml");

    // The Run records its Items in dedupe, then fails at the last step.
    const failed = await runTopic("items-failed", { expect: "errored", failStep: "complete" });
    expect(failed).toMatchObject({ status: "failed", failed_stage: "complete" });
    expect(await itemCount(failed.id)).toBe(50);

    const next = await runTopic("items-after-failed");
    expect(next.status).toBe("completed_no_new_findings");
    // Still a first poll: no completed Run has recorded this Source's Items.
    expect(await dedupe(next.id)).toMatchObject({ recorded: 50, passed: 10 });
    expect(await itemCount(next.id)).toBe(50);
    expect(await itemCount(failed.id)).toBe(0);

    const row = await env.DB.prepare(
      "SELECT content_key FROM items WHERE source_id = 't-vllm' LIMIT 1",
    ).first<{ content_key: string }>();
    expect(row?.content_key).toMatch(new RegExp(`/${next.id}\\.md$`));
    expect(await env.ARTIFACTS.head(row?.content_key ?? "")).not.toBeNull();
  });
});
