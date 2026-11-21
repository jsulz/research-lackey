import { describe, expect, it } from "vitest";
import { CONFIG } from "../../src/core/config";
import type {
  ArtifactStore,
  FeedRead,
  FeedRequest,
  Logger,
  ModelClient,
  Poll,
  RunRef,
  RunStore,
  SourcePollCounts,
} from "../../src/core/ports";
import { NO_FILTERS } from "../../src/core/source-filters";
import { buildStages, type DedupeOutput, type FetchedSource } from "../../src/core/stages";

const RUN: RunRef = { id: "manual-t-1", topic_id: "t", kind: "manual", scheduled_slot: null };
const LOG: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function source(id: string): FetchedSource {
  return {
    source_id: id,
    format: "rss2",
    outcome: "succeeded",
    failure_reason: null,
    items_read: 1,
    entries_key: `raw/${id}`,
  };
}

/** The dedupe stage over fakes: every Item is unseen, and content writes for `failFor` throw. */
function dedupeWith(failFor: string) {
  const counts: SourcePollCounts[][] = [];
  const store = {
    unseenItemKeys: async (_s: string, keys: string[]) => keys,
    isFirstPoll: async () => false,
    recordItems: async () => {},
    recordPollCounts: async (_run: string, c: SourcePollCounts[]) => {
      counts.push(c);
    },
  } as unknown as RunStore;
  const artifacts = {
    getRawEntries: async (key: string) => {
      const id = key.slice("raw/".length);
      return [{ externalId: `${id}-1`, url: `https://example.com/${id}`, title: id }];
    },
    putItemContent: async (sourceId: string) => {
      if (sourceId === failFor) throw new Error("R2 unavailable");
      return `items/${sourceId}`;
    },
  } as unknown as ArtifactStore;
  const stages = buildStages({
    store,
    artifacts,
    fetcher: { fetch: async () => ({ ok: true, items: [], attempts: 1 }) },
    config: CONFIG,
    model: {} as ModelClient,
    prompts: { triage: "", synthesis: "" },
    model_env: "dev",
    clock: { now: () => new Date(0) },
  });
  const dedupe = stages.find((s) => s.name === "dedupe");
  if (!dedupe) throw new Error("no dedupe stage");
  return {
    run: (sources: FetchedSource[]) => dedupe.run({ sources }, { run: RUN, log: LOG }),
    counts,
  };
}

describe("dedupe Poll counts", () => {
  it("records every read Source's counts once, together, at the end", async () => {
    const d = dedupeWith("none");
    await d.run([
      source("a"),
      { ...source("b"), outcome: "failed", failure_reason: "x", items_read: 0, entries_key: null },
      source("c"),
    ]);

    expect(d.counts).toEqual([
      [
        { source_id: "a", items_new: 1, items_filtered: 0 },
        { source_id: "c", items_new: 1, items_filtered: 0 },
      ],
    ]);
  });

  it("records no counts when the stage fails partway, so no Poll shows counts dedupe never finished", async () => {
    const d = dedupeWith("b");

    await expect(d.run([source("a"), source("b")])).rejects.toThrow("R2 unavailable");
    expect(d.counts).toEqual([]);
  });
});

