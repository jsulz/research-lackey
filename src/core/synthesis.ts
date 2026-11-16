import { newestFirst } from "./items";
import type { PassedItem } from "./stages";

/** An Item chosen for Synthesis, with the short ref the model cites it by. */
export interface SynthesisItem {
  /** `I1`, `I2`, ... in newest-first order. */
  ref: string;
  item: PassedItem;
}

/** The newest `k` Items across all Sources. Until Triage exists (JSU-31), this is the whole selection. */
export function selectForSynthesis(items: readonly PassedItem[], k: number): SynthesisItem[] {
  return newestFirst(items)
    .slice(0, k)
    .map((item, i) => ({ ref: `I${i + 1}`, item }));
}

/** Cuts text longer than `cap` characters and marks the cut, so one Item can't dominate a prompt. */
export function capText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[truncated]`;
}

/** The user message for Synthesis: the Topic, then each Item's metadata and text. */
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
      `Source: ${item.source_id}`,
      `Published: ${item.published_at ?? "unknown"}`,
      `Title: ${item.title}`,
      `URL: ${item.url}`,
      "",
      text,
      "</item>",
    );
  }
  return lines.join("\n");
}
