import type { InstanceState, RunRef, WorkflowStarter } from "../core/ports";
import type { RunParams } from "../core/run-ids";

/** Instance statuses after which the instance does no more work. */
const ENDED: ReadonlySet<string> = new Set(["errored", "terminated", "complete"]);

/** WorkflowStarter backed by the `research-run` Workflow binding. */
export class WorkflowRunStarter implements WorkflowStarter {
  constructor(private readonly workflow: Workflow<RunParams>) {}

  async start(run: RunRef): Promise<"started" | "already_started"> {
    if (run.kind === "replay") throw new Error("replay Runs are not started by the scheduler");
    const params: RunParams = {
      topic_id: run.topic_id,
      kind: run.kind,
      scheduled_slot: run.scheduled_slot,
    };
    try {
      await this.workflow.create({ id: run.id, params });
      return "started";
    } catch (err) {
      // Error text seen locally: `(instance.already_exists) Workflow instance with id "..." already exists`.
      if (err instanceof Error && /already[_ ]exists/.test(err.message)) return "already_started";
      throw err;
    }
  }

  async instanceState(runId: string): Promise<InstanceState> {
    let status: InstanceStatus;
    try {
      status = await (await this.workflow.get(runId)).status();
    } catch (err) {
      // Local text: `instance.not_found`. Any other failure is not evidence the instance is gone.
      if (err instanceof Error && /instance\.not_found/.test(err.message)) {
        return { state: "missing" };
      }
      throw err;
    }
    if (!ENDED.has(status.status)) return { state: "active" };
    return { state: "ended", status: status.status, error: status.error?.message ?? null };
  }
}