describe("dedupe Item content writes", () => {
  it("writes Item content with at most the configured content_write_concurrency writes in flight, in feed order", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      externalId: `e${i}`,
      url: `https://example.com/${i}`,
      title: `Item ${i}`,
    }));
    let inFlight = 0;
    let peak = 0;
    const recorded: string[][] = [];
    const store = {
      unseenItemKeys: async (_s: string, keys: string[]) => keys,
      isFirstPoll: async () => false,
      recordItems: async (_run: string, rows: Array<{ item_key: string }>) => {
        recorded.push(rows.map((r) => r.item_key));
      },
      recordPollCounts: async () => {},
    } as unknown as RunStore;
    const artifacts = {
      getRawEntries: async () => entries,
      putItemContent: async (_s: string, key: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Later Items finish first, so results arriving out of order would show.
        await new Promise((resolve) => setTimeout(resolve, 20 - Number(key.slice(1))));
        inFlight--;
        return `items/${key}`;
      },
    } as unknown as ArtifactStore;
    const config = { ...CONFIG, content_write_concurrency: 3 };
    const stages = buildStages({
      store,
      artifacts,
      fetcher: { fetch: async () => ({ ok: true, items: [], attempts: 1 }) },
      config,
      model: {} as ModelClient,
      prompts: { triage: "", synthesis: "" },
      model_env: "dev",
      clock: { now: () => new Date(0) },
    });
    const dedupe = stages.find((s) => s.name === "dedupe");
    if (!dedupe) throw new Error("no dedupe stage");

    const out = (await dedupe.run(
      { sources: [{ ...source("a"), items_read: 20 }] },
      { run: RUN, log: LOG },
    )) as { items: Array<{ item_key: string; content_key: string }> };

    expect(peak).toBe(3);
    const keys = entries.map((e) => e.externalId);
    expect(recorded).toEqual([keys]);
    expect(out.items.map((i) => [i.item_key, i.content_key])).toEqual(
      keys.map((k) => [k, `items/${k}`]),
    );
  });

  it("starts with a cap of 8", () => {
    expect(CONFIG.content_write_concurrency).toBe(8);
  });
});

describe("dedupe reads each read Source's raw entries", () => {
  it("fails when a succeeded Source has no entries key, rather than skipping it", async () => {
    const d = dedupeWith("none");

    await expect(d.run([{ ...source("a"), entries_key: null }])).rejects.toThrow(
      "Source a succeeded but has no raw entries key",
    );
  });

  it("fails when the stored entries don't match the count fetch read", async () => {
    const d = dedupeWith("none");

    await expect(d.run([{ ...source("a"), items_read: 2 }])).rejects.toThrow(
      "Raw entries for Source a: expected 2, found 1",
    );
    expect(d.counts).toEqual([]);
  });
});

describe("fetch Polls and raw entries", () => {
  it("records every Poll before writing raw entries, so a failed write keeps the Polls", async () => {
    const recorded: unknown[] = [];
    const store = {
      listFeedSources: async () => [
        { id: "a", topic_id: "t", format: "rss2", url: "https://e.com/a", filters: NO_FILTERS },
        { id: "b", topic_id: "t", format: "rss2", url: "https://e.com/b", filters: NO_FILTERS },
      ],
      getRun: async () => ({ started_at: "2026-11-22T12:00:00Z" }),
      recordPolls: async (_run: string, polls: unknown[]) => {
        recorded.push(polls);
      },
    } as unknown as RunStore;
    const artifacts = {
      putRawEntries: async (_run: string, sourceId: string) => {
        if (sourceId === "b") throw new Error("R2 unavailable");
        return `raw/${sourceId}`;
      },
    } as unknown as ArtifactStore;
    const stages = buildStages({
      store,
      artifacts,
      fetcher: {
        fetch: async (r) => ({
          ok: true,
          items: [{ externalId: r.source_id, url: r.url, title: r.source_id }],
          attempts: 1,
        }),
      },
      config: CONFIG,
      model: {} as ModelClient,
      prompts: { triage: "", synthesis: "" },
      model_env: "dev",
      clock: { now: () => new Date(0) },
    });
    const fetch = stages.find((s) => s.name === "fetch");
    if (!fetch) throw new Error("no fetch stage");

    await expect(fetch.run({ topic_id: "t" }, { run: RUN, log: LOG })).rejects.toThrow(
      "R2 unavailable",
    );
    expect(recorded).toEqual([
      [
        expect.objectContaining({ source_id: "a", outcome: "succeeded", items_read: 1 }),
        expect.objectContaining({ source_id: "b", outcome: "succeeded", items_read: 1 }),
      ],
    ]);
  });
});

