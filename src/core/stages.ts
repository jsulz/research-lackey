import type { RunConfig } from "./config";
import { stageCost } from "./cost";
import { itemKey, itemMarkdown, newestFirst } from "./items";
import { allFailedReason, cut, MAX_FAILURE_REASON } from "./polls";
import type {
  ArtifactStore,
  Clock,
  FeedFormat,
  Item,
  ModelCallMetadata,
  ModelClient,
  ModelUsage,
  Poll,
  RawItem,
  ReportDocument,
  ReportFinding,
  ReportItemLink,
  RunStore,
  SourceFetcher,
  SourcePollCounts,
} from "./ports";
import {
  findingId,
  reportId,
  reportJsonSchema,
  reportMarkdown,
  type SynthesisReport,
  validateReport,
} from "./report";
import type { Stage } from "./run-pipeline";
import { selectForSynthesis, synthesisPrompt, synthesisText } from "./synthesis";
import {
  rankTopK,
  selectForTriage,
  triageJsonSchema,
  triagePrompt,
  triageText,
  validateScores,
} from "./triage";

export interface StageDeps {
  store: RunStore;
  artifacts: ArtifactStore;
  fetcher: SourceFetcher;
  config: RunConfig;
  model: ModelClient;
  /** Prompt file texts by name. */
  prompts: { triage: string; synthesis: string };
  /** Sent as `env` in model call metadata. */
  model_env: ModelCallMetadata["env"];
  clock: Clock;
}

/**
 * One Source's Poll, as the `fetch` stage passes it to `dedupe`. The entries stay in R2 under
 * `entries_key`, so the stage output stays small however large the feeds are. A failed Poll has
 * no entries (`entries_key` null) and is skipped.
 */
