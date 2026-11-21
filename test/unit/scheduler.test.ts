import { describe, expect, it } from "vitest";
import type {
  ActiveRun,
  InstanceState,
  Logger,
  RunRef,
  RunStore,
  TopicSchedule,
  WorkflowStarter,
} from "../../src/core/ports";
import { runScheduler } from "../../src/core/scheduler";

const DAILY_NOON = { kind: "daily", time_utc: "12:00" } as const;

function topic(id: string): TopicSchedule {
  return { topic_id: id, schedule: DAILY_NOON, has_active_run: false };
}

const clock = { now: () => new Date("2026-11-16T12:00:05Z") };

function logger() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, msg, fields });
    };
  const log: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return { log, lines };
}

describe("runScheduler", () => {
  it("keeps scheduling later Topics when recording an earlier Topic's start failure also fails", async () => {
    const store = {
      activeRuns: async () => [],
      dueTopicsInput: async () => [topic("a-broken"), topic("b-healthy")],
      createQueuedRun: async () => true,
      failRun: async () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as RunStore;
    const started: string[] = [];
    const starter: WorkflowStarter = {
      async start(run: RunRef) {
        if (run.topic_id === "a-broken") throw new Error("instance.invalid_id");
        started.push(run.id);
        return "started";
      },
      instanceState: async () => ({ state: "active" }),
    };
    const { log, lines } = logger();

    await expect(
      runScheduler({ tick: new Date("2026-11-16T12:00:00Z"), store, starter, clock, log }),
    ).resolves.toBeUndefined();

    expect(started).toEqual(["topic-b-healthy-20261116T1200Z"]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "run failure not recorded",
        fields: expect.objectContaining({ run_id: "topic-a-broken-20261116T1200Z" }),
      }),
    );
  });
});

const TICK = new Date("2026-11-16T12:00:00Z");

function active(id: string, status: ActiveRun["status"], created_at: string): ActiveRun {
  return { id, topic_id: "ai-infra", status, created_at };
}

/** A store with the given active Runs and no Topics, recording calls in order. */
function reconcileStore(runs: ActiveRun[], failStuckRun?: (id: string) => Promise<boolean>) {
  const calls: string[] = [];
  const failed: { id: string; from: string; stage: string; reason: string; at: Date }[] = [];
  const store = {
    activeRuns: async () => {
      calls.push("activeRuns");
      return runs;
    },
    dueTopicsInput: async () => {
      calls.push("dueTopicsInput");
      return [];
    },
    failStuckRun: async (id: string, from: string, stage: string, reason: string, at: Date) => {
      calls.push(`failStuckRun ${id}`);
      const changed = failStuckRun ? await failStuckRun(id) : true;
      if (changed) failed.push({ id, from, stage, reason, at });
      return changed;
    },
  } as unknown as RunStore;
  return { store, calls, failed };
}

function starterWith(states: Record<string, InstanceState | Error>) {
  const looked: string[] = [];
  const starter: WorkflowStarter = {
    start: async () => "started",
    async instanceState(runId: string) {
      looked.push(runId);
      const state = states[runId];
      if (state === undefined) throw new Error(`unexpected lookup ${runId}`);
      if (state instanceof Error) throw state;
      return state;
    },
  };
  return { starter, looked };
}

