# Interfaces

Generated from `src/core/ports.ts` by `npm run docs:interfaces`. Do not edit by hand.

These are the boundaries between the pipeline core and its adapters (D1, R2, model calls, logging).

```ts
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

/** One row of `GET /api/reports`: a public Report with its Run's times, tokens and cost. */
export interface PublicReport {
  id: string;
  topic: { id: string; name: string };
  run: { id: string; started_at: string; ended_at: string; duration_ms: number };
  /**
   * One entry per model the Run used, ordered by model. `input` counts every prompt token:
   * uncached input, cache reads and cache writes.
   */
  tokens: { model: string; input: number; output: number }[];
  /** Sum of the Run's Step costs. */
  cost_usd: number;
  finding_count: number;
  summary: string;
}

/** One Key development as the public API shows it: no Item content, only links. */
export interface PublicFinding {
  finding_id: string;
  title: string;
  what_is_new: string;
  why_it_matters: string;
  /** One or more. URLs are the Items' original URLs. */
  sources: { title: string; url: string }[];
}

/** `GET /api/reports/:id`: every `GET /api/reports` field plus the Report's four sections. */
export interface PublicReportDetail extends PublicReport {
  sections: {
    summary: string;
    key_developments: PublicFinding[];
    implications: string;
    worth_watching: string[];
  };
  /** Credit lines the Report's Sources ask for, such as arXiv's. Empty when none. */
  attributions: string[];
}

/** A final status: the Run has ended. */
export type FinalStatus = Exclude<RunStatus, "queued" | "running">;

/** How a Run was started. A `replay` reruns another Run from a chosen stage. */
export type RunKind = "scheduled" | "manual" | "replay";

/** Pipeline stages, in order. Stored in `run_steps.step` and used in Step artifact keys. */
export type StepName = "fetch" | "dedupe" | "triage" | "synthesis" | "publish";

/** The stages a Replay can start from. Stored in `runs.from_stage`. */
export type ReplayStage = "triage" | "synthesis";

/** Identity of a Run. `id` is also its Workflow instance ID. */
export interface RunRef {
  id: string;
  topic_id: string;
  kind: RunKind;
  /** Extended ISO 8601 UTC, for example `2026-11-16T12:00:00Z`. Required for `scheduled`. */
  scheduled_slot: string | null;
  /** For a `replay`: the Run it reruns and the stage it starts from. */
  replay?: { source_run_id: string; from_stage: ReplayStage };
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

/** A `scheduled` or `manual` Run that is `queued` or `running`: one that blocks its Topic. */
export interface ActiveRun {
  id: string;
  topic_id: string;
  status: "queued" | "running";
  /** ISO 8601 UTC, second precision. */
  created_at: string;
}

/** The file format of a `feed` Source. Stored in `sources.format`. */
export type FeedFormat = "rss2" | "atom" | "hf_daily_papers";

/** One feed entry as the feed reports it, before its identity is normalized. */
export interface RawItem {
  /** RSS `guid`, Atom `id`, or the Hugging Face `paper.id`. Empty when the feed gives none. */
  externalId: string;
  url: string;
  title: string;
  summary?: string;
  content?: string;
  /** ISO 8601 UTC. The published time, else the updated time. Used for ordering only. */
  publishedAt?: string;
}

/** A Topic as Synthesis needs it. */
export interface Topic {
  id: string;
  name: string;
  research_goal: string;
}

/** A `feed` Source of a Topic. In T1 every feed reads a bundled fixture file. */
export interface Source {
  id: string;
  topic_id: string;
  format: FeedFormat;
  /** File name under `fixtures/feeds/`. Null when the Source has none, which fails its fetch. */
  fixture_ref: string | null;
}

/** Reads a Source's entries. T1 reads fixtures; T3 adds HTTP. Throws when the Source can't be read. */
export interface SourceFetcher {
  fetch(source: Source): Promise<RawItem[]>;
}

/**
 * One Source's Poll in a Run, as `fetch` records it. `dedupe` adds the counts later with
 * `recordPollCounts`.
 */
export interface Poll {
  source_id: string;
  outcome: "succeeded" | "failed";
  /** Requests made to read the Source. */
  attempts: number;
  /** Entries parsed from the feed; 0 when the Poll failed. */
  items_read: number;
  /** Why the Poll failed; null when it succeeded. */
  failure_reason: string | null;
  duration_ms: number;
}

/** What `dedupe` counted for a succeeded Poll of a Source. */
export interface SourcePollCounts {
  source_id: string;
  /** Items the Run recorded as first seen. */
  items_new: number;
  /** Items removed by the Source's filters. */
  items_filtered: number;
}

/** An Item as recorded in D1: one row per Source and normalized identity. */
export interface Item {
  source_id: string;
  /** Normalized identity, unique within the Source. */
  item_key: string;
  url: string;
  title: string;
  published_at: string | null;
  /** R2 key of the Item's content, written by the Run that recorded it. */
  content_key: string;
}

/** An Item a Finding cites, with what a reader needs to follow the link. */
export interface ReportItemLink {
  source_id: string;
  item_key: string;
  title: string;
  url: string;
}

/** One key development of a Report. Its ID is stable: `fnd_<run_id>_<position>`. */
export interface ReportFinding {
  id: string;
  /** 1-based order within the Report. */
  position: number;
  title: string;
  what_is_new: string;
  why_it_matters: string;
  items: ReportItemLink[];
}

/** The Report document stored in R2 as `reports/<id>.json`, with its Markdown beside it. */
export interface ReportDocument {
  /** `rpt_<run_id>`. */
  id: string;
  run_id: string;
  topic: { id: string; name: string };
  /** ISO 8601 UTC. */
  generated_at: string;
  /** The model that wrote it, as Anthropic reported it. */
  model: string;
  summary: string;
  findings: ReportFinding[];
  implications: string;
  worth_watching: string[];
  /** Credit lines set at publish. Absent in documents published before JSU-46: none. */
  attributions?: string[];
}

/** What each Run stores about the settings that produced it. */
export interface RunConfigRecord {
  /** The effective config as canonical JSON (object keys sorted). */
  config_snapshot: string;
  /** SHA-256 of `config_snapshot`. */
  config_hash: string;
  /** SHA-256 of each prompt file's text, by prompt name. */
  prompt_hashes: Record<string, string>;
}

/** The D1 row of a published Report. Findings are saved with it. */
export interface ReportRecord {
  id: string;
  run_id: string;
  topic_id: string;
  /** ISO 8601 UTC. */
  published_at: string;
  /** False for Replay Reports, which the public API never lists. */
  public: boolean;
  /** R2 key of the Report's JSON document. */
  r2_key: string;
  summary: string;
  finding_count: number;
}

/** Model usage and cost recorded for a stage that called a model. */
export interface StepUsage {
  model: string;
  usage: ModelUsage;
  cost_usd: number;
}

/** All D1 access goes through this interface. */
export interface RunStore {
  /** Every Topic, ordered by name, with its last-checked fields. */
  listTopicsLastChecked(): Promise<TopicLastChecked[]>;
  /**
   * Public Reports whose Run ended `completed_with_report`, newest first, at most `limit`.
   * A Run that failed after publishing keeps its Report row, but it is never listed.
   */
  listPublicReports(limit: number): Promise<PublicReport[]>;
  /**
   * One Report under the same rule as `listPublicReports`, with the R2 key of its document,
   * or null when no listed Report has that ID.
   */
  getPublicReport(id: string): Promise<(PublicReport & { r2_key: string }) | null>;
  /** Every Topic with its schedule and whether it has an active Run, ordered by ID. */
  dueTopicsInput(): Promise<TopicSchedule[]>;
  /** Every `scheduled` or `manual` Run that is `queued` or `running`, ordered by ID. */
  activeRuns(): Promise<ActiveRun[]>;
  /**
   * Inserts the Run as `queued`. Returns false, inserting nothing, when a Run with that ID
   * already exists, the Run's scheduled slot already has a Run, or (for a scheduled or manual
   * Run) the Topic already has an active scheduled or manual Run. D1 indexes enforce all three.
   */
  createQueuedRun(run: RunRef): Promise<boolean>;
  /**
   * Sets the Run `running`, inserting it first when it does not exist (manual Runs). Never
   * changes a final status. Returns `topic_busy`, changing nothing, when inserting it would
   * give the Topic a second active scheduled or manual Run, and `ended`, changing nothing, when
   * the Run already has a final status (for example, failed as stuck before its instance began).
   */
  markRunning(run: RunRef, at: Date): Promise<"running" | "topic_busy" | "ended">;
  /**
   * Stores the Run's config snapshot, config hash and prompt hashes. Called when the Run starts
   * running, so a Run that ran no stage (rejected at `start`, failed at `schedule`) has none.
   */
  recordRunConfig(runId: string, record: RunConfigRecord): Promise<void>;
  /** Ends a `running` Run with a final status, its end time and duration. */
  completeRun(runId: string, status: FinalStatus, at: Date): Promise<void>;
  /**
   * Ends a `queued` or `running` Run as `failed`, recording the failing stage and reason. Given a
   * RunRef, it inserts the Run as `failed` when it has no row yet (a manual Run whose start failed).
   * Given only an ID, it updates an existing Run. Never changes a final status.
   */
  failRun(run: RunRef | string, stage: string, reason: string, at: Date): Promise<void>;
  /**
   * Ends the Run as `failed` only while its status is still `from`, the status it was read in.
   * Returns whether it changed the Run.
   */
  failStuckRun(
    runId: string,
    from: ActiveRun["status"],
    stage: string,
    reason: string,
    at: Date,
  ): Promise<boolean>;
  getRun(runId: string): Promise<Run | null>;
  getTopic(topicId: string): Promise<Topic | null>;
  /** The Topic's `feed` Sources, ordered by ID. */
  listFeedSources(topicId: string): Promise<Source[]>;
  /**
   * The keys, of those given, that the Source has not seen. An Item is seen only when the Run
   * that recorded it ended `completed_with_report` or `completed_no_new_findings`.
   */
  unseenItemKeys(sourceId: string, keys: string[]): Promise<string[]>;
  /** True until a completed Run has recorded an Item of the Source. */
  isFirstPoll(sourceId: string): Promise<boolean>;
  /**
   * Records the Items as first seen by the Run. An existing row is taken over only when the Run
   * that recorded it did not complete, so a failed Run's Items are recorded again by the next Run.
   */
  recordItems(runId: string, items: Item[]): Promise<void>;
  /**
   * Records the Run's Polls, one per Source, replacing every Poll recorded for the Run before, so
   * a retried `fetch` step leaves exactly its own results, counts cleared.
   */
  recordPolls(runId: string, polls: Poll[]): Promise<void>;
  /** Sets the counts `dedupe` made for the Run's Polls, all in one transaction. */
  recordPollCounts(runId: string, counts: SourcePollCounts[]): Promise<void>;
  /** Records the stage's Step artifact key in `run_steps`, keeping any usage already recorded. */
  recordStepArtifact(runId: string, step: StepName, artifactKey: string): Promise<void>;
  /** Records the stage's model, tokens and cost in `run_steps`, replacing an earlier attempt's. */
  recordStepUsage(runId: string, step: StepName, usage: StepUsage): Promise<void>;
  /**
   * Saves the Report row, its Findings and each Finding's links to Items, in one transaction.
   * Saving the same Report again replaces its Findings, so a retried publish is safe.
   */
  saveReport(report: ReportRecord, findings: ReportFinding[]): Promise<void>;
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
  /**
   * Writes an Item's content as Markdown and returns its key,
   * `items/<source_id>/<encodeURIComponent(item_key)>/<run_id>.md`.
   */
  putItemContent(
    sourceId: string,
    itemKey: string,
    runId: string,
    markdown: string,
  ): Promise<string>;
  /**
   * Writes a Source's parsed entries from one Run's `fetch` as JSON and returns its key,
   * `runs/<run_id>/raw/<encodeURIComponent(source_id)>.json`. Writing again replaces them.
   */
  putRawEntries(runId: string, sourceId: string, entries: RawItem[]): Promise<string>;
  /** The entries `putRawEntries` wrote at `key`, or null when the key has no object. */
  getRawEntries(key: string): Promise<RawItem[] | null>;
  /** An Item's content Markdown, or null when the key has no object. */
  getItemContent(contentKey: string): Promise<string | null>;
  /** Writes `reports/<id>.json` and `reports/<id>.md` and returns the JSON key. */
  putReport(reportId: string, doc: ReportDocument, markdown: string): Promise<string>;
  /** The Report document at `key`, or null when the key has no object. */
  getReport(key: string): Promise<ReportDocument | null>;
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
 * Where a Run's Workflow instance stands. `ended` covers errored, terminated and complete
 * instances, with the platform's status and error text; anything still able to make progress,
 * or in an unrecognized status, is `active`.
 */
export type InstanceState =
  | { state: "active" }
  | { state: "ended"; status: string; error: string | null }
  | { state: "missing" };

/**
 * Starts and inspects the Workflow instance for a Run, using the Run ID as the instance ID.
 * `start` resolves `already_started` when an instance with that ID exists; throws on any other
 * failure. `instanceState` throws on any failure other than a missing instance.
 */
export interface WorkflowStarter {
  start(run: RunRef): Promise<"started" | "already_started">;
  instanceState(runId: string): Promise<InstanceState>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logging. Each call writes one JSON line with `level`, `msg` and the fields. */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** A pipeline stage that calls a model. Each maps to a model in the config's task table. */
export type TaskName = "triage" | "synthesis";

/** Effort levels accepted by current Claude models. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Token counts reported by Anthropic for one call. Cache writes are split by cache duration. */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_write_5m_input_tokens: number;
  cache_write_1h_input_tokens: number;
}

/** Attribution sent with every model call. Searchable in the AI Gateway logs. */
export interface ModelCallMetadata {
  run_id: string;
  topic_id: string;
  step: StepName;
  env: "dev" | "prod";
}

export interface ModelRequest {
  task: TaskName;
  model: string;
  system: string;
  prompt: string;
  effort: Effort;
  max_tokens: number;
  /** When present, the response is constrained to this JSON schema (structured output). */
  json_schema?: Record<string, unknown>;
  metadata: ModelCallMetadata;
}

export interface ModelResponse {
  /** The response text. With a JSON schema, this is the JSON document. */
  text: string;
  /** The parsed JSON when a schema was requested and the text parses; otherwise undefined. */
  json?: unknown;
  /** The model that served the call, as Anthropic reports it. */
  model: string;
  usage: ModelUsage;
}

/**
 * Calls a Claude model. Throws when the call fails or yields no usable answer (a refusal, or
 * output cut off at `max_tokens`). Cost is computed by the core from `usage`, not here.
 */
export interface ModelClient {
  call(req: ModelRequest): Promise<ModelResponse>;
}

/** The current time, injected so tests can control it. */
export interface Clock {
  now(): Date;
}
```
