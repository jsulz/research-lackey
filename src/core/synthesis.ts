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

/** Cuts text longer than `cap` characters and marks the cut, so one Item can't dominate a prompt. */
export function capText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[truncated]`;
}

/** Feed-controlled metadata is capped like Item text, so one entry can't inflate the prompt. */
const TITLE_CAP = 300;
const URL_CAP = 2_000;

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
      `Title: ${capText(item.title, TITLE_CAP)}`,
      `URL: ${capText(item.url, URL_CAP)}`,
      "",
      text,
      "</item>",
    );
  }
  return lines.join("\n");
}