describe("runScheduler stuck Runs", () => {
  it("fails a running Run whose instance does not exist, at stage reconcile, before scheduling", async () => {
    const { store, calls, failed } = reconcileStore([
      active("manual-ai-infra-1", "running", "2026-11-16T11:59:59Z"),
    ]);
    const { starter } = starterWith({ "manual-ai-infra-1": { state: "missing" } });
    const { log, lines } = logger();

    await runScheduler({ tick: TICK, store, starter, clock, log });

    expect(failed).toEqual([
      {
        id: "manual-ai-infra-1",
        from: "running",
        stage: "reconcile",
        reason: "Workflow instance not found",
        at: clock.now(),
      },
    ]);
    expect(calls).toEqual(["activeRuns", "failStuckRun manual-ai-infra-1", "dueTopicsInput"]);
    expect(lines).toContainEqual({
      level: "warn",
      msg: "run reconciled",
      fields: {
        run_id: "manual-ai-infra-1",
        topic_id: "ai-infra",
        reason: "Workflow instance not found",
      },
    });
  });

  it("fails a Run whose instance ended, naming the status and the instance's error", async () => {
    const { store, failed } = reconcileStore([
      active("a", "running", "2026-11-16T10:00:00Z"),
      active("b", "running", "2026-11-16T10:00:00Z"),
      active("c", "queued", "2026-11-16T10:00:00Z"),
    ]);
    const { starter } = starterWith({
      a: { state: "ended", status: "terminated", error: null },
      b: { state: "ended", status: "errored", error: "x".repeat(600) },
      c: { state: "ended", status: "complete", error: null },
    });

    await runScheduler({ tick: TICK, store, starter, clock, log: logger().log });

    expect(failed.map((f) => [f.id, f.stage, f.reason])).toEqual([
      ["a", "reconcile", "Workflow instance ended terminated without recording a final status"],
      [
        "b",
        "reconcile",
        `Workflow instance ended errored without recording a final status: ${"x".repeat(500)}`,
      ],
      ["c", "reconcile", "Workflow instance ended complete without recording a final status"],
    ]);
  });

  it("leaves a Run whose instance is active", async () => {
    const { store, failed } = reconcileStore([active("a", "running", "2026-11-16T10:00:00Z")]);
    const { starter, looked } = starterWith({ a: { state: "active" } });

    await runScheduler({ tick: TICK, store, starter, clock, log: logger().log });

    expect(looked).toEqual(["a"]);
    expect(failed).toEqual([]);
  });

  it("leaves a queued Run younger than five minutes without looking it up", async () => {
    // Clock is 12:00:05; the Run could be between its insert and `create()` in another tick.
    const { store, failed } = reconcileStore([
      active("young", "queued", "2026-11-16T11:55:06Z"),
      active("old", "queued", "2026-11-16T11:55:05Z"),
      active("running", "running", "2026-11-16T12:00:05Z"),
    ]);
    const { starter, looked } = starterWith({
      old: { state: "missing" },
      running: { state: "missing" },
    });

    await runScheduler({ tick: TICK, store, starter, clock, log: logger().log });

    expect(looked).toEqual(["old", "running"]);
    expect(failed.map((f) => f.id)).toEqual(["old", "running"]);
  });

  it("fails a Run only from the status it was read in, and logs nothing when the row moved on", async () => {
    // Read queued with no instance; by the write the instance has started and set it running.
    const { store, failed } = reconcileStore(
      [active("moved", "queued", "2026-11-16T10:00:00Z")],
      async () => false,
    );
    const { starter } = starterWith({ moved: { state: "missing" } });
    const { log, lines } = logger();

    await runScheduler({ tick: TICK, store, starter, clock, log });

    expect(failed).toEqual([]);
    expect(lines.filter((l) => l.msg === "run reconciled")).toEqual([]);
    expect(lines).toContainEqual({
      level: "debug",
      msg: "run not reconciled: status changed",
      fields: { run_id: "moved", status: "queued" },
    });
  });

  it("logs a failed lookup or write and still reconciles the other Runs and schedules", async () => {
    const { store, calls, failed } = reconcileStore(
      [
        active("a-lookup", "running", "2026-11-16T10:00:00Z"),
        active("b-write", "running", "2026-11-16T10:00:00Z"),
        active("c-ok", "running", "2026-11-16T10:00:00Z"),
      ],
      async (id) => {
        if (id === "b-write") throw new Error("D1 unavailable");
        return true;
      },
    );
    const { starter } = starterWith({
      "a-lookup": new Error("network"),
      "b-write": { state: "missing" },
      "c-ok": { state: "missing" },
    });
    const { log, lines } = logger();

    await runScheduler({ tick: TICK, store, starter, clock, log });

    expect(failed.map((f) => f.id)).toEqual(["c-ok"]);
    expect(calls.at(-1)).toBe("dueTopicsInput");
    expect(lines).toContainEqual({
      level: "error",
      msg: "instance lookup failed",
      fields: { run_id: "a-lookup", error: "network" },
    });
    expect(lines).toContainEqual({
      level: "error",
      msg: "run reconcile not recorded",
      fields: { run_id: "b-write", error: "D1 unavailable" },
    });
  });

  it("still schedules when listing the active Runs fails", async () => {
    const store = {
      activeRuns: async () => {
        throw new Error("D1 unavailable");
      },
      dueTopicsInput: async () => [topic("ai-infra")],
      createQueuedRun: async () => true,
    } as unknown as RunStore;
    const started: string[] = [];
    const starter: WorkflowStarter = {
      async start(run: RunRef) {
        started.push(run.id);
        return "started";
      },
      instanceState: async () => ({ state: "active" }),
    };
    const { log, lines } = logger();

    await runScheduler({ tick: TICK, store, starter, clock, log });

    expect(started).toEqual(["topic-ai-infra-20261116T1200Z"]);
    expect(lines).toContainEqual({
      level: "error",
      msg: "active runs not listed",
      fields: { error: "D1 unavailable" },
    });
  });
});
