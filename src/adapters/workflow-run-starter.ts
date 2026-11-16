import type { RunRef, WorkflowStarter } from "../core/ports";
import type { RunParams } from "../core/run-ids";

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
}
