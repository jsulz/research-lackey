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

/** All D1 access goes through this interface. */
export interface RunStore {
  /** Every Topic, ordered by name, with its last-checked fields. */
  listTopicsLastChecked(): Promise<TopicLastChecked[]>;
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
