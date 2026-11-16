import { describe, expect, it } from "vitest";
import type {
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
