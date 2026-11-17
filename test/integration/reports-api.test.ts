import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRuns } from "./cleanup";

const BASE = "https://lackey.test";

async function getReports() {
  const res = await exports.default.fetch(`${BASE}/api/reports`);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() };
}

interface Seed {
  run: string;
  status?: string;
  published_at: string;
  public?: 0 | 1;
  steps?: {
    step: string;
    model: string | null;
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    cost: number;
  }[];
}

/** A finished Run with its Steps and Report, as the pipeline leaves them. */
async function seed(s: Seed): Promise<void> {
  const started = new Date(new Date(s.published_at).getTime() - 87_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runs (id, topic_id, kind, status, started_at, ended_at, duration_ms)
       VALUES (?, 'ai-infra', 'manual', ?, ?, ?, 87000)`,
    ).bind(s.run, s.status ?? "completed_with_report", started, s.published_at),
    ...(s.steps ?? []).map((st) =>
      env.DB.prepare(
        `INSERT INTO run_steps (run_id, step, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        s.run,
        st.step,
        st.model,
        st.input,
        st.output,
        st.cache_read ?? 0,
        st.cache_write ?? 0,
        st.cost,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO reports (id, run_id, topic_id, published_at, public, r2_key, summary, finding_count)
       VALUES (?, ?, 'ai-infra', ?, ?, ?, ?, 2)`,
    ).bind(
      `rpt_${s.run}`,
      s.run,
      s.published_at,
      s.public ?? 1,
      `reports/rpt_${s.run}.json`,
      `Summary of ${s.run}`,
    ),
  ]);
}

describe("GET /api/reports", () => {
  afterEach(async () => {
    await deleteRuns();
  });

  it("returns an empty array when there are no Reports", async () => {
    const res = await getReports();
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    expect(res.body).toEqual([]);
  });

  it("returns each Report per the contract: Topic, Run times, tokens per model, total cost", async () => {
    await seed({
      run: "run-a",
      published_at: "2026-11-16T12:01:31.000Z",
      steps: [
        { step: "fetch", model: null, input: 0, output: 0, cost: 0 },
        {
          step: "synthesis",
          model: "claude-haiku-5-5",
          input: 2000,
          output: 1120,
          cache_read: 500,
          cache_write: 149,
          cost: 0.0008249,
        },
      ],
    });
    const res = await getReports();
    expect(res.body).toEqual([
      {
        id: "rpt_run-a",
        topic: { id: "ai-infra", name: "AI infrastructure platforms" },
        run: {
          id: "run-a",
          started_at: "2026-11-16T12:00:04.000Z",
          ended_at: "2026-11-16T12:01:31.000Z",
          duration_ms: 87000,
        },
        // input counts every prompt token: uncached input, cache reads and cache writes.
        tokens: [{ model: "claude-haiku-5-5", input: 2649, output: 1120 }],
        cost_usd: 0.0008249,
        finding_count: 2,
        summary: "Summary of run-a",
      },
    ]);
  });

  it("gives one tokens entry per model, ordered by model, and sums cost across Steps", async () => {
    await seed({
      run: "run-b",
      published_at: "2026-11-16T12:01:31.000Z",
      steps: [
        { step: "triage", model: "claude-haiku-5-5", input: 100, output: 10, cost: 0.001 },
        { step: "synthesis", model: "claude-sonnet-5-5", input: 200, output: 20, cost: 0.002 },
      ],
    });
    const [report] = (await getReports()).body as { tokens: unknown; cost_usd: number }[];
    expect(report?.tokens).toEqual([
      { model: "claude-haiku-5-5", input: 100, output: 10 },
      { model: "claude-sonnet-5-5", input: 200, output: 20 },
    ]);
    expect(report?.cost_usd).toBeCloseTo(0.003, 10);
  });

  it("excludes Reports that are not public and Reports whose Run did not end completed_with_report", async () => {
    await seed({ run: "run-public", published_at: "2026-11-16T12:00:00.000Z" });
    await seed({ run: "run-private", published_at: "2026-11-16T13:00:00.000Z", public: 0 });
    await seed({ run: "run-failed", published_at: "2026-11-16T14:00:00.000Z", status: "failed" });
    const ids = ((await getReports()).body as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["rpt_run-public"]);
  });

  it("lists the newest 20, newest first", async () => {
    for (let i = 0; i < 21; i++) {
      const hour = String(i).padStart(2, "0");
      await seed({ run: `run-${hour}`, published_at: `2026-11-16T${hour}:30:00.000Z` });
    }
    const ids = ((await getReports()).body as { id: string }[]).map((r) => r.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe("rpt_run-20");
    expect(ids[19]).toBe("rpt_run-01");
  });

  it("returns 404 for non-GET methods", async () => {
    const res = await exports.default.fetch(`${BASE}/api/reports`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
