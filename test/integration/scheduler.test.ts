import { createScheduledController, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import worker from "../../src/worker/index";
import { deleteRuns, deleteTestTopics } from "./cleanup";

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
    await deleteRuns();
    await deleteTestTopics();
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

  it("skips a Topic with a queued scheduled Run from an earlier slot", async () => {
    // Inserted just now, so it is inside the queued grace period and is not looked up.
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

describe("scheduled handler with stuck Runs", () => {
  afterEach(async () => {
    await deleteRuns();
  });

  async function row(id: string) {
    return env.DB.prepare(
      "SELECT status, failed_stage, failure_reason, ended_at FROM runs WHERE id = ?",
    )
      .bind(id)
      .first();
  }

  it("fails a running Run with no Workflow instance, then starts the slot's Run in the same tick", async () => {
    const stuck = "manual-ai-infra-20261123T110000Z";
    const slot = "topic-ai-infra-20261123T1200Z";
    await insertRun(stuck, "manual", "running");
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, slot);

    await tick("2026-11-23T12:00:00Z");
    await instance.waitForStatus("complete");

    expect(await store.getRun(stuck)).toMatchObject({
      status: "failed",
      failed_stage: "reconcile",
      failure_reason: "Workflow instance not found",
    });
    expect((await store.getRun(slot))?.status).toBe("completed_no_new_findings");
  });

  it("fails a queued Run older than the grace period whose Workflow instance was never created", async () => {
    // The Worker stopped between inserting the Run and calling `create()`. Age is measured on the
    // wall clock, so `created_at` is a fixed time in the past.
    const stuck = "topic-ai-infra-20261124T1200Z";
    await env.DB.prepare(
      `INSERT INTO runs (id, topic_id, kind, scheduled_slot, status, created_at)
       VALUES (?, 'ai-infra', 'scheduled', '2026-11-24T12:00:00Z', 'queued', '2026-01-01T00:00:00Z')`,
    )
      .bind(stuck)
      .run();

    await tick("2026-11-24T12:15:00Z");

    expect(await row(stuck)).toMatchObject({
      status: "failed",
      failed_stage: "reconcile",
      failure_reason: "Workflow instance not found",
    });
    // The slot already has a Run (the failed one), so the next Run waits for the next slot.
    expect(await runIds()).toEqual([stuck]);
  });

  it("fails a running Run whose Workflow instance completed without ending it", async () => {
    const id = "topic-ai-infra-20261125T1200Z";
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, id);
    await tick("2026-11-25T12:00:00Z");
    await instance.waitForStatus("complete");
    await env.DB.prepare(
      "UPDATE runs SET status = 'running', ended_at = NULL, duration_ms = NULL WHERE id = ?",
    )
      .bind(id)
      .run();

    await tick("2026-11-25T12:15:00Z");

    expect(await row(id)).toMatchObject({
      status: "failed",
      failed_stage: "reconcile",
      failure_reason: "Workflow instance ended complete without recording a final status",
    });
  });

  it("leaves a Run whose instance is still running, and fails it once the instance is terminated", async () => {
    const manual = "manual-ai-infra-20261126T110000Z";
    const slot = "topic-ai-infra-20261126T1200Z";
    await using held = await introspectWorkflowInstance(env.RUN_WORKFLOW, manual);
    // Every `fetch` attempt fails, so the instance sits in retry backoff (10 s, then 20 s).
    await held.modify(async (m) => {
      await m.mockStepError({ name: "fetch" }, new Error("held for the test"));
    });
    await env.RUN_WORKFLOW.create({
      id: manual,
      params: { topic_id: "ai-infra", kind: "manual", scheduled_slot: null },
    });
    await held.waitForStepResult({ name: "start" });

    await tick("2026-11-26T12:00:00Z");
    const status = (await (await env.RUN_WORKFLOW.get(manual)).status()).status;
    expect(["running", "waiting"]).toContain(status);
    expect(await row(manual)).toEqual({
      status: "running",
      failed_stage: null,
      failure_reason: null,
      ended_at: null,
    });
    expect(await runIds()).toEqual([manual]);

    // Terminated by hand: the instance never reaches its `fail` step.
    await (await env.RUN_WORKFLOW.get(manual)).terminate();
    await held.waitForStatus("terminated");
    await using next = await introspectWorkflowInstance(env.RUN_WORKFLOW, slot);
    await tick("2026-11-26T12:15:00Z");
    await next.waitForStatus("complete");

    expect(await row(manual)).toMatchObject({
      status: "failed",
      failed_stage: "reconcile",
      failure_reason: "Workflow instance ended terminated without recording a final status",
    });
    expect((await store.getRun(slot))?.status).toBe("completed_no_new_findings");
  });
});

describe("D1RunStore.activeRuns", () => {
  afterEach(async () => {
    await deleteRuns();
    await deleteTestTopics();
  });

  it("lists queued and running scheduled and manual Runs only, ordered by ID", async () => {
    // One active Run per Topic, so the queued Run belongs to a second Topic.
    await env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_interval_hours)
       VALUES ('other', 'Other', 'x', 'every_n_hours', 6)`,
    ).run();
    await insertRun("a-running-manual", "manual", "running");
    await insertRun("b-replay", "replay", "running");
    await insertRun("c-failed", "manual", "failed");
    await env.DB.prepare(
      `INSERT INTO runs (id, topic_id, kind, scheduled_slot, status, created_at)
       VALUES ('d-queued', 'other', 'scheduled', '2026-11-27T12:00:00Z', 'queued', '2026-11-27T12:00:01Z')`,
    ).run();

    expect(await store.activeRuns()).toEqual([
      {
        id: "a-running-manual",
        topic_id: "ai-infra",
        status: "running",
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      },
      { id: "d-queued", topic_id: "other", status: "queued", created_at: "2026-11-27T12:00:01Z" },
    ]);
  });
});

describe("D1RunStore.createQueuedRun", () => {
  afterEach(async () => {
    await deleteRuns();
  });

  it("inserts nothing and returns false when the Topic already has an active manual Run", async () => {
    // The scheduler's active-Run snapshot can be stale; the insert itself must re-check.
    await insertRun("manual-ai-infra-20261121T115959Z", "manual", "running");
    const created = await store.createQueuedRun({
      id: "topic-ai-infra-20261121T1200Z",
      topic_id: "ai-infra",
      kind: "scheduled",
      scheduled_slot: "2026-11-21T12:00:00Z",
    });
    expect(created).toBe(false);
    expect(await runIds()).toEqual(["manual-ai-infra-20261121T115959Z"]);
  });

  it("ignores an active replay Run", async () => {
    await insertRun("replay-ai-infra-2", "replay", "running");
    const created = await store.createQueuedRun({
      id: "topic-ai-infra-20261122T1200Z",
      topic_id: "ai-infra",
      kind: "scheduled",
      scheduled_slot: "2026-11-22T12:00:00Z",
    });
    expect(created).toBe(true);
  });
});
