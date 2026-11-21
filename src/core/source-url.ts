/** Stands for the previous UTC day, `YYYY-MM-DD`, in a Source URL. */
const DATE_PLACEHOLDER = "{date}";

/** The UTC day before `at`, as `YYYY-MM-DD`. */
export function previousUtcDay(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - 1));
  return day.toISOString().slice(0, 10);
}

/**
 * The URL to request for a Source in a Run that started at `runStartedAt`. `{date}` becomes the
 * previous UTC day, so a daily Run reads one complete day. Returns a reason instead when the
 * Source has no URL, a placeholder is left unresolved, or the result is not an http(s) URL.
 */
export function sourceRequestUrl(
  url: string | null,
  runStartedAt: Date,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof url !== "string" || url.trim() === "")
    return { ok: false, reason: "Source has no URL" };
  if (Number.isNaN(runStartedAt.getTime())) return { ok: false, reason: "Run start is not a date" };
  const resolved = url.trim().replaceAll(DATE_PLACEHOLDER, previousUtcDay(runStartedAt));
  const leftover = /\{[^{}]*\}/.exec(resolved);
  if (leftover)
    return {
      ok: false,
      reason: `Source URL has an unknown placeholder ${leftover[0].slice(0, 40)}`,
    };
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    return { ok: false, reason: "Source URL does not parse" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Source URL scheme ${parsed.protocol} is not http or https` };
  }
  return { ok: true, url: resolved };
}
