import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRuns } from "./cleanup";

const BASE = "https://lackey.test";

async function getReport(id: string) {
  const res = await exports.default.fetch(`${BASE}/api/reports/${id}`);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() };
}

const keys: string[] = [];

/** The Report document as `publish` writes it, plus fields the public API must never pass on. */
function document(run: string) {
  return {
    id: `rpt_${run}`,
    run_id: run,
    topic: { id: "ai-infra", name: "AI infrastructure platforms" },
    generated_at: "2026-11-16T12:01:31.000Z",
    model: "claude-haiku-5-5",
    summary: "Two serving releases this week.",
    findings: [
      {
        id: `fnd_${run}_1`,
        position: 1,
        title: "vLLM v0.34.0 ships",
        what_is_new: "A new scheduler.",
        why_it_matters: "Lower tail latency.",
        // Never public: stands in for extracted source text a later document might carry.
        content: "EXTRACTED SOURCE TEXT finding",
        items: [
          {
            source_id: "vllm-releases",
            item_key: "tag:github.com,2008:Repository/1/v0.34.0",
            title: "v0.34.0",
            url: "https://github.com/vllm-project/vllm/releases/tag/v0.34.0",
            content: "EXTRACTED SOURCE TEXT item",
          },
          {
            source_id: "vllm-blog",
            item_key: "https://blog.vllm.ai/tpu-v7",
            title: "RL on TPU v7",
            url: "https://blog.vllm.ai/tpu-v7",
          },
        ],
      },
    ],
    implications: "Serving cost keeps falling.",
    worth_watching: ["Scheduler benchmarks"],
  };
}

type Doc = ReturnType<typeof document>;

interface Seed {
  run: string;
  status?: string;
  public?: 0 | 1;
  /** False leaves the R2 document out. */
  withDocument?: boolean;
  /** Changes the document before it is stored. */
  edit?: (doc: ReturnType<typeof document>) => unknown;
}

