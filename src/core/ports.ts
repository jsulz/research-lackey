// Interfaces between the pipeline core and its adapters.
// The core depends only on these. Adapters (D1, R2, Anthropic, logging) implement them.
// `npm run docs:interfaces` copies this file into docs/interfaces.md.

/** Status of a Run. A Run starts `queued` and ends in one of the three final statuses. */
export type RunStatus =
  | "queued"
  | "running"
  | "completed_with_report"
  | "completed_no_new_findings"
  | "failed";

/** One Topic with the time and status of its latest non-Replay Run. */
export interface TopicLastChecked {
  id: string;
  name: string;
  /** ISO 8601 creation time of the latest non-Replay Run, or null when there is none. */
  last_checked_at: string | null;
  last_run_status: RunStatus | null;
}

/** A final status: the Run has ended. */
export type FinalStatus = Exclude<RunStatus, "queued" | "running">;

/** How a Run was started. `replay` arrives with Replays. */
export type RunKind = "scheduled" | "manual" | "replay";

/** Pipeline stages, in order. Stored in `run_steps.step` and used in Step artifact keys. */
export type StepName = "fetch" | "dedupe" | "triage" | "synthesis" | "publish";

/** Identity of a Run. `id` is also its Workflow instance ID. */
export interface RunRef {
  id: string;
  topic_id: string;
  kind: RunKind;
  /** Extended ISO 8601 UTC, for example `2026-11-16T12:00:00Z`. Required for `scheduled`. */
  scheduled_slot: string | null;
}

/** A Topic's schedule preset. Times are `HH:MM` UTC; `weekday` is 0-6, Sunday to Saturday. */
export type Schedule =
  | { kind: "every_n_hours"; interval_hours: number }
  | { kind: "daily"; time_utc: string }
  | { kind: "weekly"; weekday: number; time_utc: string };

/** A Run as stored. Times are ISO 8601 UTC. */
export interface Run extends RunRef {
  status: RunStatus;
  /** The stage, or lifecycle step, that failed. Null unless `status` is `failed`. */
  failed_stage: string | null;
  failure_reason: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
}

/** What the scheduler needs to decide whether a Topic is due. */
export interface TopicSchedule {
  topic_id: string;
  schedule: Schedule;
  /** True when a `scheduled` or `manual` Run of the Topic is `queued` or `running`. Replay Runs don't count. */
  has_active_run: boolean;
}

/** All D1 access goes through this interface. */
export interface RunStore {
  /** Every Topic, ordered by name, with its last-checked fields. */
  listTopicsLastChecked(): Promise<TopicLastChecked[]>;
  /** Every Topic with its schedule and whether it has an active Run, ordered by ID. */
  dueTopicsInput(): Promise<TopicSchedule[]>;
  /**
   * Inserts the Run as `queued`. Returns false, inserting nothing, when a Run with that ID
   * already exists, the Run's scheduled slot already has a Run, or (except for a `replay`
   * Run) the Topic has an active Run. The check and the insert are one atomic statement.
   */
  createQueuedRun(run: RunRef): Promise<boolean>;
  /** Sets the Run `running`, inserting it first when it does not exist (manual Runs). Never changes a final status. */
  markRunning(run: RunRef, at: Date): Promise<void>;
  /** Ends a `running` Run with a final status, its end time and duration. */
  completeRun(runId: string, status: FinalStatus, at: Date): Promise<void>;
  /**
   * Ends a `queued` or `running` Run as `failed`, recording the failing stage and reason. Given a
   * RunRef, it inserts the Run as `failed` when it has no row yet (a manual Run whose start failed).
   * Given only an ID, it updates an existing Run. Never changes a final status.
   */
  failRun(run: RunRef | string, stage: string, reason: string, at: Date): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
}

/** The recorded input and output of one stage within a Run. */
export interface StepArtifact {
  input: unknown;
  output: unknown;
}

/** All R2 access goes through this interface. */
export interface ArtifactStore {
  /** Writes the Step artifact and returns its key, `runs/<run_id>/steps/<stage>.json`. */
  putStepArtifact(runId: string, step: StepName, data: StepArtifact): Promise<string>;
  getStepArtifact(runId: string, step: StepName): Promise<StepArtifact | null>;
}

/**
 * Runs one named unit of work durably. In a Workflow this is `step.do()`, which retries a
 * failing step and caches its result, so a step's result must be small and serializable.
 * Throws once the step's retries are exhausted.
 */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Starts the Workflow instance for a Run, using the Run ID as the instance ID. Resolves
 * `already_started` when an instance with that ID exists; throws on any other failure.
 */
export interface WorkflowStarter {
  start(run: RunRef): Promise<"started" | "already_started">;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logging. Each call writes one JSON line with `level`, `msg` and the fields. */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** The current time, injected so tests can control it. */
export interface Clock {
  now(): Date;
}
