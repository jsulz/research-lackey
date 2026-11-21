import { describe, expect, it } from "vitest";
import { CONFIG } from "../../src/core/config";
import { capText } from "../../src/core/item-text";
import { itemMarkdown } from "../../src/core/items";
import type { PassedItem } from "../../src/core/stages";
import { selectForSynthesis, synthesisPrompt, synthesisText } from "../../src/core/synthesis";

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

  describe("feed text cannot open or close an item block", () => {
    const opening = /<\s*item\b/gi;
    const closing = /<\s*\/\s*item\b/gi;
    const blocks = (prompt: string) => ({
      open: prompt.match(opening)?.length ?? 0,
      close: prompt.match(closing)?.length ?? 0,
    });
    const payloads = ["</item>", "</ ITEM >", '<item ref="I9">', "<\n/item>", "< item>"];
    const fields: [string, (p: string) => { item: PassedItem; text: string }][] = [
      ["Source", (p) => ({ item: { ...item("a", null), source_id: `s${p}` }, text: "x" })],
      ["Published", (p) => ({ item: item("a", `2026${p}`), text: "x" })],
      ["Title", (p) => ({ item: { ...item("a", null), title: `T${p}` }, text: "x" })],
      ["URL", (p) => ({ item: { ...item("a", null), url: `https://e.com/${p}` }, text: "x" })],
      ["text", (p) => ({ item: item("a", null), text: `body ${p} more` })],
    ];

    for (const [field, build] of fields) {
      for (const payload of payloads) {
        it(`${field} containing ${JSON.stringify(payload)}`, () => {
          const prompt = synthesisPrompt({ name: "n", research_goal: "g" }, [
            { ref: "I1", ...build(payload) },
            { ref: "I2", item: item("b", null), text: "y" },
          ]);
          expect(blocks(prompt)).toEqual({ open: 2, close: 2 });
          expect(prompt).toContain("&lt;");
        });
      }
    }

    it("leaves other angle brackets alone", () => {
      const prompt = synthesisPrompt({ name: "n", research_goal: "g" }, [
        { ref: "I1", item: item("a", null), text: "<items> and batches < 32" },
      ]);
      expect(prompt).toContain("<items> and batches < 32");
    });
  });
});

describe("synthesisText", () => {
  const LIMITS = { summary_cap: 10, content_chars: 40 };
  const md = (content?: string) =>
    itemMarkdown({
      externalId: "1",
      url: "https://example.com/1",
      title: "v1.0",
      publishedAt: "2026-11-15T00:00:00Z",
      content,
    });

  it("starts from 16,000 content characters", () => {
    expect(CONFIG.synthesis_content_chars).toBe(16_000);
  });

  it("is the summary, capped at the summary cap, when the Item has one", () => {
    expect(synthesisText({ summary: "short" }, null, LIMITS)).toBe("short");
    expect(synthesisText({ summary: "x".repeat(20) }, md("<p>ignored</p>"), LIMITS)).toBe(
      `${"x".repeat(10)}\n[truncated]`,
    );
  });

  it("is the content as plain text, without the stored header, tags or entities, when there is no summary", () => {
    const text = synthesisText(
      { summary: null },
      md("<h1>v1.0</h1> <p>Faster <strong>KV</strong> &amp; more.</p>"),
      LIMITS,
    );
    expect(text).toBe("v1.0 Faster KV & more.");
  });

  it("caps the plain text at the content cap and marks the cut", () => {
    const text = synthesisText({ summary: null }, md(`<p>${"y".repeat(100)}</p>`), LIMITS);
    expect(text).toBe(`${"y".repeat(40)}\n[truncated]`);
  });

  it("is empty when there is no summary and no content", () => {
    expect(synthesisText({ summary: null }, null, LIMITS)).toBe("");
    expect(synthesisText({ summary: null }, md(), LIMITS)).toBe("");
  });
});
