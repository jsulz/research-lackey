import { capText, contentBody, inertItemTags, plainText } from "./item-text";
import type { PassedItem } from "./stages";

/** An Item chosen for Synthesis, with the short ref the model cites it by. */
export interface SynthesisItem {
  /** `I1`, `I2`, ... in Triage rank order: `I1` scored highest. */
  ref: string;
  item: PassedItem;
}

/** The first `k` of Triage's selection, already in rank order, with refs `I1`..`Ik`. */
export function selectForSynthesis(ranked: readonly PassedItem[], k: number): SynthesisItem[] {
  return ranked.slice(0, k).map((item, i) => ({ ref: `I${i + 1}`, item }));
}

export interface SynthesisTextLimits {
  /** Longest summary, in characters, for an Item whose content has no text. */
  summary_cap: number;
  /** Longest content, in characters of plain text. */
  content_chars: number;
}

/**
 * The text Synthesis reads for one Item: its content as plain text, or, when the content has no
 * text (or the Markdown is missing), its summary. Both are capped, and the cut is marked.
 * `markdown` is the Item's R2 Markdown.
 */
export function synthesisText(
  item: { summary: string | null },
  markdown: string | null,
  limits: SynthesisTextLimits,
): string {
  const content = markdown === null ? "" : plainText(contentBody(markdown, item.summary));
  if (content.trim() !== "") return capText(content, limits.content_chars);
  return item.summary === null ? "" : capText(item.summary, limits.summary_cap);
}

/** Feed-controlled metadata is capped like Item text, so one entry can't inflate the prompt. */
const TITLE_CAP = 300;
const URL_CAP = 2_000;

/**
 * The user message for Synthesis: the Topic, then each Item's metadata and text. Feed text can't
 * open or close an item block, so it stays inside the block the system prompt marks as material,
 * not instructions.
 */
export function synthesisPrompt(
  topic: { name: string; research_goal: string },
  items: readonly (SynthesisItem & { text: string })[],
): string {
  const lines = [
    `Topic: ${topic.name}`,
    `Research goal: ${topic.research_goal}`,
    "",
    `New Items (${items.length}):`,
  ];
  for (const { ref, item, text } of items) {
    lines.push(
      "",
      `<item ref="${ref}">`,
      `Source: ${inertItemTags(item.source_id)}`,
      `Published: ${inertItemTags(item.published_at ?? "unknown")}`,
      `Title: ${inertItemTags(capText(item.title, TITLE_CAP))}`,
      `URL: ${inertItemTags(capText(item.url, URL_CAP))}`,
      "",
      inertItemTags(text),
      "</item>",
    );
  }
  return lines.join("\n");
}
