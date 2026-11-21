import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import synthesisPromptFile from "../../prompts/synthesis.md";
import triagePromptFile from "../../prompts/triage.md";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import { CONFIG } from "../../src/core/config";
import { sha256Hex } from "../../src/core/hashing";
import type { ModelRequest, ReportDocument, Run } from "../../src/core/ports";
import { deleteRuns, deleteTestTopics } from "./cleanup";
import { calls, callsFor, resetScript, script } from "./scripted-model-client";

// A test Topic with one Source on the vLLM blog fixture: 50 entries, first poll passes the newest
// 10 onward, Triage scores them evenly by default, so Synthesis takes the newest K = 5.
const TOPIC = "test-reports";
const SOURCE = "test-reports-vllm";
const store = new D1RunStore(env.DB);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_time_utc)
       VALUES (?, 'Report test topic', 'Track vLLM serving changes.', 'daily', '12:00')`,
    ).bind(TOPIC),
    env.DB.prepare(
      "INSERT INTO sources (id, topic_id, kind, format, fixture_ref) VALUES (?, ?, 'feed', 'rss2', 'vllm-blog.rss.xml')",
    ).bind(SOURCE, TOPIC),
  ]);
});

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

const USAGE = {
  input_tokens: 2_000,
  output_tokens: 3_000,
  cache_read_input_tokens: 1_000,
  cache_write_5m_input_tokens: 0,
  cache_write_1h_input_tokens: 0,
};

/** Answers with a Report whose Findings cite the given refs, one Finding per list. */
function answerWith(findingRefs: string[][]) {
  script((req: ModelRequest) => {
    const json = {
      summary: "vLLM shipped serving changes.",
      key_developments: findingRefs.map((refs, i) => ({
        title: `Finding ${i + 1}`,
        what_is_new: `New thing ${i + 1}`,
        why_it_matters: `Matters ${i + 1}`,
        sources: refs,
      })),
      implications: "Serving gets faster.",
      worth_watching: ["Next release"],
    };
    return { text: JSON.stringify(json), json, model: req.model, usage: USAGE };
  });
}

/** The Items the Run sent to Synthesis, by ref, from its Step artifact. */
async function synthesisRefs(
  runId: string,
): Promise<Record<string, { source_id: string; item_key: string }>> {
  const object = await env.ARTIFACTS.get(`runs/${runId}/steps/synthesis.json`);
  const artifact = (await object?.json()) as {
    output: { items: { ref: string; source_id: string; item_key: string }[] };
  };
  return Object.fromEntries(artifact.output.items.map((i) => [i.ref, i]));
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
}

describe("Synthesis and publish", () => {
  it("publishes a Report: Findings with stable IDs linked to their Items, JSON and Markdown in R2, completed_with_report", async () => {
    answerWith([["I1", "I2"], ["I3"]]);
    const run = await runTopic("rpt-happy");
    expect(run.status).toBe("completed_with_report");

    const reports = await all<Record<string, unknown>>(
      "SELECT * FROM reports WHERE run_id = ?",
      run.id,
    );
    expect(reports).toEqual([
      expect.objectContaining({
        id: "rpt_rpt-happy",
        topic_id: TOPIC,
        public: 1,
        r2_key: "reports/rpt_rpt-happy.json",
        summary: "vLLM shipped serving changes.",
        finding_count: 2,
      }),
    ]);

    const findings = await all<{ id: string; title: string; position: number }>(
      "SELECT id, title, position FROM findings WHERE report_id = ? ORDER BY position",
      "rpt_rpt-happy",
    );
    expect(findings).toEqual([
      { id: "fnd_rpt-happy_1", title: "Finding 1", position: 1 },
      { id: "fnd_rpt-happy_2", title: "Finding 2", position: 2 },
    ]);

    const refs = await synthesisRefs(run.id);
    const links = await all<{ finding_id: string; source_id: string; item_key: string }>(
      `SELECT fi.finding_id, fi.source_id, fi.item_key FROM finding_items fi
       JOIN items i ON i.source_id = fi.source_id AND i.item_key = fi.item_key
       WHERE fi.finding_id IN ('fnd_rpt-happy_1', 'fnd_rpt-happy_2')
       ORDER BY fi.finding_id, fi.item_key`,
    );
    const byFinding = (a: { finding_id: string; item_key: string }, b: typeof a) =>
      a.finding_id.localeCompare(b.finding_id) || a.item_key.localeCompare(b.item_key);
    const cited: [string, string][] = [
      ["fnd_rpt-happy_1", "I1"],
      ["fnd_rpt-happy_1", "I2"],
      ["fnd_rpt-happy_2", "I3"],
    ];
    const expected = cited.map(([finding_id, ref]) => {
      const item = refs[ref];
      if (!item) throw new Error(`ref ${ref} missing from the synthesis artifact`);
      return { finding_id, source_id: item.source_id, item_key: item.item_key };
    });
    expect(links).toEqual(expected.sort(byFinding));

    const doc = (await (
      await env.ARTIFACTS.get("reports/rpt_rpt-happy.json")
    )?.json()) as ReportDocument;
    expect(doc).toMatchObject({
      id: "rpt_rpt-happy",
      run_id: run.id,
      topic: { id: TOPIC, name: "Report test topic" },
      model: CONFIG.tasks.synthesis.model,
      summary: "vLLM shipped serving changes.",
      implications: "Serving gets faster.",
      worth_watching: ["Next release"],
    });
    expect(doc.findings.map((f) => [f.id, f.items.map((i) => i.item_key)])).toEqual([
      ["fnd_rpt-happy_1", [refs.I1?.item_key, refs.I2?.item_key]],
      ["fnd_rpt-happy_2", [refs.I3?.item_key]],
    ]);
    const md = await (await env.ARTIFACTS.get("reports/rpt_rpt-happy.md"))?.text();
    expect(md).toContain("# Report test topic");
    expect(md).toContain("### Finding 1");
  });

  it("sends the newest K new Items to the configured model with structured output and Run metadata", async () => {
    answerWith([["I1"]]);
    await runTopic("rpt-request");
    expect(callsFor("synthesis")).toHaveLength(1);
    const req = callsFor("synthesis")[0];
    expect(req).toMatchObject({
      task: "synthesis",
      model: CONFIG.tasks.synthesis.model,
      effort: CONFIG.tasks.synthesis.effort,
      max_tokens: CONFIG.tasks.synthesis.max_tokens,
      system: synthesisPromptFile,
      metadata: { run_id: "rpt-request", topic_id: TOPIC, step: "synthesis", env: env.APP_ENV },
    });
    expect(req?.json_schema).toBeDefined();
    expect(req?.prompt).toContain("Research goal: Track vLLM serving changes.");
    expect(req?.prompt.match(/<item ref=/g)).toHaveLength(CONFIG.synthesis_k);
  });

  it("ends completed_no_new_findings, publishing nothing, when Synthesis returns zero Findings", async () => {
    answerWith([]);
    const run = await runTopic("rpt-zero");
    expect(run.status).toBe("completed_no_new_findings");
    expect(await all("SELECT id FROM reports WHERE run_id = ?", run.id)).toEqual([]);
    expect(await env.ARTIFACTS.get("reports/rpt_rpt-zero.json")).toBeNull();
  });

  it("makes no model call when the Run has no new Items", async () => {
    await runTopic("rpt-first");
    calls.length = 0;
    const second = await runTopic("rpt-second");
    expect(second.status).toBe("completed_no_new_findings");
    expect(calls).toEqual([]);
  });

  it.each([
    ["cites an unknown Item", { sources: ["I99"] }],
    ["has a blank why_it_matters", { why_it_matters: "" }],
  ])(
    "ends the Run failed at synthesis, with no Report, when the output %s",
    async (_name, patch) => {
      script((req) => {
        const json = {
          summary: "s",
          key_developments: [
            { title: "t", what_is_new: "n", why_it_matters: "w", sources: ["I1"], ...patch },
          ],
          implications: "i",
          worth_watching: [],
        };
        return { text: JSON.stringify(json), json, model: req.model, usage: USAGE };
      });
      const run = await runTopic("rpt-invalid", "errored");
      expect(run).toMatchObject({ status: "failed", failed_stage: "synthesis" });
      expect(run.failure_reason).toMatch(/key_developments\[0\]/);
      expect(await all("SELECT id FROM reports WHERE run_id = ?", run.id)).toEqual([]);
      expect(await env.ARTIFACTS.get("reports/rpt_rpt-invalid.json")).toBeNull();
    },
  );
});

describe("Run cost and config", () => {
  it("records Synthesis tokens and cost equal to usage times the config prices, and a row per stage", async () => {
    answerWith([["I1"]]);
    const run = await runTopic("rpt-cost");
    const steps = await all<Record<string, unknown>>(
      "SELECT step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, artifact_key FROM run_steps WHERE run_id = ? ORDER BY rowid",
      run.id,
    );
    expect(steps.map((s) => s.step)).toEqual(["fetch", "dedupe", "triage", "synthesis", "publish"]);
    const synthesis = steps.find((s) => s.step === "synthesis");
    // The scripted client answers with the requested model, so this is the model Synthesis asked for.
    expect(synthesis).toMatchObject({
      model: "claude-sonnet-5-5",
      input_tokens: 2_000,
      output_tokens: 3_000,
      cache_read_tokens: 1_000,
      cache_write_tokens: 0,
      artifact_key: "runs/rpt-cost/steps/synthesis.json",
    });
    // Sonnet: 2,000 x $2 + 3,000 x $10 + 1,000 x $0.10, per million tokens = $0.0341.
    expect(synthesis?.cost_usd).toBeCloseTo(0.0341, 10);
    for (const s of steps.filter((s) => s.step !== "synthesis" && s.step !== "triage")) {
      expect(s).toMatchObject({
        model: null,
        cost_usd: 0,
        artifact_key: `runs/rpt-cost/steps/${s.step}.json`,
      });
    }
  });

  it("stores one hash per prompt file: sha256 of the Triage and Synthesis prompts", async () => {
    const run = await runTopic("rpt-hashes");
    const row = await env.DB.prepare("SELECT prompt_hashes FROM runs WHERE id = ?")
      .bind(run.id)
      .first<{ prompt_hashes: string }>();
    expect(JSON.parse(row?.prompt_hashes ?? "null")).toEqual({
      triage: await sha256Hex(triagePromptFile),
      synthesis: await sha256Hex(synthesisPromptFile),
    });
  });
});
