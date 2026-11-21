import { describe, expect, it } from "vitest";
import { mapLimit } from "../../src/core/concurrency";

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mapLimit", () => {
  it("returns results in input order, whatever order the calls finish in", async () => {
    const delays = [30, 0, 10, 20];
    const results = await mapLimit(delays, 2, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${i}:${ms}`;
    });

    expect(results).toEqual(["0:30", "1:0", "2:10", "3:20"]);
  });

  it("keeps at most `limit` calls in flight and starts the next as soon as one finishes", async () => {
    const release: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const done = mapLimit([1, 2, 3, 4, 5], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
    });

    await settle();
    expect(release).toHaveLength(2);
    release[0]?.();
    await settle();
    expect(release).toHaveLength(3);
    for (const expected of [4, 5]) {
      release[release.length - 1]?.();
      await settle();
      expect(release).toHaveLength(expected);
    }
    for (const r of release) r();
    await done;
    expect(peak).toBe(2);
  });

  it("rejects with the first error and starts no further calls", async () => {
    const started: number[] = [];
    const result = mapLimit([0, 1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      await settle();
      if (n === 0) throw new Error("write failed");
    });

    await expect(result).rejects.toThrow("write failed");
    await settle();
    await settle();
    expect(started).toEqual([0, 1]);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapLimit([], 8, async (n: number) => n)).toEqual([]);
    expect(await mapLimit([1, 2], 8, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("rejects a limit that is not a positive integer", async () => {
    await expect(mapLimit([1], 0, async (n) => n)).rejects.toThrow("positive integer");
    await expect(mapLimit([1], 1.5, async (n) => n)).rejects.toThrow("positive integer");
  });
});
