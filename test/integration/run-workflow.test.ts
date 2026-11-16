import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import type { Run, RunRef } from "../../src/core/ports";
import { deleteRuns } from "./cleanup";

const store = new D1RunStore(env.DB);

function manualRun(id: string): RunRef {
  return { id, topic_id: "ai-infra", kind: "manual", scheduled_slot: null };
}

async function start(run: RunRef) {
  await env.RUN_WORKFLOW.create({
    id: run.id,
    params: { topic_id: run.topic_id, kind: "manual", scheduled_slot: null },
  });
}

async function getRun(id: string): Promise<Run> {
  const run = await store.getRun(id);
  if (!run) throw new Error(`Run ${id} not found`);
  return run;
}

describe("RunWorkflow", () => {
  afterEach(async () => {
    await deleteRuns();
  });

  it("moves a queued Run to running to completed_no_new_findings, with times and duration", async () => {
    const run = manualRun("wf-happy");
    await store.createQueuedRun(run);
    expect((await getRun(run.id)).status).toBe("queued");

    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, run.id);
    await start(run);
    await instance.waitForStatus("complete");

    const row = await getRun(run.id);
    expect(row).toMatchObject({
      status: "completed_no_new_findings",
      failed_stage: null,
      failure_reason: null,
    });
    expect(row.started_at).not.toBeNull();
    expect(row.ended_at).not.toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("writes each executed stage's input and output to R2, keyed by Run and stage", async () => {
    const run = manualRun("wf-artifact");
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, run.id);
    await start(run);
    await instance.waitForStatus("complete");

    const fetch = await env.ARTIFACTS.get(`runs/${run.id}/steps/fetch.json`);
    const fetched = (await fetch?.json()) as {
      input: unknown;
      output: { sources: { source_id: string; items: unknown[] }[] };
    };
    expect(fetched.input).toEqual({ topic_id: "ai-infra" });
    // The seeded Sources (migration 0004), ordered by ID, with their fixture entry counts.
    expect(fetched.output.sources.map((s) => [s.source_id, s.items.length])).toEqual([
      ["arxiv-serving", 50],
      ["hf-daily-papers", 34],
      ["modal-blog", 157],
      ["vllm-blog", 50],
      ["vllm-releases", 10],
    ]);

    const dedupe = await env.ARTIFACTS.get(`runs/${run.id}/steps/dedupe.json`);
    expect(dedupe).not.toBeNull();
    expect(((await dedupe?.json()) as { input: unknown } | undefined)?.input).toEqual(
      fetched.output,
    );
  });

  it("creates the Run as manual when the Workflow starts with no Run row", async () => {
    const run = manualRun("wf-manual");
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, run.id);
    await start(run);
    await instance.waitForStatus("complete");

    expect(await getRun(run.id)).toMatchObject({
      kind: "manual",
      topic_id: "ai-infra",
      status: "completed_no_new_findings",
    });
  });

  it("retries a stage that fails once, and the Run completes", async () => {
    const run = manualRun("wf-retry");
    await store.createQueuedRun(run);
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, run.id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "fetch" }, new Error("flaky source"), 1);
    });
    await start(run);
    await instance.waitForStatus("complete");

    expect((await getRun(run.id)).status).toBe("completed_no_new_findings");
  });

  it("records a manual Run as failed when its start step exhausts its retries", async () => {
    const run = manualRun("wf-start-fail");
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, run.id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "start" }, new Error("D1 unavailable"));
    });
    await start(run);
    await instance.waitForStatus("errored");

    const row = await getRun(run.id);
    expect(row).toMatchObject({ kind: "manual", status: "failed", failed_stage: "start" });
    expect(row.failure_reason).toContain("D1 unavailable");
  });

  it("ends a manual Run failed at start, running no stage, when its Topic has an active scheduled Run", async () => {
    const scheduled: RunRef = {
      id: "topic-ai-infra-20261116T1200Z",
      topic_id: "ai-infra",
      kind: "scheduled",
      scheduled_slot: "2026-11-16T12:00:00Z",
    };
    await store.createQueuedRun(scheduled);
    const run = manualRun("wf-busy");
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, run.id);
    await start(run);
    await instance.waitForStatus("complete");

    const row = await getRun(run.id);
    expect(row).toMatchObject({ kind: "manual", status: "failed", failed_stage: "start" });
    expect(row.failure_reason).toContain("active Run");
    expect(await env.ARTIFACTS.get(`runs/${run.id}/steps/fetch.json`)).toBeNull();
    expect((await getRun(scheduled.id)).status).toBe("queued");
  });

  it("ends the Run failed, with the stage and reason, when a stage exhausts its retries", async () => {
    const run = manualRun("wf-fail");
    await store.createQueuedRun(run);
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, run.id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "fetch" }, new Error("source unreachable"));
    });
    await start(run);
    await instance.waitForStatus("errored");

    const row = await getRun(run.id);
    expect(row).toMatchObject({ status: "failed", failed_stage: "fetch" });
    expect(row.failure_reason).toContain("source unreachable");
    expect(row.ended_at).not.toBeNull();
    expect(await env.ARTIFACTS.get(`runs/${run.id}/steps/fetch.json`)).toBeNull();
  });
});
