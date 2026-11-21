import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import { USER_AGENT } from "../../src/adapters/http-source-fetcher";
import type { FeedFormat, Run } from "../../src/core/ports";
import { deleteRuns, deleteTestTopics } from "./cleanup";
import {
  FEEDS,
  overrideFetchSettings,
  requests,
  resetFeeds,
  scriptFeed,
  sleeps,
  workerSettings,
} from "./fake-source-fetcher-factory";

// The Worker's real HttpSourceFetcher over a fake outbound fetch: fixture files served by URL,
// with failures scripted per URL. Each test gets its own Topic and Sources.
const TOPIC = "test-live";
const store = new D1RunStore(env.DB);
const VLLM = `${FEEDS}vllm-blog.rss.xml`;

async function addSource(id: string, format: FeedFormat, url: string) {
  await env.DB.prepare(
    "INSERT INTO sources (id, topic_id, kind, format, url) VALUES (?, ?, 'feed', ?, ?)",
  )
    .bind(id, TOPIC, format, url)
    .run();
}

/** Starts a manual Run of a Topic and waits for it to end. */
async function runTopic(
  id: string,
  opts: { topic?: string; expect?: "complete" | "errored" } = {},
): Promise<Run> {
  await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, id);
  await instance.modify(async (m) => {
    await m.disableRetryDelays();
  });
  await env.RUN_WORKFLOW.create({
    id,
    params: { topic_id: opts.topic ?? TOPIC, kind: "manual", scheduled_slot: null },
  });
  await instance.waitForStatus(opts.expect ?? "complete");
  const run = await store.getRun(id);
  if (!run) throw new Error(`Run ${id} not found`);
  return run;
}

interface PollRow {
  source_id: string;
  outcome: string;
  attempts: number;
  items_read: number;
  failure_reason: string | null;
}

