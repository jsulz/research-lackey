/**
 * Calls `fn` on each item with at most `limit` calls in flight, and returns the results in input
 * order. On the first rejection it starts no further calls and rejects with that error; calls
 * already in flight run to completion on their own.
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
