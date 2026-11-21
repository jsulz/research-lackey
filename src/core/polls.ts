/** Longest failure reason recorded on a Run or a Poll, matching the pipeline's cap. */
export const MAX_FAILURE_REASON = 1000;

/** Marks a reason cut short. */
const ELLIPSIS = "…";

/**
 * The Run's failure reason when every Poll failed: each Source and its reason, in order. Reasons
 * longer than an equal share of the cap are cut, so every Source appears within
 * `MAX_FAILURE_REASON` characters.
 */
export function allFailedReason(
  failed: readonly { source_id: string; failure_reason: string }[],
): string {
  const prefix = `Every Source failed (${failed.length}): `;
  const separator = "; ";
  const fixed =
    prefix.length +
    separator.length * Math.max(0, failed.length - 1) +
    failed.reduce((n, f) => n + f.source_id.length + 2, 0);
  const share = Math.max(1, Math.floor((MAX_FAILURE_REASON - fixed) / Math.max(1, failed.length)));
  const parts = failed.map((f) => `${f.source_id}: ${cut(f.failure_reason, share)}`);
  return (prefix + parts.join(separator)).slice(0, MAX_FAILURE_REASON);
}

/** The text, cut to at most `max` characters with a trailing ellipsis when it is longer. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}
