import type { ActiveRun, Clock, InstanceState, Logger, RunStore, WorkflowStarter } from "./ports";
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
 * A `queued` Run younger than this is left alone: another invocation may be between inserting
 * it and calling `create()`. A `running` Run is written by its own instance, so it has none.
 */
export const QUEUED_GRACE_MS = 5 * 60 * 1000;

/** The most of an instance's error text kept in a reconciled Run's reason. */
const INSTANCE_ERROR_CAP = 500;

/**
 * Fails each active Run whose Workflow instance has ended or does not exist, so it no longer
 * blocks its Topic (JSU-34), then starts one Run per due Topic. A Topic is due when it has no active Run and its most recent
 * slot has no Run. Each Topic is handled independently: one Topic's failure doesn't stop the rest.
 */
export async function runScheduler(deps: SchedulerDeps): Promise<void> {
  await reconcileStuckRuns(deps);
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
      try {
        await store.failRun(run.id, "schedule", reason, clock.now());
      } catch (failErr) {
        // The Run stays queued until a later tick reconciles it; the remaining Topics still get scheduled.
        log.error("run failure not recorded", { run_id: run.id, error: message(failErr) });
      }
    }
  }
}

/**
 * Marks `failed`, at stage `reconcile`, each active Run whose instance has ended without
 * recording a final status or does not exist. Each Run is independent, and no failure here
 * stops the tick from scheduling.
 */
async function reconcileStuckRuns(deps: SchedulerDeps): Promise<void> {
  const { store, starter, clock, log } = deps;
  let runs: ActiveRun[];
  try {
    runs = await store.activeRuns();
  } catch (err) {
    log.error("active runs not listed", { error: message(err) });
    return;
  }
  for (const run of runs) {
    if (
      run.status === "queued" &&
      clock.now().getTime() - Date.parse(run.created_at) < QUEUED_GRACE_MS
    ) {
      continue;
    }
    let state: InstanceState;
    try {
      state = await starter.instanceState(run.id);
    } catch (err) {
      log.error("instance lookup failed", { run_id: run.id, error: message(err) });
      continue;
    }
    const reason = stuckReason(state);
    if (reason === null) continue;
    try {
      // Only a `queued` or `running` Run changes, so one that ended meanwhile keeps its status.
      await store.failRun(run.id, "reconcile", reason, clock.now());
      log.warn("run reconciled", { run_id: run.id, topic_id: run.topic_id, reason });
    } catch (err) {
      log.error("run reconcile not recorded", { run_id: run.id, error: message(err) });
    }
  }
}

/** Why a Run with this instance state is stuck, or null when its instance is still active. */
function stuckReason(state: InstanceState): string | null {
  switch (state.state) {
    case "active":
      return null;
    case "missing":
      return "Workflow instance not found";
    case "ended": {
      const base = `Workflow instance ended ${state.status} without recording a final status`;
      return state.error ? `${base}: ${state.error.slice(0, INSTANCE_ERROR_CAP)}` : base;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
