/** Longest failure reason recorded on a Run or a Poll, matching the pipeline's cap. */
export const MAX_FAILURE_REASON = 1000;

/** Longest Source ID shown in a Run's failure reason; longer IDs are cut. */
export const MAX_SOURCE_LABEL = 60;

/** Marks a reason cut short. */
const ELLIPSIS = "…";

/**
 * The Run's failure reason when every Poll failed: each Source and its reason, in order. Source
 * IDs are cut to `MAX_SOURCE_LABEL` and reasons to an equal share of what is left, so every Source
 * appears within `MAX_FAILURE_REASON` characters for up to 15 Sources whatever their IDs, and for
 * more when IDs are short.
 */
export function allFailedReason(
  failed: readonly { source_id: string; failure_reason: string }[],
): string {
  const prefix = `Every Source failed (${failed.length}): `;
  const separator = "; ";
  const labels = failed.map((f) => cut(f.source_id, MAX_SOURCE_LABEL));
  const fixed =
    prefix.length +
    separator.length * Math.max(0, failed.length - 1) +
    labels.reduce((n, label) => n + label.length + 2, 0);
  const share = Math.max(1, Math.floor((MAX_FAILURE_REASON - fixed) / Math.max(1, failed.length)));
  const parts = failed.map((f, i) => `${labels[i]}: ${cut(f.failure_reason, share)}`);
  return (prefix + parts.join(separator)).slice(0, MAX_FAILURE_REASON);
}

/** The text, cut to at most `max` characters with a trailing ellipsis when it is longer. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}
