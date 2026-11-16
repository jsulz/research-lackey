import type { Clock, Logger, RunStore, WorkflowStarter } from "./ports";
import { scheduledRun } from "./run-ids";
import { slotAt } from "./schedule";

export interface SchedulerDeps {
  /** The cron's scheduled time, never the wall clock, so a retried tick computes the same slots. */
  tick: Date;
  store: RunStore;
  starter: WorkflowStarter;
  clock: Clock;
  log: Logger;
}

/**
 * Starts one Run per due Topic. A Topic is due when it has no active Run and its most recent
 * slot has no Run. Each Topic is handled independently: one Topic's failure doesn't stop the rest.
 */
export async function runScheduler(deps: SchedulerDeps): Promise<void> {
  const { tick, store, starter, clock, log } = deps;
  for (const topic of await store.dueTopicsInput()) {
    if (topic.has_active_run) {
      log.info("topic skipped: active run", { topic_id: topic.topic_id });
      continue;
    }
    const run = scheduledRun(topic.topic_id, slotAt(topic.schedule, tick));
    try {
      if (!(await store.createQueuedRun(run))) {
        log.debug("topic skipped: slot has a run", { topic_id: topic.topic_id, run_id: run.id });
        continue;
      }
    } catch (err) {
      log.error("run not created", {
        topic_id: topic.topic_id,
        run_id: run.id,
        error: message(err),
      });
      continue;
    }
    try {
      const result = await starter.start(run);
      log.info(result === "started" ? "run started" : "run already started", { run_id: run.id });
    } catch (err) {
      // Without this the queued Run would block its Topic forever.
      const reason = message(err);
      log.error("run not started", { run_id: run.id, error: reason });
      await store.failRun(run.id, "schedule", reason, clock.now());
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
