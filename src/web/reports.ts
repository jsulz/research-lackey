// Data and copy for the homepage Report list. No DOM or React here, so it is unit-testable in Node.

import type { PublicReport } from "../core/ports";

export type { PublicReport };

/**
 * Dollars to 2 decimal places. A Run usually costs a fraction of a cent, so a non-zero cost
 * that would round to "$0.00" reads "< $0.01" instead.
 */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return "< $0.01";
  return `$${usd.toFixed(2)}`;
}

/** "4s", "1m 27s" or "1h 2m". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "claude-haiku-5-5: 2,649 in, 1,120 out", one entry per model. */
export function formatTokens(tokens: PublicReport["tokens"]): string {
  if (tokens.length === 0) return "No model calls";
  const n = (x: number) => x.toLocaleString("en-US");
  return tokens.map((t) => `${t.model}: ${n(t.input)} in, ${n(t.output)} out`).join("; ");
}

export async function fetchReports(fetchFn: typeof fetch = fetch): Promise<PublicReport[]> {
  const res = await fetchFn("/api/reports");
  if (!res.ok) throw new Error(`GET /api/reports returned ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body) || !body.every(isReportRow)) {
    throw new Error("GET /api/reports returned an unexpected shape");
  }
  return body;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** True when `row` has every `GET /api/reports` field with the right type. */
export function isReportRow(row: unknown): row is PublicReport {
  if (!isObject(row)) return false;
  const { topic, run, tokens } = row;
  return (
    typeof row.id === "string" &&
    isObject(topic) &&
    typeof topic.id === "string" &&
    typeof topic.name === "string" &&
    isObject(run) &&
    typeof run.id === "string" &&
    typeof run.started_at === "string" &&
    typeof run.ended_at === "string" &&
    typeof run.duration_ms === "number" &&
    Array.isArray(tokens) &&
    tokens.every(
      (t) =>
        isObject(t) &&
        typeof t.model === "string" &&
        typeof t.input === "number" &&
        typeof t.output === "number",
    ) &&
    typeof row.cost_usd === "number" &&
    typeof row.finding_count === "number" &&
    typeof row.summary === "string"
  );
}
