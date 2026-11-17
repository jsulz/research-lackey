import type { RunConfig } from "./config";
import type { ReplayStage, RunRef } from "./ports";
import { isReplayStage, parseRunConfig } from "./replay.ts";

// Run IDs double as Workflow instance IDs, which allow only letters, digits, `-` and `_`,
// up to 100 characters. Times use ISO 8601 basic format (no `:` or `.`).

/** Longest Topic ID that keeps every Run ID within 100 characters. */
export const MAX_TOPIC_ID_LENGTH = 76;

const TOPIC_ID = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTopicId(id: string): boolean {
  return id.length <= MAX_TOPIC_ID_LENGTH && TOPIC_ID.test(id);
}

/** `20261116T010757Z` from a Date, to the second. */
function basicSeconds(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * The Run the cron creates for a Topic's slot. Its ID is `topic-<topic>-<slot>`, with the slot
 * in ISO 8601 basic format to the minute (`20261116T1200Z`). The stored `scheduled_slot` keeps
 * the extended form (`2026-11-16T12:00:00Z`), like every other time in D1.
 */
export function scheduledRun(topicId: string, slot: Date): RunRef {
  const extended = slot.toISOString().replace(/\.\d{3}Z$/, "Z");
  const basicMinutes = extended.replace(/[-:]/g, "").replace(/\d{2}Z$/, "Z");
  return {
    id: `topic-${topicId}-${basicMinutes}`,
    topic_id: topicId,
    kind: "scheduled",
    scheduled_slot: extended,
  };
}

/** ID of a Run started on demand by `npm run run:local`. */
export function manualRunId(topicId: string, now: Date): string {
  return `manual-${topicId}-${basicSeconds(now)}`;
}

/** ID of a Replay started by `npm run replay`, with the source Run's Topic. */
export function replayRunId(topicId: string, now: Date): string {
  return `replay-${topicId}-${basicSeconds(now)}`;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** True for a string that can be a Run ID (a Workflow instance ID). */
export function isValidRunId(id: string): boolean {
  return RUN_ID.test(id);
}

/** Parameters a scheduled or manual Run's Workflow instance is created with. */
export interface NewRunParams {
  topic_id: string;
  kind: "scheduled" | "manual";
  scheduled_slot: string | null;
}

/**
 * Parameters a Replay's Workflow instance is created with. Its Topic is the source Run's;
 * `config` is the full alternate config.
 */
export interface ReplayParams {
  kind: "replay";
  source_run_id: string;
  from_stage: ReplayStage;
  config: RunConfig;
}

/** Parameters a Run's Workflow instance is created with. The Run ID is the instance ID. */
export type RunParams = NewRunParams | ReplayParams;

/**
 * Validates Workflow parameters: into a RunRef for a scheduled or manual Run, into the Replay's
 * parameters for a Replay, or into the reason they are invalid.
 */
export function parseRunParams(
  runId: string,
  payload: unknown,
): { ok: true; run: RunRef } | { ok: true; replay: ReplayParams } | { ok: false; reason: string } {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  if (p.kind === "replay") return parseReplayParams(p);
  if (typeof p.topic_id !== "string" || !isValidTopicId(p.topic_id)) {
    return { ok: false, reason: `invalid topic_id: ${JSON.stringify(p.topic_id)}` };
  }
  if (p.kind !== "scheduled" && p.kind !== "manual") {
    return { ok: false, reason: `invalid kind: ${JSON.stringify(p.kind)}` };
  }
  const slot = p.scheduled_slot ?? null;
  if (slot !== null && typeof slot !== "string") {
    return { ok: false, reason: "invalid scheduled_slot" };
  }
  if (p.kind === "scheduled" && slot === null) {
    return { ok: false, reason: "a scheduled Run needs scheduled_slot" };
  }
  return {
    ok: true,
    run: { id: runId, topic_id: p.topic_id, kind: p.kind, scheduled_slot: slot },
  };
}

function parseReplayParams(
  p: Record<string, unknown>,
): { ok: true; replay: ReplayParams } | { ok: false; reason: string } {
  if (typeof p.source_run_id !== "string" || !isValidRunId(p.source_run_id)) {
    return { ok: false, reason: `invalid source_run_id: ${JSON.stringify(p.source_run_id)}` };
  }
  if (!isReplayStage(p.from_stage)) {
    return { ok: false, reason: `invalid from_stage: ${JSON.stringify(p.from_stage)}` };
  }
  const config = parseRunConfig(p.config);
  if (!config.ok) return { ok: false, reason: `invalid config: ${config.reason}` };
  return {
    ok: true,
    replay: {
      kind: "replay",
      source_run_id: p.source_run_id,
      from_stage: p.from_stage,
      config: config.config,
    },
  };
}
