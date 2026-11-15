import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const BASE = "https://lackey.test";

async function getJson(path: string) {
  const res = await exports.default.fetch(`${BASE}${path}`);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() };
}

async function insertRun(id: string, kind: string, status: string, createdAt: string) {
  await env.DB.prepare(
    "INSERT INTO runs (id, topic_id, kind, status, created_at) VALUES (?, 'ai-infra', ?, ?, ?)",
  )
    .bind(id, kind, status, createdAt)
    .run();
}

describe("GET /api/topics", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM runs").run();
  });

  it("lists the seeded Topic as not yet checked", async () => {
    const res = await getJson("/api/topics");
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    expect(res.body).toEqual([
      {
        id: "ai-infra",
        name: "AI infrastructure platforms",
        last_checked_at: null,
        last_run_status: null,
      },
    ]);
  });

  it("reports the latest non-Replay Run and ignores newer Replays", async () => {
    await insertRun("run-old", "scheduled", "failed", "2026-11-14T12:00:00Z");
    await insertRun("run-new", "manual", "completed_no_new_findings", "2026-11-15T09:00:00Z");
    await insertRun("run-replay", "replay", "running", "2026-11-15T10:00:00Z");
    const res = await getJson("/api/topics");
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "ai-infra",
        last_checked_at: "2026-11-15T09:00:00Z",
        last_run_status: "completed_no_new_findings",
      }),
    ]);
  });
});

describe("unknown API routes", () => {
  it("returns 404 with error not_found", async () => {
    const res = await getJson("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 404 for non-GET methods on /api/topics", async () => {
    const res = await exports.default.fetch(`${BASE}/api/topics`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
