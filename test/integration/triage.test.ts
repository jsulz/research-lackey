import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import triagePromptFile from "../../prompts/triage.md";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import { CONFIG } from "../../src/core/config";
import { stageCost } from "../../src/core/cost";
import type { ModelRequest, ModelUsage, Run } from "../../src/core/ports";
import type { DedupeOutput, SynthesisOutput, TriageOutput } from "../../src/core/stages";
import { deleteRuns, deleteTestTopics } from "./cleanup";
import { callsFor, resetScript, script, triageRefs } from "./scripted-model-client";

const TOPIC = "test-triage";
const store = new D1RunStore(env.DB);

/** Creates the test Topic with one Source per `[format, fixture_ref]`. */
async function seedTopic(sources: [string, string][]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_time_utc)
       VALUES (?, 'Triage test topic', 'Track LLM serving engines.', 'daily', '12:00')`,
    ).bind(TOPIC),
    ...sources.map(([format, ref], i) =>
      env.DB.prepare(
        "INSERT INTO sources (id, topic_id, kind, format, fixture_ref) VALUES (?, ?, 'feed', ?, ?)",
      ).bind(`${TOPIC}-${i}`, TOPIC, format, ref),
    ),
  ]);
}

afterEach(async () => {
  resetScript();
  await deleteRuns();
  await deleteTestTopics();
});

async function runTopic(id: string, expect: "complete" | "errored" = "complete"): Promise<Run> {
  await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, id);
  await instance.modify(async (m) => {
    await m.disableRetryDelays();
  });
  await env.RUN_WORKFLOW.create({
    id,
    params: { topic_id: TOPIC, kind: "manual", scheduled_slot: null },
  });
  await instance.waitForStatus(expect);
  const run = await store.getRun(id);
  if (!run) throw new Error(`Run ${id} not found`);
  return run;
}

async function stepOutput<T>(runId: string, step: string): Promise<T> {
  const object = await env.ARTIFACTS.get(`runs/${runId}/steps/${step}.json`);
  if (!object) throw new Error(`No ${step} artifact for ${runId}`);
  return ((await object.json()) as { output: T }).output;
}

function usage(input: number, output: number): ModelUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_write_5m_input_tokens: 0,
    cache_write_1h_input_tokens: 0,
  };
}

/** Scores Items by `scoreOf(ref, index)`, with the given usage. */
function scoreWith(scoreOf: (ref: string, i: number, all: string[]) => number, u?: ModelUsage) {
  script((req: ModelRequest) => {
    const refs = triageRefs(req);
    const json = {
      scores: refs.map((ref, i) => ({ ref, score: scoreOf(ref, i, refs), reason: `r${ref}` })),
    };
    return { text: JSON.stringify(json), json, model: req.model, usage: u ?? usage(1_000, 200) };
  }, "triage");
}

describe("Triage", () => {
  it("scores at most the configured limit of distinct new Items, newest first, from title plus summary or content text, and records how many the limit dropped", async () => {
    // Modal's blog has 157 entries. A completed earlier Run recorded one Item for its Source, so
    // this is not a first poll and every entry passes; with vLLM's 10 releases that is well over
    // the limit of 100.
    await seedTopic([
      ["atom", "modal-blog.atom.xml"],
      ["atom", "vllm-releases-2026-11-17.atom.xml"],
    ]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO runs (id, topic_id, kind, status) VALUES ('tri-limit-prior', ?, 'manual', 'completed_no_new_findings')",
      ).bind(TOPIC),
      env.DB.prepare(
        `INSERT INTO items (source_id, item_key, url, title, first_seen_run_id)
         VALUES (?, 'prior', 'https://example.com/prior', 'Prior', 'tri-limit-prior')`,
      ).bind(`${TOPIC}-0`),
    ]);
    await runTopic("tri-limit");

    const dedupe = await stepOutput<DedupeOutput>("tri-limit", "dedupe");
    const distinct = new Set(dedupe.items.map((i) => i.item_key)).size;
    expect(CONFIG.triage_limit).toBe(100);
    expect(distinct).toBeGreaterThan(CONFIG.triage_limit);

    const triageCalls = callsFor("triage");
    expect(triageCalls).toHaveLength(1);
    const req = triageCalls[0];
    expect(req).toMatchObject({
      task: "triage",
      model: CONFIG.tasks.triage.model,
      effort: CONFIG.tasks.triage.effort,
      max_tokens: CONFIG.tasks.triage.max_tokens,
      system: triagePromptFile,
      metadata: { run_id: "tri-limit", topic_id: TOPIC, step: "triage", env: env.APP_ENV },
    });
    expect(triageRefs(req as ModelRequest)).toHaveLength(CONFIG.triage_limit);
    expect(req?.prompt.match(/<item ref=/g)).toHaveLength(CONFIG.triage_limit);
    expect(req?.prompt).toContain("Research goal: Track LLM serving engines.");
    // A release has no summary: its triage text is markup-free release notes.
    expect(req?.prompt).toContain("Extensible KV cache is on by default");
    expect(req?.prompt).not.toContain("<h1>");

    const triage = await stepOutput<TriageOutput>("tri-limit", "triage");
    expect(triage).toMatchObject({
      new_items: dedupe.passed,
      triaged: CONFIG.triage_limit,
      not_triaged: distinct - CONFIG.triage_limit,
    });
    expect(triage.not_triaged).toBeGreaterThan(0);
    expect(triage.scored).toHaveLength(CONFIG.triage_limit);
    expect(new Set(triage.scored.map((s) => s.item_key)).size).toBe(CONFIG.triage_limit);
  });

  it("passes the top K by score to Synthesis, highest first", async () => {
    await seedTopic([["rss2", "vllm-blog.rss.xml"]]);
    // The oldest Items score highest: the last ref 10, the one before it 9, and so on.
    scoreWith((_ref, i, all) => Math.max(0, 10 - (all.length - 1 - i)));
    await runTopic("tri-topk");

    const triage = await stepOutput<TriageOutput>("tri-topk", "triage");
    expect(triage.scored).toHaveLength(10);
    const expected = [...triage.scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.synthesis_k)
      .map((s) => s.item_key);
    expect(triage.scored.slice(-CONFIG.synthesis_k).map((s) => s.item_key)).toEqual(
      [...expected].reverse(),
    );
    expect(triage.selected.map((i) => i.item_key)).toEqual(expected);

    const synthesis = await stepOutput<SynthesisOutput>("tri-topk", "synthesis");
    expect(synthesis.items.map((i) => [i.ref, i.item_key])).toEqual(
      expected.map((key, i) => [`I${i + 1}`, key]),
    );
    expect(callsFor("synthesis")[0]?.prompt.match(/<item ref=/g)).toHaveLength(CONFIG.synthesis_k);
  });

  it("fails the Run at triage, with no Synthesis call, when Triage leaves an Item unscored", async () => {
    await seedTopic([["rss2", "vllm-blog.rss.xml"]]);
    script((req) => {
      const json = {
        scores: triageRefs(req)
          .slice(1)
          .map((ref) => ({ ref, score: 5, reason: "" })),
      };
      return { text: JSON.stringify(json), json, model: req.model, usage: usage(1, 1) };
    }, "triage");
    const run = await runTopic("tri-invalid", "errored");
    expect(run).toMatchObject({ status: "failed", failed_stage: "triage" });
    expect(run.failure_reason).toMatch(/no score for I1/);
    expect(callsFor("synthesis")).toEqual([]);
  });
});

describe("Synthesis text", () => {
  it("sends vllm-releases notes, which have no summary, as plain text up to the content cap", async () => {
    await seedTopic([["atom", "vllm-releases-2026-11-17.atom.xml"]]);
    await runTopic("syn-plain");

    const prompt = callsFor("synthesis")[0]?.prompt ?? "";
    const bodies = [
      ...prompt.matchAll(/<item ref="I\d+">\n[\s\S]*?\nURL: [^\n]*\n\n([\s\S]*?)\n<\/item>/g),
    ].map((m) => m[1] ?? "");
    expect(bodies).toHaveLength(CONFIG.synthesis_k);
    for (const body of bodies) {
      expect(body.trim()).not.toBe("");
      expect(body).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(body).not.toMatch(/^# |\n## Content/);
    }
    // v0.34.0's notes run past the cap: Synthesis reads up to 16,000 characters, not 4,000.
    const v034 = bodies.find((b) => b.includes("Extensible KV cache is on by default"));
    expect(v034).toBeDefined();
    expect(v034?.endsWith("\n[truncated]")).toBe(true);
    expect(v034?.length).toBe(CONFIG.synthesis_content_chars + "\n[truncated]".length);
  });
});

describe("Synthesis reads content first", () => {
  it("sends an Item's content as plain text, not its summary, capped at the content cap", async () => {
    await seedTopic([["atom", "summary-and-content.atom.xml"]]);
    await runTopic("syn-content");

    const dedupe = await stepOutput<DedupeOutput>("syn-content", "dedupe");
    expect(dedupe.items.map((i) => i.summary)).toEqual([
      "Teaser for the short post.",
      "Teaser for the long post.",
    ]);

    const prompt = callsFor("synthesis")[0]?.prompt ?? "";
    const bodies = new Map(
      [
        ...prompt.matchAll(
          /<item ref="I\d+">\n[\s\S]*?\nTitle: ([^\n]*)\nURL: [^\n]*\n\n([\s\S]*?)\n<\/item>/g,
        ),
      ].map((m) => [m[1], m[2] ?? ""]),
    );
    expect(bodies.size).toBe(2);
    expect(prompt).not.toContain("Teaser for");

    expect(bodies.get("Short post")).toBe(
      "Short post The full article explains chunked prefill & why it lowers tail latency.",
    );
    const long = bodies.get("Long post") ?? "";
    expect(long).toMatch(/^Paged attention keeps the KV cache/);
    expect(long).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(long.endsWith("\n[truncated]")).toBe(true);
    expect(long.length).toBe(CONFIG.synthesis_content_chars + "\n[truncated]".length);
  });
});

describe("Cost per stage", () => {
  it("records triage and synthesis tokens and cost separately; the Reports API sums both per model", async () => {
    await seedTopic([["rss2", "vllm-blog.rss.xml"]]);
    const triageUsage = usage(15_000, 2_500);
    const synthesisUsage = usage(3_000, 1_200);
    scoreWith(() => 5, triageUsage);
    script((req) => {
      const json = {
        summary: "s",
        key_developments: [{ title: "t", what_is_new: "n", why_it_matters: "w", sources: ["I1"] }],
        implications: "i",
        worth_watching: [],
      };
      return { text: JSON.stringify(json), json, model: req.model, usage: synthesisUsage };
    });
    const run = await runTopic("tri-cost");
    expect(run.status).toBe("completed_with_report");

    const haiku = CONFIG.prices["claude-haiku-5-5"];
    const sonnet = CONFIG.prices["claude-sonnet-5-5"];
    if (!haiku || !sonnet) throw new Error("no Haiku or Sonnet price");
    const triageCost = stageCost(triageUsage, haiku);
    const synthesisCost = stageCost(synthesisUsage, sonnet);
    const { results: steps } = await env.DB.prepare(
      "SELECT step, model, input_tokens, output_tokens, cost_usd FROM run_steps WHERE run_id = ? AND model IS NOT NULL ORDER BY rowid",
    )
      .bind(run.id)
      .all<{
        step: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
      }>();
    expect(steps.map(({ cost_usd: _c, ...s }) => s)).toEqual([
      { step: "triage", model: "claude-haiku-5-5", input_tokens: 15_000, output_tokens: 2_500 },
      { step: "synthesis", model: "claude-sonnet-5-5", input_tokens: 3_000, output_tokens: 1_200 },
    ]);
    // Haiku: 15,000 x $0.10 + 2,500 x $0.50 per million = $0.00275.
    // Sonnet: 3,000 x $2 + 1,200 x $10 per million = $0.018.
    expect(steps[0]?.cost_usd).toBeCloseTo(0.00275, 10);
    expect(steps[1]?.cost_usd).toBeCloseTo(0.018, 10);
    expect(triageCost).toBeCloseTo(0.00275, 10);
    expect(synthesisCost).toBeCloseTo(0.018, 10);

    const res = await exports.default.fetch("https://lackey.test/api/reports");
    const reports = (await res.json()) as {
      run: { id: string };
      tokens: { model: string; input: number; output: number }[];
      cost_usd: number;
    }[];
    const report = reports.find((r) => r.run.id === "tri-cost");
    expect(report?.tokens).toEqual([
      { model: "claude-haiku-5-5", input: 15_000, output: 2_500 },
      { model: "claude-sonnet-5-5", input: 3_000, output: 1_200 },
    ]);
    expect(report?.cost_usd).toBeCloseTo(0.02075, 10);
  });
});