/** The Run's Poll rows, ordered by Source. */
async function polls(runId: string): Promise<PollRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT source_id, outcome, attempts, items_read, failure_reason
     FROM polls WHERE run_id = ? ORDER BY source_id`,
  )
    .bind(runId)
    .all<PollRow>();
  return results;
}

describe("Runs read live feeds over HTTP", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_time_utc)
       VALUES (?, 'Test live feeds', 'Test', 'daily', '12:00')`,
    )
      .bind(TOPIC)
      .run();
  });

  afterEach(async () => {
    resetFeeds();
    await deleteRuns();
    await deleteTestTopics();
  });

  it("requests each Source's URL with the project User-Agent", async () => {
    await addSource("t-vllm", "rss2", VLLM);
    await addSource("t-modal", "atom", `${FEEDS}modal-blog.atom.xml`);

    const run = await runTopic("live-request");

    expect(run.status).toBe("completed_no_new_findings");
    expect(requests.map((r) => r.url)).toEqual([`${FEEDS}modal-blog.atom.xml`, VLLM]);
    for (const request of requests) {
      expect(request.headers["User-Agent"]).toBe(USER_AGENT);
      expect(request.headers["User-Agent"]).toMatch(/^research-lackey\//);
      // No email address, in any header.
      expect(JSON.stringify(request.headers)).not.toMatch(/@|mailto/i);
    }
    expect(await polls(run.id)).toEqual([
      {
        source_id: "t-modal",
        outcome: "succeeded",
        attempts: 1,
        items_read: 157,
        failure_reason: null,
      },
      {
        source_id: "t-vllm",
        outcome: "succeeded",
        attempts: 1,
        items_read: 50,
        failure_reason: null,
      },
    ]);
  });

  it("gives the fetcher the config's settings: a 20,000 ms timeout, 2 retries, 3,000 ms between arXiv requests", async () => {
    await addSource("t-vllm", "rss2", VLLM);

    await runTopic("live-settings");

    expect(workerSettings).toEqual({
      timeout_ms: 20_000,
      retries: 2,
      backoff_ms: 1_000,
      host_intervals_ms: { "export.arxiv.org": 3_000 },
    });
  });

  it("fails a Poll whose feed does not answer within the timeout, after retrying it twice", async () => {
    overrideFetchSettings({ timeout_ms: 30 });
    await addSource("t-slow", "rss2", VLLM);
    await addSource("t-modal", "atom", `${FEEDS}modal-blog.atom.xml`);
    scriptFeed(VLLM, ["timeout", "timeout", "timeout"]);

    const run = await runTopic("live-timeout");

    expect(run.status).toBe("completed_no_new_findings");
    expect(await polls(run.id)).toEqual([
      {
        source_id: "t-modal",
        outcome: "succeeded",
        attempts: 1,
        items_read: 157,
        failure_reason: null,
      },
      {
        source_id: "t-slow",
        outcome: "failed",
        attempts: 3,
        items_read: 0,
        failure_reason: "Timed out after 30 ms (3 attempts)",
      },
    ]);
  });

  it.each([
    ["a 429", { status: 429 }],
    ["a 503", { status: 503 }],
    ["a timeout", "timeout"],
  ] as const)("retries %s and reads the feed on the second attempt", async (_name, step) => {
    overrideFetchSettings({ timeout_ms: 30 });
    await addSource("t-vllm", "rss2", VLLM);
    scriptFeed(VLLM, [step]);

    const run = await runTopic("live-retry-once");

    expect(await polls(run.id)).toEqual([
      {
        source_id: "t-vllm",
        outcome: "succeeded",
        attempts: 2,
        items_read: 50,
        failure_reason: null,
      },
    ]);
    expect(requests.map((r) => r.url)).toEqual([VLLM, VLLM]);
  });

  it("retries twice with a doubling wait, then fails the Poll with 3 attempts", async () => {
    overrideFetchSettings({ backoff_ms: 20 });
    await addSource("t-down", "rss2", VLLM);
    await addSource("t-modal", "atom", `${FEEDS}modal-blog.atom.xml`);
    scriptFeed(VLLM, [{ status: 500 }, { status: 429 }, { status: 503 }]);

    const run = await runTopic("live-retry-exhausted");

    expect(run.status).toBe("completed_no_new_findings");
    expect((await polls(run.id)).find((p) => p.source_id === "t-down")).toEqual({
      source_id: "t-down",
      outcome: "failed",
      attempts: 3,
      items_read: 0,
      failure_reason: "HTTP 503 (3 attempts)",
    });
    expect(requests.filter((r) => r.url === VLLM)).toHaveLength(3);
    expect(sleeps).toEqual([20, 40]);
  });

  it.each([403, 404])("fails the Poll at once on a %i, without a retry", async (status) => {
    await addSource("t-gone", "rss2", VLLM);
    await addSource("t-modal", "atom", `${FEEDS}modal-blog.atom.xml`);
    scriptFeed(VLLM, [{ status }]);

    const run = await runTopic("live-4xx");

    expect((await polls(run.id)).find((p) => p.source_id === "t-gone")).toEqual({
      source_id: "t-gone",
      outcome: "failed",
      attempts: 1,
      items_read: 0,
      failure_reason: `HTTP ${status}`,
    });
    expect(requests.filter((r) => r.url === VLLM)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("spaces requests to export.arxiv.org by the configured interval", async () => {
    const interval = 150;
    overrideFetchSettings({ host_intervals_ms: { "export.arxiv.org": interval } });
    await addSource("t-arxiv-1", "atom", "https://export.arxiv.org/api/query?search_query=one");
    await addSource("t-arxiv-2", "atom", "https://export.arxiv.org/api/query?search_query=two");
    await addSource("t-arxiv-3", "atom", "https://export.arxiv.org/api/query?search_query=three");
    await addSource("t-vllm-1", "rss2", VLLM);
    await addSource("t-vllm-2", "rss2", `${FEEDS}vllm-blog-plus-one.rss.xml`);

    const run = await runTopic("live-spacing");

    expect((await polls(run.id)).map((p) => p.outcome)).toEqual(Array(5).fill("succeeded"));
    const at = (host: string) =>
      requests.filter((r) => new URL(r.url).hostname === host).map((r) => r.at);
    const [first = 0, second = 0, third = 0, ...rest] = at("export.arxiv.org");
    expect(rest).toEqual([]);
    expect(second - first).toBeGreaterThanOrEqual(interval);
    expect(third - second).toBeGreaterThanOrEqual(interval);
    // One wait before each later arXiv request (a timer that fires early adds another).
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it("a Run of the seed Topic requests the five live URLs, Daily Papers for the day before it started", async () => {
    const run = await runTopic("live-seed", { topic: "ai-infra" });

    expect(run.status).toBe("completed_no_new_findings");
    const started = new Date(run.started_at ?? "");
    const dayBefore = new Date(
      Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), started.getUTCDate() - 1),
    )
      .toISOString()
      .slice(0, 10);
    expect(requests.map((r) => r.url)).toEqual([
      "https://export.arxiv.org/api/query?search_query=%28cat:cs.DC+OR+cat:cs.PF+OR+cat:cs.OS%29+AND+%28abs:%22LLM+serving%22+OR+abs:%22LLM+inference%22+OR+abs:%22KV+cache%22+OR+abs:%22speculative+decoding%22+OR+abs:%22inference+serving%22%29&sortBy=submittedDate&sortOrder=descending&max_results=50",
      `https://huggingface.co/api/daily_papers?date=${dayBefore}`,
      "https://modal.com/blog/atom.xml",
      "https://vllm.ai/blog/rss.xml",
      "https://github.com/vllm-project/vllm/releases.atom",
    ]);
    expect((await polls(run.id)).map((p) => [p.source_id, p.outcome, p.items_read])).toEqual([
      ["arxiv-serving", "succeeded", 50],
      ["hf-daily-papers", "succeeded", 34],
      ["modal-blog", "succeeded", 157],
      ["vllm-blog", "succeeded", 50],
      ["vllm-releases", "succeeded", 10],
    ]);
    // The fetch Step artifact shows what was requested.
    const artifact = await env.ARTIFACTS.get(`runs/${run.id}/steps/fetch.json`);
    const stored = (await artifact?.json()) as
      | { output: { sources: { source_id: string; url: string }[] } }
      | undefined;
    expect(stored?.output.sources.find((s) => s.source_id === "hf-daily-papers")?.url).toBe(
      `https://huggingface.co/api/daily_papers?date=${dayBefore}`,
    );
  });

  it("applies the seed Sources' filters: Daily Papers by keyword, vLLM release candidates removed", async () => {
    const run = await runTopic("live-seed-filters", { topic: "ai-infra" });

    const { results } = await env.DB.prepare(
      "SELECT source_id, items_new, items_filtered FROM polls WHERE run_id = ? ORDER BY source_id",
    )
      .bind(run.id)
      .all<{ source_id: string; items_new: number; items_filtered: number }>();
    const filtered = Object.fromEntries(results.map((p) => [p.source_id, p.items_filtered]));
    // 7 of the 10 releases in the capture are release candidates.
    expect(filtered["vllm-releases"]).toBe(7);
    expect(filtered["hf-daily-papers"]).toBeGreaterThan(0);
    expect(filtered["hf-daily-papers"]).toBeLessThan(34);
    expect([filtered["arxiv-serving"], filtered["modal-blog"], filtered["vllm-blog"]]).toEqual([
      0, 0, 0,
    ]);
  });

  it("fails the Run at fetch when every feed keeps failing, with each Poll's attempts recorded", async () => {
    await addSource("t-a", "rss2", VLLM);
    await addSource("t-b", "atom", `${FEEDS}missing.atom.xml`);
    // Enough failures for the Workflow's own step retries too (4 step attempts of 3 requests).
    scriptFeed(VLLM, Array(12).fill("network"));

    const run = await runTopic("live-all-failed", { expect: "errored" });

    expect(run).toMatchObject({ status: "failed", failed_stage: "fetch" });
    expect(run.failure_reason).toBe(
      "Every Source failed (2): t-a: Network error: fake network error (3 attempts); t-b: HTTP 404",
    );
    expect((await polls(run.id)).map((p) => [p.source_id, p.outcome, p.attempts])).toEqual([
      ["t-a", "failed", 3],
      ["t-b", "failed", 1],
    ]);
  });
});
