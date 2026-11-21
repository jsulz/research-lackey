// Data, routing and link rules for the public report page. No DOM or React here, so it is
// unit-testable in Node.

import type { PublicReportDetail } from "../core/ports";
import { isObject, isReportRow } from "./reports";

export type { PublicReportDetail };

/** Which page a path shows. A malformed `/reports/...` path is the report page with no ID. */
export type Route = { page: "home" } | { page: "report"; id: string | null };

export function route(pathname: string): Route {
  if (!pathname.startsWith("/reports/")) return { page: "home" };
  const segment = pathname.slice("/reports/".length);
  if (segment === "" || segment.includes("/")) return { page: "report", id: null };
  try {
    return { page: "report", id: decodeURIComponent(segment) };
  } catch {
    return { page: "report", id: null };
  }
}

export type ReportResult = { kind: "found"; report: PublicReportDetail } | { kind: "not_found" };

/** Loads one Report. 404 is `not_found`; any other failure throws, for the error state. */
export async function fetchReport(
  id: string,
  fetchFn: typeof fetch = fetch,
): Promise<ReportResult> {
  const res = await fetchFn(`/api/reports/${encodeURIComponent(id)}`);
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) throw new Error(`GET /api/reports/:id returned ${res.status}`);
  const body: unknown = await res.json();
  if (!isReportDetail(body)) throw new Error("GET /api/reports/:id returned an unexpected shape");
  return { kind: "found", report: body };
}

/** The URL when it is absolute http or https, else null: a source link never runs script. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const isString = (v: unknown): v is string => typeof v === "string";

function isReportDetail(body: unknown): body is PublicReportDetail {
  if (!isReportRow(body)) return false;
  const s: unknown = (body as unknown as Record<string, unknown>).sections;
  if (!isObject(s)) return false;
  const attributions: unknown = (body as unknown as Record<string, unknown>).attributions;
  if (!Array.isArray(attributions) || !attributions.every(isString)) return false;
  return (
    isString(s.summary) &&
    isString(s.implications) &&
    Array.isArray(s.worth_watching) &&
    s.worth_watching.every(isString) &&
    Array.isArray(s.key_developments) &&
    s.key_developments.every(
      (f) =>
        isObject(f) &&
        isString(f.finding_id) &&
        isString(f.title) &&
        isString(f.what_is_new) &&
        isString(f.why_it_matters) &&
        Array.isArray(f.sources) &&
        f.sources.every((src) => isObject(src) && isString(src.title) && isString(src.url)),
    )
  );
}