describe("dedupe Source filters", () => {
  // Ten releases, newest first; the odd ones are release candidates.
  const entries = Array.from({ length: 10 }, (_, i) => ({
    externalId: `e${i}`,
    url: `https://example.com/${i}`,
    title: i % 2 === 1 ? `v1.${9 - i}.0rc1` : `v1.${9 - i}.0`,
    publishedAt: `2026-11-${String(20 - i).padStart(2, "0")}T00:00:00Z`,
  }));

  function dedupeOver(firstPoll: boolean) {
    const counts: SourcePollCounts[][] = [];
    const recorded: string[][] = [];
    const store = {
      unseenItemKeys: async (_s: string, keys: string[]) => keys,
      isFirstPoll: async () => firstPoll,
      recordItems: async (_run: string, rows: Array<{ item_key: string }>) => {
        recorded.push(rows.map((r) => r.item_key));
      },
      recordPollCounts: async (_run: string, c: SourcePollCounts[]) => {
        counts.push(c);
      },
    } as unknown as RunStore;
    const artifacts = {
      getRawEntries: async () => entries,
      putItemContent: async (_s: string, key: string) => `items/${key}`,
    } as unknown as ArtifactStore;
    const stages = buildStages({
      store,
      artifacts,
      fetcher: { fetch: async () => ({ ok: true, items: [], attempts: 1 }) },
      config: { ...CONFIG, first_poll_cap: 3 },
      model: {} as ModelClient,
      prompts: { triage: "", synthesis: "" },
      model_env: "dev",
      clock: { now: () => new Date(0) },
    });
    const dedupe = stages.find((s) => s.name === "dedupe");
    if (!dedupe) throw new Error("no dedupe stage");
    return {
      run: async (fetched: FetchedSource) =>
        (await dedupe.run({ sources: [fetched] }, { run: RUN, log: LOG })) as DedupeOutput,
      counts,
      recorded,
    };
  }

  const rcFiltered: FetchedSource = {
    ...source("a"),
    items_read: 10,
    filters: { ...NO_FILTERS, exclude_title_pattern: "rc\\d" },
  };

  it("records every new Item, passes only those that pass, and counts the rest as filtered", async () => {
    const d = dedupeOver(false);
    const out = await d.run(rcFiltered);

    expect(d.recorded).toEqual([entries.map((e) => e.externalId)]);
    expect(out.recorded).toBe(10);
    expect(out.items.map((i) => i.title)).toEqual([
      "v1.9.0",
      "v1.7.0",
      "v1.5.0",
      "v1.3.0",
      "v1.1.0",
    ]);
    expect(out.passed).toBe(5);
    expect(d.counts).toEqual([[{ source_id: "a", items_new: 10, items_filtered: 5 }]]);
  });

  it("applies the first-poll cap to the Items that pass, not to every new Item", async () => {
    const d = dedupeOver(true);
    const out = await d.run(rcFiltered);

    expect(out.items.map((i) => i.title)).toEqual(["v1.9.0", "v1.7.0", "v1.5.0"]);
    expect(d.counts).toEqual([[{ source_id: "a", items_new: 10, items_filtered: 5 }]]);
  });

  it("passes every Item for a fetch output written before Sources had filters", async () => {
    const d = dedupeOver(false);
    const { filters: _filters, ...legacy } = rcFiltered;
    const out = await d.run(legacy);

    expect(out.passed).toBe(10);
    expect(d.counts).toEqual([[{ source_id: "a", items_new: 10, items_filtered: 0 }]]);
  });
});

