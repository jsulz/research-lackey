import type { RunConfig } from "./config";
import { itemKey, itemMarkdown } from "./items";
import type { ArtifactStore, FeedFormat, Item, RawItem, RunStore, SourceFetcher } from "./ports";
import type { Stage } from "./run-pipeline";

export interface StageDeps {
  store: RunStore;
  artifacts: ArtifactStore;
  fetcher: SourceFetcher;
  config: RunConfig;
}

/** One Source's entries, as the `fetch` stage passes them to `dedupe`. */
export interface FetchedSource {
  source_id: string;
  format: FeedFormat;
  items: RawItem[];
}

/** A new Item passed on to the next stage. Content stays in R2 under `content_key`. */
export interface PassedItem {
  source_id: string;
  item_key: string;
  url: string;
  title: string;
  summary: string | null;
  published_at: string | null;
  content_key: string;
}

/** What `dedupe` returns: counts, and the new Items passed onward. */
export interface DedupeOutput {
  /** New Items recorded across all Sources. */
  recorded: number;
  /** Items passed onward: every new Item, except only the newest N on a Source's first poll. */
  passed: number;
  items: PassedItem[];
}

/** The production stage list, in order. */
export function buildStages(deps: StageDeps): readonly Stage[] {
  /** Records the Source's unseen Items as first seen by the Run, and returns them. */
  async function recordNew(source: FetchedSource, runId: string): Promise<PassedItem[]> {
    // One entry per identity; the first occurrence in feed order wins.
    const byKey = new Map<string, RawItem>();
    for (const raw of source.items) {
      const key = itemKey(source.format, raw);
      if (!byKey.has(key)) byKey.set(key, raw);
    }
    const unseen = new Set(await deps.store.unseenItemKeys(source.source_id, [...byKey.keys()]));
    const fresh: PassedItem[] = [];
    for (const [key, raw] of byKey) {
      if (!unseen.has(key)) continue;
      const contentKey = await deps.artifacts.putItemContent(
        source.source_id,
        key,
        runId,
        itemMarkdown(raw),
      );
      fresh.push({
        source_id: source.source_id,
        item_key: key,
        url: raw.url,
        title: raw.title,
        summary: raw.summary ?? null,
        published_at: raw.publishedAt ?? null,
        content_key: contentKey,
      });
    }
    const rows: Item[] = fresh.map(({ summary: _summary, ...row }) => row);
    await deps.store.recordItems(runId, rows);
    return fresh;
  }

  return [
    {
      name: "fetch",
      // Reads every feed Source of the Topic. Any unreadable Source fails the stage, with its ID.
      run: async (input) => {
        const { topic_id } = input as { topic_id: string };
        const sources = await deps.store.listFeedSources(topic_id);
        const fetched: FetchedSource[] = [];
        for (const source of sources) {
          try {
            fetched.push({
              source_id: source.id,
              format: source.format,
              items: await deps.fetcher.fetch(source),
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`Source ${source.id}: ${reason}`);
          }
        }
        return { sources: fetched };
      },
    },
    {
      name: "dedupe",
      // Records each Source's unseen Items (content to R2, rows to D1) and passes them onward.
      // Safe to retry: R2 keys are per Run, and rows recorded by this unfinished Run are taken over.
      run: async (input, { run }): Promise<DedupeOutput> => {
        const { sources } = input as { sources: FetchedSource[] };
        const items: PassedItem[] = [];
        let recorded = 0;
        for (const source of sources) {
          const fresh = await recordNew(source, run.id);
          recorded += fresh.length;
          items.push(...fresh);
        }
        return { recorded, passed: items.length, items };
      },
    },
  ];
}
