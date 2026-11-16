import { createScheduledController, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import worker from "../../src/worker/index";

// The seed Topic `ai-infra` runs daily at 12:00 UTC. Each test ticks a different day, so
// Workflow instance IDs never repeat within this file.

const store = new D1RunStore(env.DB);

async function tick(at: string) {
  const controller = createScheduledController({
    scheduledTime: new Date(at),
    cron: "*/15 * * * *",
  });
  await worker.scheduled(controller, env);
}

async function runIds(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM runs WHERE topic_id = 'ai-infra' ORDER BY id",
  ).all<{ id: string }>();
  return results.map((r) => r.id);
}

async function insertRun(id: string, kind: string, status: string) {
  await env.DB.prepare("INSERT INTO runs (id, topic_id, kind, status) VALUES (?, 'ai-infra', ?, ?)")
    .bind(id, kind, status)
    .run();
}

describe("scheduled handler", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM runs").run();
    await env.DB.prepare("DELETE FROM topics WHERE id != 'ai-infra'").run();
  });

  it("creates the slot's scheduled Run, and a repeated tick for the same slot creates no second Run", async () => {
    const id = "topic-ai-infra-20261116T1200Z";
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, id);

    await tick("2026-11-16T12:00:00Z");
    await instance.waitForStatus("complete");
    expect(await store.getRun(id)).toMatchObject({
      kind: "scheduled",
      scheduled_slot: "2026-11-16T12:00:00Z",
      status: "completed_no_new_findings",
    });

    await tick("2026-11-16T12:00:00Z");
    await tick("2026-11-16T12:15:00Z");
    expect(await runIds()).toEqual([id]);
  });

  it("skips a Topic with a running manual Run", async () => {
    await insertRun("manual-ai-infra-20261117T115000Z", "manual", "running");
    await tick("2026-11-17T12:00:00Z");
    expect(await runIds()).toEqual(["manual-ai-infra-20261117T115000Z"]);
  });

  it("skips a Topic with a queued scheduled Run from an earlier slot", async () => {
    await env.DB.prepare(
      `INSERT INTO runs (id, topic_id, kind, scheduled_slot, status)
       VALUES ('topic-ai-infra-20261117T1200Z', 'ai-infra', 'scheduled', '2026-11-17T12:00:00Z', 'queued')`,
    ).run();
    await tick("2026-11-18T12:00:00Z");
    expect(await runIds()).toEqual(["topic-ai-infra-20261117T1200Z"]);
  });

  it("does not let a running replay Run block the schedule", async () => {
    const id = "topic-ai-infra-20261119T1200Z";
    await insertRun("replay-ai-infra-1", "replay", "running");
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, id);
    await tick("2026-11-19T12:00:00Z");
    await instance.waitForStatus("complete");
    expect((await store.getRun(id))?.status).toBe("completed_no_new_findings");
  });

  it("ends the queued Run failed at stage schedule when its Workflow cannot start", async () => {
    // Accepted by the schema, but `.` is not allowed in a Workflow instance ID.
    await env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_interval_hours)
       VALUES ('bad.topic', 'Bad', 'x', 'every_n_hours', 6)`,
    ).run();
    const ok = "topic-ai-infra-20261120T1200Z";
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, ok);
    await tick("2026-11-20T12:00:00Z");
    await instance.waitForStatus("complete");

    const bad = await store.getRun("topic-bad.topic-20261120T1200Z");
    expect(bad).toMatchObject({ status: "failed", failed_stage: "schedule" });
    expect(bad?.failure_reason).toBeTruthy();
    expect((await store.getRun(ok))?.status).toBe("completed_no_new_findings");
  });
});
