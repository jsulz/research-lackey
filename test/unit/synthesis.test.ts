import { describe, expect, it } from "vitest";
import { capText } from "../../src/core/item-text";
import type { PassedItem } from "../../src/core/stages";
import { selectForSynthesis, synthesisPrompt } from "../../src/core/synthesis";

function item(id: string, published_at: string | null, summary: string | null = "s"): PassedItem {
  return {
    source_id: `src-${id}`,
    item_key: id,
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    summary,
    published_at,
    content_key: `items/src-${id}/${id}/run.md`,
  };
}

describe("selectForSynthesis", () => {
  it("takes the first K Items in the given (Triage rank) order and gives them refs I1..Ik", () => {
    const picked = selectForSynthesis(
      [item("top", "2026-11-01T00:00:00Z"), item("second", null), item("third", null)],
      2,
    );
    expect(picked.map((p) => [p.ref, p.item.item_key])).toEqual([
      ["I1", "top"],
      ["I2", "second"],
    ]);
  });

  it("returns every Item when there are fewer than K", () => {
    expect(selectForSynthesis([item("a", null)], 5)).toHaveLength(1);
  });
});

describe("capText", () => {
  it("keeps text within the cap unchanged", () => {
    expect(capText("abc", 3)).toBe("abc");
  });

  it("cuts longer text to the cap and marks the cut", () => {
    expect(capText("abcdef", 3)).toBe("abc\n[truncated]");
  });
});

describe("synthesisPrompt", () => {
  it("states the Topic and research goal, then one block per Item with its ref, source, date, title, URL and text", () => {
    const prompt = synthesisPrompt(
      { name: "AI infrastructure platforms", research_goal: "Track serving advances." },
      [
        { ref: "I1", item: item("a", "2026-11-15T00:00:00Z"), text: "Summary A" },
        { ref: "I2", item: item("b", null), text: "Body B" },
      ],
    );
    expect(prompt).toBe(
      [
        "Topic: AI infrastructure platforms",
        "Research goal: Track serving advances.",
        "",
        "New Items (2):",
        "",
        '<item ref="I1">',
        "Source: src-a",
        "Published: 2026-11-15T00:00:00Z",
        "Title: Title a",
        "URL: https://example.com/a",
        "",
        "Summary A",
        "</item>",
        "",
        '<item ref="I2">',
        "Source: src-b",
        "Published: unknown",
        "Title: Title b",
        "URL: https://example.com/b",
        "",
        "Body B",
        "</item>",
      ].join("\n"),
    );
  });

  it("caps each Item's title at 300 characters and its URL at 2,000, so feed metadata can't inflate the prompt", () => {
    const long = {
      ...item("a", null),
      title: "T".repeat(100_000),
      url: `https://example.com/${"u".repeat(100_000)}`,
    };
    const prompt = synthesisPrompt({ name: "n", research_goal: "g" }, [
      { ref: "I1", item: long, text: "x" },
    ]);
    const lines = prompt.split("\n");
    const titleAt = lines.findIndex((l) => l.startsWith("Title: "));
    expect(lines[titleAt]).toBe(`Title: ${"T".repeat(300)}`);
    expect(lines[titleAt + 1]).toBe("[truncated]");
    const urlAt = lines.findIndex((l) => l.startsWith("URL: "));
    expect(lines[urlAt]).toHaveLength("URL: ".length + 2_000);
    expect(lines[urlAt + 1]).toBe("[truncated]");
    expect(prompt.length).toBeLessThan(3_000);
  });
});