describe("fetch requests each Source's URL", () => {
  const filters = NO_FILTERS;

  /** The fetch stage over fakes: a Run started at `startedAt`, and a fetcher answering per URL. */
  function fetchOver(
    sources: Array<{ id: string; url: unknown }>,
    read: (url: string) => FeedRead,
    startedAt: string | null = "2026-11-22T12:00:03Z",
  ) {
    const polls: Poll[][] = [];
    const requested: FeedRequest[] = [];
    const store = {
      listFeedSources: async () =>
        sources.map((s) => ({ ...s, topic_id: "t", format: "rss2", filters })),
      getRun: async () => ({ started_at: startedAt }),
      recordPolls: async (_run: string, p: Poll[]) => {
        polls.push(p);
      },
    } as unknown as RunStore;
    const artifacts = {
      putRawEntries: async (_run: string, sourceId: string) => `raw/${sourceId}`,
    } as unknown as ArtifactStore;
    const stages = buildStages({
      store,
      artifacts,
      fetcher: {
        fetch: async (r) => {
          requested.push(r);
          return read(r.url);
        },
      },
      config: CONFIG,
      model: {} as ModelClient,
      prompts: { triage: "", synthesis: "" },
      model_env: "dev",
      clock: { now: () => new Date("2030-01-01T00:00:00Z") },
    });
    const fetch = stages.find((s) => s.name === "fetch");
    if (!fetch) throw new Error("no fetch stage");
    return {
      run: async () =>
        (await fetch.run({ topic_id: "t" }, { run: RUN, log: LOG })) as {
          sources: FetchedSource[];
        },
      polls,
      requested,
    };
  }

  const one = (url: string): FeedRead => ({
    ok: true,
    items: [{ externalId: "1", url, title: "One" }],
    attempts: 1,
  });

  it("resolves {date} to the UTC day before the Run started, and records the URL it requested", async () => {
    const f = fetchOver([{ id: "hf", url: "https://hf.test/papers?date={date}" }], one);

    const out = await f.run();

    expect(f.requested).toEqual([
      { source_id: "hf", url: "https://hf.test/papers?date=2026-11-21", format: "rss2" },
    ]);
    expect(out.sources[0]).toMatchObject({
      outcome: "succeeded",
      url: "https://hf.test/papers?date=2026-11-21",
    });
  });

  it("records the attempts the fetcher made, for a read Source and a failed one", async () => {
    const f = fetchOver(
      [
        { id: "a", url: "https://e.com/a" },
        { id: "b", url: "https://e.com/b" },
      ],
      (url) =>
        url.endsWith("/a")
          ? { ...one(url), attempts: 2 }
          : { ok: false, reason: "HTTP 503 (3 attempts)", attempts: 3 },
    );

    await f.run();

    expect(f.polls[0]).toEqual([
      expect.objectContaining({ source_id: "a", outcome: "succeeded", attempts: 2 }),
      expect.objectContaining({
        source_id: "b",
        outcome: "failed",
        attempts: 3,
        failure_reason: "HTTP 503 (3 attempts)",
      }),
    ]);
  });

  it.each([
    ["no URL", null, "Source has no URL"],
    ["a URL stored as something other than text", 42, "Source has no URL"],
    [
      "an unknown placeholder",
      "https://e.com/?d={day}",
      "Source URL has an unknown placeholder {day}",
    ],
    [
      "a URL that is not http(s)",
      "file:///etc/hosts",
      "Source URL scheme file: is not http or https",
    ],
  ])(
    "fails the Poll of a Source with %s without a request, and reads the others",
    async (_n, url, reason) => {
      const f = fetchOver(
        [
          { id: "bad", url },
          { id: "good", url: "https://e.com/good" },
        ],
        one,
      );

      const out = await f.run();

      expect(f.requested.map((r) => r.source_id)).toEqual(["good"]);
      expect(f.polls[0]?.[0]).toMatchObject({
        source_id: "bad",
        outcome: "failed",
        attempts: 1,
        failure_reason: reason,
      });
      expect(out.sources[0]).toMatchObject({ source_id: "bad", url: null, entries_key: null });
      expect(out.sources[1]).toMatchObject({ source_id: "good", outcome: "succeeded" });
    },
  );

  it("fails only the {date} Source's Poll when the Run has no recorded start, rather than guessing the day", async () => {
    const f = fetchOver(
      [
        { id: "hf", url: "https://hf.test/papers?date={date}" },
        { id: "plain", url: "https://e.com/feed" },
      ],
      one,
      null,
    );

    await f.run();

    expect(f.requested.map((r) => r.source_id)).toEqual(["plain"]);
    expect(f.polls[0]?.map((p) => [p.source_id, p.outcome, p.failure_reason])).toEqual([
      ["hf", "failed", "Source URL needs {date}, and the Run has no start time"],
      ["plain", "succeeded", null],
    ]);
  });

  it("fails the Poll, not the Run, when the fetcher itself throws", async () => {
    const f = fetchOver(
      [
        { id: "a", url: "https://e.com/a" },
        { id: "b", url: "https://e.com/b" },
      ],
      (url) => {
        if (url.endsWith("/a")) throw new Error("boom");
        return one(url);
      },
    );

    await f.run();

    expect(f.polls[0]?.map((p) => [p.source_id, p.outcome, p.attempts, p.failure_reason])).toEqual([
      ["a", "failed", 1, "boom"],
      ["b", "succeeded", 1, null],
    ]);
  });
});
