import type { RunRef } from "./ports";

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

/** Parameters a Run's Workflow instance is created with. The Run ID is the instance ID. */
export interface RunParams {
  topic_id: string;
  kind: "scheduled" | "manual";
  scheduled_slot: string | null;
}

/** Validates Workflow parameters into a RunRef, or returns the reason they are invalid. */
export function parseRunParams(
  runId: string,
  payload: unknown,
): { ok: true; run: RunRef } | { ok: false; reason: string } {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
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
