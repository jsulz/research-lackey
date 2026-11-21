import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import { CONFIG, type RunConfig } from "../../src/core/config";
import { canonicalJson } from "../../src/core/hashing";
import type { ModelRequest, Run } from "../../src/core/ports";
import type { RunParams } from "../../src/core/run-ids";
import type { DedupeOutput, TriageOutput } from "../../src/core/stages";
import { deleteRuns, deleteTestTopics } from "./cleanup";
import { callsFor, resetScript, script, triageRefs } from "./scripted-model-client";

// A test Topic with one Source on the vLLM blog fixture: the first poll records 50 Items and passes
// the newest 10 on. Each test runs a manual source Run, then replays it.
const TOPIC = "test-replay";
const SOURCE = "test-replay-vllm";
const store = new D1RunStore(env.DB);

/** The committed config with Synthesis moved to Sonnet 5.5, priced. */
function sonnetSynthesis(): RunConfig {
  const config = structuredClone(CONFIG);
  config.tasks.synthesis = { model: "claude-sonnet-5-5", effort: "high", max_tokens: 12_000 };
  config.prices["claude-sonnet-5-5"] = {
    standard: { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 },
  };
  return config;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_time_utc)
       VALUES (?, 'Replay test topic', 'Track vLLM serving changes.', 'daily', '12:00')`,
    ).bind(TOPIC),
    env.DB.prepare(
      "INSERT INTO sources (id, topic_id, kind, format, url) VALUES (?, ?, 'feed', 'rss2', 'https://feeds.test/vllm-blog.rss.xml')",
    ).bind(SOURCE, TOPIC),
  ]);
});

afterEach(async () => {
  resetScript();
  await deleteRuns();
  await deleteTestTopics();
});

/** Runs a Workflow instance to the given end state and returns its Run row, if any. */
async function runInstance(
  id: string,
  params: Record<string, unknown>,
  end: "complete" | "errored",
): Promise<Run | null> {
  await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, id);
  await instance.modify(async (m) => {
    await m.disableRetryDelays();
  });
  // Cast: some tests pass params the Workflow must reject.
  await env.RUN_WORKFLOW.create({ id, params: params as unknown as RunParams });
  await instance.waitForStatus(end);
  return store.getRun(id);
}

function runSource(id: string, end: "complete" | "errored" = "complete") {
  return runInstance(id, { topic_id: TOPIC, kind: "manual", scheduled_slot: null }, end);
}

function replay(
  id: string,
  source: string,
  from: string,
  config: unknown,
  end: "complete" | "errored" = "complete",
) {
  return runInstance(id, { kind: "replay", source_run_id: source, from_stage: from, config }, end);
}

/** Answers Synthesis with one Finding citing I1. */
function oneFinding(summary: string): void {
  script((req: ModelRequest) => {
    const json = {
      summary,
      key_developments: [{ title: "t", what_is_new: "n", why_it_matters: "w", sources: ["I1"] }],
      implications: "i",
      worth_watching: [],
    };
    return {
      text: JSON.stringify(json),
      json,
      model: req.model,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_write_5m_input_tokens: 0,
        cache_write_1h_input_tokens: 0,
      },
    };
  });
}

async function artifact<T>(
  runId: string,
  step: string,
): Promise<{ input: unknown; output: T } | null> {
  const object = await env.ARTIFACTS.get(`runs/${runId}/steps/${step}.json`);
  return object ? ((await object.json()) as { input: unknown; output: T }) : null;
}

async function runRow(id: string) {
  return env.DB.prepare(
    "SELECT kind, source_run_id, from_stage, status, config_snapshot FROM runs WHERE id = ?",
  )
    .bind(id)
    .first<{
      kind: string;
      source_run_id: string | null;
      from_stage: string | null;
      status: string;
      config_snapshot: string;
    }>();
}

async function steps(runId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT step FROM run_steps WHERE run_id = ? ORDER BY step",
  )
    .bind(runId)
    .all<{ step: string }>();
  return results.map((r) => r.step);
}

async function itemRows(): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM items WHERE source_id = ? ORDER BY item_key",
  )
    .bind(SOURCE)
    .all();
  return results;
}

async function topicLine(): Promise<unknown> {
  const res = await exports.default.fetch("https://lackey.test/api/topics");
  const topics = (await res.json()) as { id: string }[];
  return topics.find((t) => t.id === TOPIC);
}

describe("Replay from synthesis", () => {
  it("reuses the source Run's Triage output, runs Synthesis and publish with the supplied config, and records that config", async () => {
    oneFinding("source");
    await runSource("rp-src");
    resetScript();
    oneFinding("replay");

    const config = sonnetSynthesis();
    const run = await replay("replay-test-1", "rp-src", "synthesis", config);
    expect(run?.status).toBe("completed_with_report");

    const row = await runRow("replay-test-1");
    expect(row).toMatchObject({ kind: "replay", source_run_id: "rp-src", from_stage: "synthesis" });
    expect(row?.config_snapshot).toBe(canonicalJson(config));
    expect(JSON.parse(row?.config_snapshot ?? "{}").tasks.synthesis.model).toBe(
      "claude-sonnet-5-5",
    );

    // No earlier stage ran again: no Triage call, no artifacts or Step rows before synthesis.
    expect(callsFor("triage")).toEqual([]);
    for (const step of ["fetch", "dedupe", "triage"]) {
      expect(await artifact("replay-test-1", step)).toBeNull();
    }
    expect(await steps("replay-test-1")).toEqual(["publish", "synthesis"]);

    // Synthesis read the source Run's Triage output with the supplied model, tagged env=dev.
    const source = await artifact<TriageOutput>("rp-src", "triage");
    const synthesis = await artifact("replay-test-1", "synthesis");
    expect(synthesis?.input).toEqual(source?.output);
    const [call] = callsFor("synthesis");
    expect(call).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "high",
      max_tokens: 12_000,
      metadata: { run_id: "replay-test-1", topic_id: TOPIC, step: "synthesis", env: "dev" },
    });
  });

  it("publishes a Report that the public API never shows, and leaves the source Run's Report listed", async () => {
    oneFinding("source");
    await runSource("rp-src");
    oneFinding("replay");
    await replay("replay-test-2", "rp-src", "synthesis", sonnetSynthesis());

    const report = await env.DB.prepare("SELECT id, public FROM reports WHERE run_id = ?")
      .bind("replay-test-2")
      .first<{ id: string; public: number }>();
    expect(report).toEqual({ id: "rpt_replay-test-2", public: 0 });

    const list = await exports.default.fetch("https://lackey.test/api/reports");
    const ids = ((await list.json()) as { run: { id: string } }[]).map((r) => r.run.id);
    expect(ids).toContain("rp-src");
    expect(ids).not.toContain("replay-test-2");

    const detail = await exports.default.fetch("https://lackey.test/api/reports/rpt_replay-test-2");
    expect(detail.status).toBe(404);
    const sourceDetail = await exports.default.fetch("https://lackey.test/api/reports/rpt_rp-src");
    expect(sourceDetail.status).toBe(200);
  });

  it("changes neither which Items count as seen nor the Topic's last-checked line, even when the source Run failed", async () => {
    // The source Run fails at synthesis, so its Items stay unseen and its Topic shows `failed`.
    script(() => {
      throw new Error("model down");
    });
    await runSource("rp-failed", "errored");
    const before = {
      items: await itemRows(),
      unseen: await store.unseenItemKeys(
        SOURCE,
        ((await itemRows()) as { item_key: string }[]).map((i) => i.item_key),
      ),
      firstPoll: await store.isFirstPoll(SOURCE),
      topic: await topicLine(),
    };
    expect(before.unseen).toHaveLength(50);
    expect(before.firstPoll).toBe(true);
    expect(before.topic).toMatchObject({ last_run_status: "failed" });

    oneFinding("replay");
    const run = await replay("replay-test-3", "rp-failed", "synthesis", sonnetSynthesis());
    expect(run?.status).toBe("completed_with_report");

    expect(await itemRows()).toEqual(before.items);
    expect(
      await store.unseenItemKeys(
        SOURCE,
        (before.items as { item_key: string }[]).map((i) => i.item_key),
      ),
    ).toEqual(before.unseen);
    expect(await store.isFirstPoll(SOURCE)).toBe(true);
    expect(await topicLine()).toEqual(before.topic);
  });
});

describe("Replay from triage", () => {
  it("reuses the source Run's dedupe output and runs Triage onward with the supplied limits", async () => {
    await runSource("rp-src");
    resetScript();

    const config = structuredClone(CONFIG);
    config.triage_limit = 3;
    config.synthesis_k = 2;
    config.tasks.triage = { model: "claude-haiku-5-5", effort: "medium", max_tokens: 4_000 };
    const run = await replay("replay-test-4", "rp-src", "triage", config);
    expect(run?.status).toBe("completed_no_new_findings");

    const dedupe = await artifact<DedupeOutput>("rp-src", "dedupe");
    const triage = await artifact<TriageOutput>("replay-test-4", "triage");
    expect(triage?.input).toEqual(dedupe?.output);
    expect(triage?.output.scored).toHaveLength(3);
    expect(triage?.output.selected).toHaveLength(2);

    const [call] = callsFor("triage");
    expect(call).toMatchObject({ effort: "medium", max_tokens: 4_000 });
    expect(triageRefs(call as ModelRequest)).toEqual(["I1", "I2", "I3"]);
    expect(await steps("replay-test-4")).toEqual(["publish", "synthesis", "triage"]);
    expect(await artifact("replay-test-4", "dedupe")).toBeNull();
    expect(await runRow("replay-test-4")).toMatchObject({
      kind: "replay",
      source_run_id: "rp-src",
      from_stage: "triage",
      config_snapshot: canonicalJson(config),
    });
  });

  it("fails the Replay at triage, with the reason, when the source Run has no dedupe artifact", async () => {
    oneFinding("source");
    await runSource("rp-src");
    await replay("replay-test-5", "rp-src", "synthesis", CONFIG);
    resetScript();

    const run = await replay("replay-test-6", "replay-test-5", "triage", CONFIG, "errored");
    expect(run).toMatchObject({ kind: "replay", status: "failed", failed_stage: "triage" });
    expect(run?.failure_reason).toMatch(/dedupe/);
    expect(callsFor("triage")).toEqual([]);
  });
});