async function seed(s: Seed): Promise<void> {
  const key = `reports/rpt_${s.run}.json`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runs (id, topic_id, kind, status, started_at, ended_at, duration_ms)
       VALUES (?, 'ai-infra', 'manual', ?, '2026-11-16T12:00:04.000Z', '2026-11-16T12:01:31.000Z', 87000)`,
    ).bind(s.run, s.status ?? "completed_with_report"),
    env.DB.prepare(
      `INSERT INTO run_steps (run_id, step, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, 'synthesis', 'claude-haiku-5-5', 2000, 1120, 500, 149, 0.0008249)`,
    ).bind(s.run),
    env.DB.prepare(
      `INSERT INTO reports (id, run_id, topic_id, published_at, public, r2_key, summary, finding_count)
       VALUES (?, ?, 'ai-infra', '2026-11-16T12:01:31.000Z', ?, ?, 'Two serving releases this week.', 1)`,
    ).bind(`rpt_${s.run}`, s.run, s.public ?? 1, key),
  ]);
  if (s.withDocument !== false) {
    const doc = document(s.run);
    await env.ARTIFACTS.put(key, JSON.stringify(s.edit ? s.edit(doc) : doc));
    keys.push(key);
  }
}

describe("GET /api/reports/:id", () => {
  afterEach(async () => {
    await deleteRuns();
    await Promise.all(keys.splice(0).map((k) => env.ARTIFACTS.delete(k)));
  });

  it("returns every list field plus the four sections, per the contract", async () => {
    await seed({ run: "run-a" });
    const res = await getReport("rpt_run-a");
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    expect(res.body).toEqual({
      id: "rpt_run-a",
      topic: { id: "ai-infra", name: "AI infrastructure platforms" },
      run: {
        id: "run-a",
        started_at: "2026-11-16T12:00:04.000Z",
        ended_at: "2026-11-16T12:01:31.000Z",
        duration_ms: 87000,
      },
      tokens: [{ model: "claude-haiku-5-5", input: 2649, output: 1120 }],
      cost_usd: 0.0008249,
      finding_count: 1,
      summary: "Two serving releases this week.",
      sections: {
        summary: "Two serving releases this week.",
        key_developments: [
          {
            finding_id: "fnd_run-a_1",
            title: "vLLM v0.34.0 ships",
            what_is_new: "A new scheduler.",
            why_it_matters: "Lower tail latency.",
            sources: [
              {
                title: "v0.34.0",
                url: "https://github.com/vllm-project/vllm/releases/tag/v0.34.0",
              },
              { title: "RL on TPU v7", url: "https://blog.vllm.ai/tpu-v7" },
            ],
          },
        ],
        implications: "Serving cost keeps falling.",
        worth_watching: ["Scheduler benchmarks"],
      },
      // The seeded document predates attributions, like Reports published before JSU-46.
      attributions: [],
    });
  });

  it("returns the attributions publish stored, such as the arXiv line", async () => {
    const line = "Thank you to arXiv for use of its open access interoperability.";
    await seed({ run: "run-arxiv", edit: (d) => ({ ...d, attributions: [line] }) });
    const res = await getReport("rpt_run-arxiv");
    expect(res.status).toBe(200);
    expect(res.body.attributions).toEqual([line]);
  });

  it("returns an empty attributions list when the document stores none", async () => {
    await seed({ run: "run-none", edit: (d) => ({ ...d, attributions: [] }) });
    const res = await getReport("rpt_run-none");
    expect(res.status).toBe(200);
    expect(res.body.attributions).toEqual([]);
  });

  it("passes on only contract fields, never extra document fields such as source text", async () => {
    await seed({ run: "run-extra" });
    const res = await getReport("rpt_run-extra");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("EXTRACTED SOURCE TEXT");
  });

  it("returns 404 not_found for an unknown ID", async () => {
    const res = await getReport("nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 404 for a Report that is not public", async () => {
    await seed({ run: "run-private", public: 0 });
    const res = await getReport("rpt_run-private");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 404 for a Report whose Run did not end completed_with_report", async () => {
    await seed({ run: "run-failed", status: "failed" });
    const res = await getReport("rpt_run-failed");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 404 for a malformed escape and for a nested path", async () => {
    expect((await getReport("%E0%A4%A")).status).toBe(404);
    await seed({ run: "run-nested" });
    expect((await getReport("rpt_run-nested/extra")).status).toBe(404);
  });

  it("decodes the ID from the path", async () => {
    await seed({ run: "run:colon" });
    const res = await getReport(encodeURIComponent("rpt_run:colon"));
    expect(res.status).toBe(200);
  });

  it("returns 500 internal when a listed Report has no document in R2", async () => {
    await seed({ run: "run-lost", withDocument: false });
    const res = await getReport("rpt_run-lost");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal" });
  });

  it.each([
    [
      "an object in worth_watching",
      (d: Doc) => ({ ...d, worth_watching: [{ content: "EXTRACTED SOURCE TEXT" }] }),
    ],
    [
      "an object as the summary",
      (d: Doc) => ({ ...d, summary: { content: "EXTRACTED SOURCE TEXT" } }),
    ],
    ["a missing implications", (d: Doc) => ({ ...d, implications: undefined })],
    [
      "a Finding title that is not a string",
      (d: Doc) => ({ ...d, findings: [{ ...d.findings[0], title: ["EXTRACTED SOURCE TEXT"] }] }),
    ],
    [
      "a Finding with no sources",
      (d: Doc) => ({ ...d, findings: [{ ...d.findings[0], items: [] }] }),
    ],
    [
      "a source URL that is not a string",
      (d: Doc) => ({
        ...d,
        findings: [
          { ...d.findings[0], items: [{ title: "t", url: { content: "EXTRACTED SOURCE TEXT" } }] },
        ],
      }),
    ],
    ["attributions that are null", (d: Doc) => ({ ...d, attributions: null })],
    [
      "attributions holding an object",
      (d: Doc) => ({ ...d, attributions: [{ content: "EXTRACTED SOURCE TEXT" }] }),
    ],
    [
      "findings that are not an array",
      (d: Doc) => ({ ...d, findings: { content: "EXTRACTED SOURCE TEXT" } }),
    ],
  ])("returns 500 internal, passing nothing on, for a document with %s", async (_, edit) => {
    await seed({ run: "run-bad", edit });
    const res = await getReport("rpt_run-bad");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal" });
  });

  it("returns 404 for non-GET methods", async () => {
    await seed({ run: "run-post" });
    const res = await exports.default.fetch(`${BASE}/api/reports/rpt_run-post`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
