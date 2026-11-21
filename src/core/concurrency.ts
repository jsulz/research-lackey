/**
 * Calls `fn` on each item with at most `limit` calls in flight, and returns the results in input
 * order. It rejects with the first rejection. Once that rejection's handler has run, no further
 * call starts; calls already in flight run to completion on their own. A call that settles in the
 * same turn just before the rejection is handled may still start one more call, so callers must
 * tolerate calls that finish after the returned promise rejects. `dedupe`'s writes are per-Run
 * keys, so a retried step rewrites them.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
