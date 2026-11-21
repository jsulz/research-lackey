import { describe, expect, it } from "vitest";
import { WorkflowRunStarter } from "../../src/adapters/workflow-run-starter";
import type { RunParams } from "../../src/core/run-ids";

// No Workflow runs here. The test lives in the integration suite because the binding types are
// Worker globals.

/** A Workflow binding whose `get` answers from a table of statuses or errors. */
function binding(answer: InstanceStatus | Error, onStatus = false): Workflow<RunParams> {
  return {
    async get(id: string) {
      if (answer instanceof Error && !onStatus) throw answer;
      return {
        id,
        async status() {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
    },
  } as unknown as Workflow<RunParams>;
}

describe("WorkflowRunStarter.instanceState", () => {
  it.each([
    "queued",
    "running",
    "waiting",
    "paused",
    "waitingForPause",
    "rollingBack",
    "unknown",
  ] as const)("reads %s as active", async (status) => {
    const starter = new WorkflowRunStarter(binding({ status }));
    expect(await starter.instanceState("r")).toEqual({ state: "active" });
  });

  it.each(["errored", "terminated", "complete"] as const)("reads %s as ended", async (status) => {
    const starter = new WorkflowRunStarter(binding({ status }));
    expect(await starter.instanceState("r")).toEqual({ state: "ended", status, error: null });
  });

  it("keeps an ended instance's error message", async () => {
    const starter = new WorkflowRunStarter(
      binding({ status: "errored", error: { name: "Error", message: "boom" } }),
    );
    expect(await starter.instanceState("r")).toEqual({
      state: "ended",
      status: "errored",
      error: "boom",
    });
  });

  it("reads a not-found error from get or status as missing", async () => {
    // Local text: `instance.not_found`; the API wraps codes as `(instance.not_found) ...`.
    const notFound = new Error("instance.not_found");
    expect(await new WorkflowRunStarter(binding(notFound)).instanceState("r")).toEqual({
      state: "missing",
    });
    expect(await new WorkflowRunStarter(binding(notFound, true)).instanceState("r")).toEqual({
      state: "missing",
    });
  });

  it("rethrows any other error", async () => {
    const starter = new WorkflowRunStarter(binding(new Error("internal error")));
    await expect(starter.instanceState("r")).rejects.toThrow("internal error");
  });
});