export interface FetchedSource {
  source_id: string;
  format: FeedFormat;
  outcome: Poll["outcome"];
  failure_reason: string | null;
  /** Entries parsed from the feed; 0 when the Poll failed. */
  items_read: number;
  /** R2 key of the parsed entries (`ArtifactStore.putRawEntries`); null when the Poll failed. */
  entries_key: string | null;
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

/** One Item as Triage scored it. */
export interface ScoredItem {
  ref: string;
  source_id: string;
  item_key: string;
  title: string;
  score: number;
  reason: string;
}

/**
 * What `triage` returns. `scored` holds every score, so a Replay from `synthesis` can reuse it;
 * `selected` is the top K, highest score first, which is what Synthesis reads.
 */
export interface TriageOutput {
  skipped?: string;
  /** New Items `dedupe` passed on. */
  new_items: number;
  /** Items scored: one per Item identity, at most `triage_limit`. */
  triaged: number;
  /** Distinct Items over the limit, recorded as seen but not scored. */
  not_triaged: number;
  scored: ScoredItem[];
  selected: PassedItem[];
  model: string | null;
  usage: ModelUsage | null;
  cost_usd: number;
}

/** An Item sent to Synthesis, as recorded in its Step artifact. */
export interface SynthesisItemRef extends ReportItemLink {
  ref: string;
}

/** What `synthesis` returns. `report` is null when there were no new Items to read. */
export interface SynthesisOutput {
  skipped?: string;
  topic: { id: string; name: string };
  items: SynthesisItemRef[];
  model: string | null;
  usage: ModelUsage | null;
  cost_usd: number;
  report: SynthesisReport | null;
}

/** What `publish` returns. */
export interface PublishOutput {
  published: boolean;
  report_id: string | null;
  finding_count: number;
}

/** The production stage list, in order. */
export function buildStages(deps: StageDeps): readonly Stage[] {
  /** Records the Source's unseen Items as first seen by the Run, and returns them. */
  async function recordNew(
    source: FetchedSource,
    entries: RawItem[],
    runId: string,
  ): Promise<PassedItem[]> {
    // One entry per identity; the first occurrence in feed order wins.
    const byKey = new Map<string, RawItem>();
    for (const raw of entries) {
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
      // Polls every feed Source of the Topic, writes each read Source's entries to R2, and records
      // each Poll. A Source that can't be read is skipped; the stage fails only when every Source
      // failed, naming each with its reason. The output holds only R2 keys and counts.
      run: async (input, { run, log }) => {
        const { topic_id } = input as { topic_id: string };
        const sources = await deps.store.listFeedSources(topic_id);
        const fetched: FetchedSource[] = [];
        const polls: Poll[] = [];
        for (const source of sources) {
          const started = deps.clock.now().getTime();
          let items: RawItem[] = [];
          let failure_reason: string | null = null;
          try {
            items = await deps.fetcher.fetch(source);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failure_reason = cut(message || "unknown error", MAX_FAILURE_REASON);
            log.warn("poll failed", {
              run_id: run.id,
              source_id: source.id,
              reason: failure_reason,
            });
          }
          const outcome = failure_reason === null ? "succeeded" : "failed";
          polls.push({
            source_id: source.id,
            outcome,
            // The fixture fetcher makes one attempt; the HTTP fetcher will report its retries.
            attempts: 1,
            items_read: items.length,
            failure_reason,
            duration_ms: Math.max(0, deps.clock.now().getTime() - started),
          });
          fetched.push({
            source_id: source.id,
            format: source.format,
            outcome,
            failure_reason,
            items_read: items.length,
            // Written again by a retried step, to the same key.
            entries_key:
              outcome === "succeeded"
                ? await deps.artifacts.putRawEntries(run.id, source.id, items)
                : null,
          });
        }
        await deps.store.recordPolls(run.id, polls);
        const failed = fetched.flatMap((f) =>
          f.failure_reason === null
            ? []
            : [{ source_id: f.source_id, failure_reason: f.failure_reason }],
        );
        if (sources.length > 0 && failed.length === sources.length) {
          throw new Error(allFailedReason(failed));
        }
        return { sources: fetched };
      },
    },
    {
      name: "dedupe",
      // Reads each read Source's entries from R2, records its unseen Items (content to R2, rows to
      // D1), sets its Poll counts, and passes the Items onward.
      // Safe to retry: R2 keys are per Run, and rows recorded by this unfinished Run are taken over.
      run: async (input, { run }): Promise<DedupeOutput> => {
        const { sources } = input as { sources: FetchedSource[] };
        const items: PassedItem[] = [];
        const counts: SourcePollCounts[] = [];
        let recorded = 0;
        for (const source of sources) {
          if (source.outcome === "failed" || source.entries_key === null) continue;
          const entries = await deps.artifacts.getRawEntries(source.entries_key);
          if (entries === null) throw new Error(`Raw entries missing: ${source.entries_key}`);
          const firstPoll = await deps.store.isFirstPoll(source.source_id);
          const fresh = await recordNew(source, entries, run.id);
          recorded += fresh.length;
          // No filters yet, so nothing is filtered.
          counts.push({ source_id: source.source_id, items_new: fresh.length, items_filtered: 0 });
          // A Source's first poll can hold its whole history: record it all, pass on the newest N.
          items.push(
            ...(firstPoll ? newestFirst(fresh).slice(0, deps.config.first_poll_cap) : fresh),
          );
        }
        // Written once, after every Source is recorded: a Poll shows counts only when dedupe finished.
        await deps.store.recordPollCounts(run.id, counts);
        return { recorded, passed: items.length, items };
      },
    },
    {
      name: "triage",
      // Scores up to `triage_limit` new Items for relevance to the Research goal and passes the
      // top K on. Invalid output, a refusal or a cut-off answer throws, so the step retries and
      // then fails the Run.
      run: async (input, { run }): Promise<TriageOutput> => {
        const { items } = input as DedupeOutput;
        const empty = { new_items: items.length, scored: [], selected: [], cost_usd: 0 };
        if (items.length === 0) {
          return {
            skipped: "no new Items",
            ...empty,
            triaged: 0,
            not_triaged: 0,
            model: null,
            usage: null,
          };
        }
        const topic = await deps.store.getTopic(run.topic_id);
        if (!topic) throw new Error(`Topic ${run.topic_id} not found`);

        const task = deps.config.tasks.triage;
        const price = deps.config.prices[task.model];
        // Checked before the call: a call whose cost can't be recorded isn't made.
        if (!price) throw new Error(`No price for model ${task.model} in the config price table`);

        const picked = selectForTriage(items, deps.config.triage_limit);
        const distinct = new Set(items.map((i) => i.item_key)).size;
        const entries = [];
        for (const [i, item] of picked.entries()) {
          // Content is read only for Items with no summary.
          const markdown =
            item.summary === null ? await deps.artifacts.getItemContent(item.content_key) : null;
          const text = triageText(item, markdown, {
            summary_cap: deps.config.item_text_cap,
            content_chars: deps.config.triage_content_chars,
          });
          entries.push({ ref: `I${i + 1}`, item, text });
        }
        const refs = entries.map((e) => e.ref);
        const response = await deps.model.call({
          task: "triage",
          model: task.model,
          system: deps.prompts.triage,
          prompt: triagePrompt(topic, entries),
          effort: task.effort,
          max_tokens: task.max_tokens,
          json_schema: triageJsonSchema(refs),
          metadata: { run_id: run.id, topic_id: run.topic_id, step: "triage", env: deps.model_env },
        });
        const checked = validateScores(response.json, refs);
        if (!checked.ok) throw new Error(`Triage output failed validation: ${checked.reason}`);

        const cost_usd = stageCost(response.usage, price);
        await deps.store.recordStepUsage(run.id, "triage", {
          model: response.model,
          usage: response.usage,
          cost_usd,
        });
        const scored = entries.map(({ ref, item }) => {
          const { score, reason } = checked.scores.get(ref) ?? { score: 0, reason: "" };
          return { ref, item, score, reason };
        });
        return {
          new_items: items.length,
          triaged: picked.length,
          not_triaged: distinct - picked.length,
          scored: scored.map(({ ref, item, score, reason }) => ({
            ref,
            source_id: item.source_id,
            item_key: item.item_key,
            title: item.title,
            score,
            reason,
          })),
          selected: rankTopK(scored, deps.config.synthesis_k).map((s) => s.item),
          model: response.model,
          usage: response.usage,
          cost_usd,
        };
      },
    },
    {
      name: "synthesis",
      // Sends Triage's top K to the Synthesis model and validates its Report. Invalid output, a
      // refusal or a cut-off answer throws, so the step retries and then fails the Run.
      run: async (input, { run }): Promise<SynthesisOutput> => {
        const { selected: items } = input as TriageOutput;
        const topic = await deps.store.getTopic(run.topic_id);
        if (!topic) throw new Error(`Topic ${run.topic_id} not found`);
        const topicRef = { id: topic.id, name: topic.name };
        if (items.length === 0) {
          return {
            skipped: "no new Items",
            topic: topicRef,
            items: [],
            model: null,
            usage: null,
            cost_usd: 0,
            report: null,
          };
        }

        const task = deps.config.tasks.synthesis;
        const price = deps.config.prices[task.model];
        // Checked before the call: a call whose cost can't be recorded isn't made.
        if (!price) throw new Error(`No price for model ${task.model} in the config price table`);

        const picked = selectForSynthesis(items, deps.config.synthesis_k);
        const withText = [];
        for (const p of picked) {
          const markdown =
            p.item.summary === null
              ? await deps.artifacts.getItemContent(p.item.content_key)
              : null;
          const text = synthesisText(p.item, markdown, {
            summary_cap: deps.config.item_text_cap,
            content_chars: deps.config.synthesis_content_chars,
          });
          withText.push({ ...p, text });
        }
        const refs = picked.map((p) => p.ref);
        const response = await deps.model.call({
          task: "synthesis",
          model: task.model,
          system: deps.prompts.synthesis,
          prompt: synthesisPrompt(topic, withText),
          effort: task.effort,
          max_tokens: task.max_tokens,
          json_schema: reportJsonSchema(refs),
          metadata: {
            run_id: run.id,
            topic_id: run.topic_id,
            step: "synthesis",
            env: deps.model_env,
          },
        });
        const checked = validateReport(response.json, refs);
        if (!checked.ok) {
          throw new Error(`Synthesis output failed Report validation: ${checked.reason}`);
        }

        const cost_usd = stageCost(response.usage, price);
        await deps.store.recordStepUsage(run.id, "synthesis", {
          model: response.model,
          usage: response.usage,
          cost_usd,
        });
        return {
          topic: topicRef,
          items: picked.map(({ ref, item }) => ({
            ref,
            source_id: item.source_id,
            item_key: item.item_key,
            title: item.title,
            url: item.url,
          })),
          model: response.model,
          usage: response.usage,
          cost_usd,
          report: checked.report,
        };
      },
    },
    {
      name: "publish",
      // Writes the Report to R2 and its Findings to D1. Zero Findings publishes nothing.
      // Safe to retry: the Report and Finding IDs derive from the Run ID.
      run: async (input, { run }): Promise<PublishOutput> => {
        const synthesis = input as SynthesisOutput;
        const report = synthesis.report;
        if (!report || report.key_developments.length === 0) {
          return { published: false, report_id: null, finding_count: 0 };
        }
        const id = reportId(run.id);
        const byRef = new Map(synthesis.items.map(({ ref, ...link }) => [ref, link]));
        const findings: ReportFinding[] = report.key_developments.map((f, i) => ({
          id: findingId(id, i + 1),
          position: i + 1,
          title: f.title,
          what_is_new: f.what_is_new,
          why_it_matters: f.why_it_matters,
          items: f.sources.map((ref) => {
            const link = byRef.get(ref);
            if (!link) throw new Error(`Finding ${i + 1} cites unknown Item ${ref}`);
            return link;
          }),
        }));
        const doc: ReportDocument = {
          id,
          run_id: run.id,
          topic: synthesis.topic,
          generated_at: deps.clock.now().toISOString(),
          model: synthesis.model ?? "",
          summary: report.summary,
          findings,
          implications: report.implications,
          worth_watching: report.worth_watching,
        };
        const r2Key = await deps.artifacts.putReport(id, doc, reportMarkdown(doc));
        await deps.store.saveReport(
          {
            id,
            run_id: run.id,
            topic_id: run.topic_id,
            published_at: doc.generated_at,
            public: run.kind !== "replay",
            r2_key: r2Key,
            summary: report.summary,
            finding_count: findings.length,
          },
          findings,
        );
        return { published: true, report_id: id, finding_count: findings.length };
      },
      outcome: (output) =>
        (output as PublishOutput).published ? "completed_with_report" : "completed_no_new_findings",
    },
  ];
}
