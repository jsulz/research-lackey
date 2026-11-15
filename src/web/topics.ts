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
  const status = topic.last_run_status ? STATUS_LABEL[topic.last_run_status] : null;
  return status ? `${when}: ${status}` : when;
}

export async function fetchTopics(fetchFn: typeof fetch = fetch): Promise<TopicLastChecked[]> {
  const res = await fetchFn("/api/topics");
  if (!res.ok) throw new Error(`GET /api/topics returned ${res.status}`);
  return (await res.json()) as TopicLastChecked[];
}
