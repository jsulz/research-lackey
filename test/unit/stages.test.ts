import { describe, expect, it } from "vitest";
import { CONFIG } from "../../src/core/config";
import type {
  ArtifactStore,
  Logger,
  ModelClient,
  RunRef,
  RunStore,
  SourcePollCounts,
} from "../../src/core/ports";
import { buildStages, type FetchedSource } from "../../src/core/stages";

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
    fetcher: { fetch: async () => [] },
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
        { id: "a", topic_id: "t", format: "rss2", fixture_ref: "a" },
        { id: "b", topic_id: "t", format: "rss2", fixture_ref: "b" },
      ],
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
      fetcher: { fetch: async (s) => [{ externalId: s.id, url: "https://e.com", title: s.id }] },
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
