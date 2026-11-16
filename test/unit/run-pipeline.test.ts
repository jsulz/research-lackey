import { describe, expect, it } from "vitest";
import type {
  ArtifactStore,
  Clock,
  FinalStatus,
  Logger,
  RunRef,
  RunStore,
  StepArtifact,
  StepName,
  StepRunner,
} from "../../src/core/ports";
import { runPipeline, type Stage } from "../../src/core/run-pipeline";

const RUN: RunRef = {
  id: "manual-ai-infra-1",
  topic_id: "ai-infra",
  kind: "manual",
  scheduled_slot: null,
};

/** In-memory RunStore that records every status the Run passes through. */
class FakeRunStore implements Pick<RunStore, "markRunning" | "completeRun" | "failRun"> {
  statuses: string[] = ["queued"];
  failure: { stage: string; reason: string } | null = null;
  async markRunning(_run: RunRef): Promise<void> {
    this.statuses.push("running");
  }
  async completeRun(_id: string, status: FinalStatus): Promise<void> {
    this.statuses.push(status);
  }
  async failRun(_run: RunRef | string, stage: string, reason: string): Promise<void> {
    this.statuses.push("failed");
    this.failure = { stage, reason };
  }
}

class FakeArtifacts implements ArtifactStore {
  items = new Map<string, StepArtifact>();
  async putStepArtifact(runId: string, step: StepName, data: StepArtifact): Promise<string> {
    const key = `runs/${runId}/steps/${step}.json`;
    this.items.set(key, structuredClone(data));
    return key;
  }
  async getStepArtifact(runId: string, step: StepName): Promise<StepArtifact | null> {
    return this.items.get(`runs/${runId}/steps/${step}.json`) ?? null;
  }
}

/** A StepRunner that retries a failing step up to `retries` times, like `step.do()`. */
function retryingSteps(retries: number): StepRunner {
  return {
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (attempt >= retries) throw err;
        }
      }
    },
  };
}

const clock: Clock = { now: () => new Date("2026-11-16T12:00:00Z") };
const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function setup(stages: Stage[], retries = 2) {
  const store = new FakeRunStore();
  const artifacts = new FakeArtifacts();
  const run = () =>
    runPipeline({
      run: RUN,
      stages,
      store: store as unknown as RunStore,
      artifacts,
      step: retryingSteps(retries),
      clock,
      log,
    });
  return { store, artifacts, run };
}

describe("runPipeline", () => {
  it("moves the Run from queued to running to completed_no_new_findings", async () => {
    const { store, run } = setup([{ name: "fetch", run: async () => ({ items: [] }) }]);
    await expect(run()).resolves.toBe("completed_no_new_findings");
    expect(store.statuses).toEqual(["queued", "running", "completed_no_new_findings"]);
  });

  it("writes each stage's input and output as a Step artifact, feeding each output to the next stage", async () => {
    const { artifacts, run } = setup([
      { name: "fetch", run: async (input) => ({ seen: input, items: ["a"] }) },
      { name: "dedupe", run: async () => ({ items: [] }) },
    ]);
    await run();
    expect(artifacts.items.get("runs/manual-ai-infra-1/steps/fetch.json")).toEqual({
      input: { topic_id: "ai-infra" },
      output: { seen: { topic_id: "ai-infra" }, items: ["a"] },
    });
    expect(artifacts.items.get("runs/manual-ai-infra-1/steps/dedupe.json")).toEqual({
      input: { seen: { topic_id: "ai-infra" }, items: ["a"] },
      output: { items: [] },
    });
  });

  it("retries a stage that fails once, and the Run completes", async () => {
    let calls = 0;
    const { store, run } = setup([
      {
        name: "fetch",
        run: async () => {
          if (++calls === 1) throw new Error("flaky");
          return { items: [] };
        },
      },
    ]);
    await expect(run()).resolves.toBe("completed_no_new_findings");
    expect(calls).toBe(2);
    expect(store.statuses.at(-1)).toBe("completed_no_new_findings");
  });

  it("ends the Run failed with the stage and reason when the stage exhausts its retries", async () => {
    const { store, artifacts, run } = setup(
      [
        { name: "fetch", run: async () => ({ items: [] }) },
        {
          name: "dedupe",
          run: async () => {
            throw new Error("source unreachable");
          },
        },
      ],
      1,
    );
    await expect(run()).rejects.toThrow("source unreachable");
    expect(store.statuses).toEqual(["queued", "running", "failed"]);
    expect(store.failure).toEqual({ stage: "dedupe", reason: "source unreachable" });
    expect(artifacts.items.has("runs/manual-ai-infra-1/steps/dedupe.json")).toBe(false);
  });
});
