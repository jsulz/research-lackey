import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const BASE = "https://lackey.test";

async function getJson(path: string) {
  const res = await exports.default.fetch(`${BASE}${path}`);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() };
}

async function insertRun(id: string, kind: string, status: string, createdAt: string) {
  const slot = kind === "scheduled" ? createdAt : null;
  await env.DB.prepare(
    "INSERT INTO runs (id, topic_id, kind, status, created_at, scheduled_slot) VALUES (?, 'ai-infra', ?, ?, ?, ?)",
  )
    .bind(id, kind, status, createdAt, slot)
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

describe("runs schema", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM runs").run();
  });

  it("rejects a scheduled Run without a slot", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO runs (id, topic_id, kind, status) VALUES ('no-slot', 'ai-infra', 'scheduled', 'queued')",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a second scheduled Run for the same Topic and slot", async () => {
    const insert = (id: string) =>
      env.DB.prepare(
        "INSERT INTO runs (id, topic_id, kind, status, scheduled_slot) VALUES (?, 'ai-infra', 'scheduled', 'queued', '2026-11-16T12:00:00Z')",
      )
        .bind(id)
        .run();
    await insert("first");
    await expect(insert("second")).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("rejects a Run without an id", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO runs (topic_id, kind, status) VALUES ('ai-infra', 'manual', 'queued')",
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("allows manual Runs without a slot", async () => {
    await env.DB.prepare(
      "INSERT INTO runs (id, topic_id, kind, status) VALUES ('m1', 'ai-infra', 'manual', 'queued'), ('m2', 'ai-infra', 'manual', 'queued')",
    ).run();
    const row = await env.DB.prepare("SELECT count(*) AS n FROM runs").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});
