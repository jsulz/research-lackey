import { capText, contentBody, inertItemTags, plainText } from "./item-text";
import { newestFirst } from "./items";
import type { PassedItem } from "./stages";

/** Feed-controlled titles are capped, as in Synthesis, so one entry can't inflate the prompt. */
const TITLE_CAP = 300;

export interface TriageTextLimits {
  /** Longest summary, in characters. */
  summary_cap: number;
  /** For an Item with no summary, how many characters of its content, as text. */
  content_chars: number;
}

/**
 * The text Triage reads for one Item: its title plus its summary, or, when it has no summary,
 * its title plus the first `content_chars` characters of its content as plain text.
 * `markdown` is the Item's R2 Markdown, needed only when there is no summary.
 */
export function triageText(
  item: { title: string; summary: string | null },
  markdown: string | null,
  limits: TriageTextLimits,
): string {
  const title = capText(item.title, TITLE_CAP);
  const body =
    item.summary !== null
      ? capText(item.summary, limits.summary_cap)
      : plainText(contentBody(markdown ?? "")).slice(0, limits.content_chars);
  return body === "" ? title : `${title}\n${body}`;
}

/**
 * The Items Triage scores: one copy per Item identity, then the newest `limit`. The same paper
 * can arrive from two Sources (arXiv and Daily Papers); the copy with a summary is kept, else the
 * first. Copies left out are still recorded as seen by `dedupe`.
 */
export function selectForTriage(items: readonly PassedItem[], limit: number): PassedItem[] {
  const byKey = new Map<string, PassedItem>();
  for (const item of items) {
    const kept = byKey.get(item.item_key);
    if (!kept || (kept.summary === null && item.summary !== null)) byKey.set(item.item_key, item);
  }
  return newestFirst([...byKey.values()]).slice(0, limit);
}

/**
 * Triage's structured output: one score per Item. Refs are limited to the Items sent. The score
 * range is checked in code (`validateScores`): structured outputs don't support numeric bounds.
 */
export function triageJsonSchema(refs: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string", enum: [...refs] },
            score: { type: "integer" },
            reason: { type: "string" },
          },
          required: ["ref", "score", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["scores"],
    additionalProperties: false,
  };
}

export interface TriageScore {
  score: number;
  reason: string;
}

export type ScoresResult =
  | { ok: true; scores: Map<string, TriageScore> }
  | { ok: false; reason: string };

/** Checks Triage output: exactly one entry per Item sent, each an integer score 0 to 10 with a reason. */
export function validateScores(value: unknown, refs: readonly string[]): ScoresResult {
  const fail = (reason: string): ScoresResult => ({ ok: false, reason });
  if (typeof value !== "object" || value === null) return fail("Triage output is not an object");
  const list = (value as { scores?: unknown }).scores;
  if (!Array.isArray(list)) return fail("Triage output has no scores list");
  const known = new Set(refs);
  const scores = new Map<string, TriageScore>();
  for (const [i, entry] of list.entries()) {
    const { ref, score, reason } = (entry ?? {}) as Record<string, unknown>;
    if (typeof ref !== "string" || !known.has(ref)) {
      return fail(`scores[${i}] has unknown ref ${String(ref)}`);
    }
    if (scores.has(ref)) return fail(`scores[${i}] repeats ref ${ref}`);
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10) {
      return fail(`scores[${i}] (${ref}) score must be an integer from 0 to 10`);
    }
    if (typeof reason !== "string") return fail(`scores[${i}] (${ref}) has no reason`);
    scores.set(ref, { score, reason });
  }
  const missing = refs.filter((ref) => !scores.has(ref));
  if (missing.length > 0) return fail(`Triage output has no score for ${missing.join(", ")}`);
  return { ok: true, scores };
}

/**
 * The top `k` scored Items: highest score first, ties broken by newest, then by input order.
 * Returns a new array.
 */
export function rankTopK<T extends { item: PassedItem; score: number }>(
  scored: readonly T[],
  k: number,
): T[] {
  const order = new Map(newestFirst(scored.map((s) => s.item)).map((item, i) => [item, i]));
  return [...scored]
    .sort((a, b) => b.score - a.score || (order.get(a.item) ?? 0) - (order.get(b.item) ?? 0))
    .slice(0, k);
}

/**
 * The user message for Triage: the Topic, then each Item's ref, Source and triage text. Feed
 * text can't open or close an item block, so it stays inside the block the system prompt marks
 * as material, not instructions.
 */
export function triagePrompt(
  topic: { name: string; research_goal: string },
  items: readonly { ref: string; item: PassedItem; text: string }[],
): string {
  const lines = [
    `Topic: ${topic.name}`,
    `Research goal: ${topic.research_goal}`,
    "",
    `Items to score (${items.length}):`,
  ];
  for (const { ref, item, text } of items) {
    lines.push(
      "",
      `<item ref="${ref}">`,
      `Source: ${inertItemTags(item.source_id)}`,
      inertItemTags(text),
      "</item>",
    );
  }
  return lines.join("\n");
}
