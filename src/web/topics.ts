// Data and copy for the homepage Topic list. No DOM or React here, so it is unit-testable in Node.

import type { RunStatus, TopicLastChecked } from "../core/ports";

export type { TopicLastChecked };

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed_with_report: "Report published",
  completed_no_new_findings: "No new findings",
  failed: "Failed",
};

/** "2026-11-15 09:00 UTC" from an ISO timestamp. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The "last checked" line for one Topic. */
export function formatLastChecked(
  topic: Pick<TopicLastChecked, "last_checked_at" | "last_run_status">,
): string {
  if (topic.last_checked_at === null) return "Not yet checked";
  const when = `Last checked ${formatUtc(topic.last_checked_at)}`;
  const raw = topic.last_run_status;
  if (!raw) return when;
  // An unknown status from a newer API is shown as-is rather than hidden.
  const status = Object.hasOwn(STATUS_LABEL, raw) ? STATUS_LABEL[raw as RunStatus] : raw;
  return `${when}: ${status}`;
}

export async function fetchTopics(fetchFn: typeof fetch = fetch): Promise<TopicLastChecked[]> {
  const res = await fetchFn("/api/topics");
  if (!res.ok) throw new Error(`GET /api/topics returned ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body) || !body.every(isTopicRow)) {
    throw new Error("GET /api/topics returned an unexpected shape");
  }
  return body;
}

function isTopicRow(row: unknown): row is TopicLastChecked {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    (r.last_checked_at === null || typeof r.last_checked_at === "string") &&
    (r.last_run_status === null || typeof r.last_run_status === "string")
  );
}
