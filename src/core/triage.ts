import { newestFirst } from "./items";
import type { PassedItem } from "./stages";
import { capText } from "./synthesis";

/** Feed-controlled titles are capped, as in Synthesis, so one entry can't inflate the prompt. */
const TITLE_CAP = 300;

/** The heading `itemMarkdown` puts before an Item's content. */
const CONTENT_HEADING = "\n## Content\n\n";

/**
 * The content section of an Item's R2 Markdown (see `itemMarkdown`), without the title, URL,
 * date and heading before it. Used only for Items with no summary, so the first content heading
 * is the real one. Empty when there is none.
 */
export function contentBody(markdown: string): string {
  const at = markdown.indexOf(CONTENT_HEADING);
  return at === -1 ? "" : markdown.slice(at + CONTENT_HEADING.length).trim();
}

/** Named entities decoded by `plainText`: XML's five, plus the typographic ones common in feeds. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  le: "\u2264",
  ge: "\u2265",
  times: "\u00d7",
  middot: "\u00b7",
  bull: "\u2022",
  rarr: "\u2192",
  larr: "\u2190",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
};

/** Elements whose content is not text: skipped from the opening tag to the matching closing tag. */
const SKIPPED_ELEMENTS = new Set(["svg", "script", "style"]);

/**
 * Feed HTML as plain text, in one linear pass. Tags and comments become spaces; quoted attribute
 * values may contain `>`. The content of `svg`, `script` and `style` elements is dropped up to
 * the matching closing tag: an unclosed `script` or `style` runs to the end, while a self-closing
 * or unclosed `svg` drops only its own tag (its drawing is in attributes). A `<` that doesn't
 * start a tag (`batches < 32`) is kept. Then entities are decoded once (unknown ones stay as
 * written) and whitespace collapses. GitHub release notes, for example, spend about half of
 * their first characters on markup.
 */
export function plainText(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  const out: string[] = [];
  /** Skipped elements found to have no closing tag after some position: not searched again. */
  const unclosed = new Set<string>();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      out.push(" ");
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? "")) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + 1);
    const tag = html.slice(lt + 1, end);
    i = end + 1;
    out.push(" ");
    const name = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name || !SKIPPED_ELEMENTS.has(name)) continue;
    // Only svg can self-close; in HTML, `<script/>` and `<style/>` still open the element.
    if (name === "svg" && /\/\s*$/.test(tag)) continue;
    if (unclosed.has(name)) {
      if (name !== "svg") i = html.length;
      continue;
    }
    const closing = new RegExp(`</${name}[\\s>]`, "gi");
    closing.lastIndex = i;
    const found = closing.exec(html);
    if (found) {
      i = tagEnd(html, found.index + 1) + 1;
    } else {
      unclosed.add(name);
      if (name !== "svg") i = html.length;
    }
  }
  return out.join("");
}

/** The index of the `>` that ends the tag whose name starts at `from`, skipping quoted values. */
function tagEnd(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const ch = html[i];
    if (ch === ">") return i;
    if (ch === '"' || ch === "'") {
      const close = html.indexOf(ch, i + 1);
      if (close === -1) return html.length;
      i = close + 1;
    } else {
      i++;
    }
  }
  return html.length;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const key = name.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? (NAMED_ENTITIES[key] as string) : match;
  });
}

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

/** Escapes anything in feed text that would open or close an item block (`</item>`, `<ITEM`). */
function inertItemTags(text: string): string {
  return text.replace(/<(?=\s*\/?\s*item\b)/gi, "&lt;");
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
