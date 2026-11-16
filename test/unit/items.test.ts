import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../../src/core/feeds";
import { itemKey, newestFirst } from "../../src/core/items";
import type { FeedFormat, RawItem } from "../../src/core/ports";

function raw(fields: Partial<RawItem>): RawItem {
  return { externalId: "", url: "", title: "", ...fields };
}

describe("itemKey, arXiv", () => {
  it.each([
    ["http://arxiv.org/abs/2611.17097v1", "arxiv:2611.17097"],
    ["http://arxiv.org/abs/2611.17097v12", "arxiv:2611.17097"],
    ["https://arxiv.org/abs/2611.17097", "arxiv:2611.17097"],
    ["http://arxiv.org/abs/cs/0101001v2", "arxiv:cs/0101001"],
  ])("Atom id %s -> %s", (externalId, key) => {
    expect(itemKey("atom", raw({ externalId }))).toBe(key);
  });

  it("gives an arXiv entry and a Daily Papers entry for the same paper one identity", () => {
    const fromArxiv = itemKey("atom", raw({ externalId: "http://arxiv.org/abs/2611.17097v3" }));
    const fromDailyPapers = itemKey("hf_daily_papers", raw({ externalId: "2611.17097" }));
    expect(fromArxiv).toBe("arxiv:2611.17097");
    expect(fromDailyPapers).toBe(fromArxiv);
  });
});

describe("itemKey, arXiv in any position", () => {
  it.each([
    ["hep-th/9901001", "arxiv:hep-th/9901001"],
    ["hep-th/9901001v2", "arxiv:hep-th/9901001"],
    ["2611.17097v4", "arxiv:2611.17097"],
  ])("Daily Papers ID %s -> %s", (externalId, key) => {
    expect(itemKey("hf_daily_papers", raw({ externalId }))).toBe(key);
  });

  it("gives an old-style paper one identity from arXiv and from Daily Papers", () => {
    expect(itemKey("hf_daily_papers", raw({ externalId: "hep-th/9901001" }))).toBe(
      itemKey("atom", raw({ externalId: "http://arxiv.org/abs/hep-th/9901001v2" })),
    );
  });

  it("normalizes an arXiv link used as the identity when there is no GUID", () => {
    const v1 = itemKey("rss2", raw({ url: "https://arxiv.org/abs/2611.17097v1" }));
    const v2 = itemKey("rss2", raw({ url: "https://arxiv.org/abs/2611.17097v2" }));
    expect(v1).toBe("arxiv:2611.17097");
    expect(v2).toBe(v1);
  });

  it("keeps a non-arXiv GUID even when the link is an arXiv URL", () => {
    expect(
      itemKey(
        "rss2",
        raw({ externalId: "urn:blog:42", url: "https://arxiv.org/abs/2611.17097v1" }),
      ),
    ).toBe("urn:blog:42");
  });
});

describe("itemKey, other feeds", () => {
  it("uses the GUID or Atom id as given, trimmed", () => {
    expect(itemKey("rss2", raw({ externalId: " https://vllm.ai/blog/a ", url: "x" }))).toBe(
      "https://vllm.ai/blog/a",
    );
    expect(
      itemKey("atom", raw({ externalId: "tag:github.com,2008:Repository/599547518/v0.34.0rc4" })),
    ).toBe("tag:github.com,2008:Repository/599547518/v0.34.0rc4");
  });

  it("falls back to the link when there is no id", () => {
    expect(itemKey("rss2", raw({ url: "https://example.com/post" }))).toBe(
      "https://example.com/post",
    );
  });

  it("falls back to a hash of title and link when there is neither", () => {
    const a = itemKey("rss2", raw({ title: "Post A" }));
    expect(a).toMatch(/^hash:[0-9a-f]+$/);
    expect(itemKey("rss2", raw({ title: "Post A" }))).toBe(a);
    expect(itemKey("rss2", raw({ title: "Post B" }))).not.toBe(a);
  });

  it("never depends on the date", () => {
    const base = raw({ externalId: "urn:x:1", publishedAt: "2026-11-01T00:00:00.000Z" });
    expect(itemKey("atom", { ...base, publishedAt: "2026-11-14T00:00:00.000Z" })).toBe(
      itemKey("atom", base),
    );
  });
});

describe("itemKey on the committed fixtures", () => {
  // Entry counts come from the fixture inspection with Python; keys must be unique per feed.
  it.each([
    ["rss2", "vllm-blog.rss.xml", 50],
    ["rss2", "vllm-blog-plus-one.rss.xml", 51],
    ["atom", "modal-blog.atom.xml", 157],
    ["atom", "arxiv-serving.atom.xml", 50],
    ["atom", "vllm-releases.atom.xml", 10],
    ["hf_daily_papers", "hf-daily-papers-2026-11-13.json", 34],
  ] as const)("%s %s has %i distinct identities", (format: FeedFormat, file, count) => {
    const text = readFileSync(path.join(import.meta.dirname, "../../fixtures/feeds", file), "utf8");
    const keys = new Set(parseFeed(format, text).map((item) => itemKey(format, item)));
    expect(keys.size).toBe(count);
  });

  it("gives every arXiv and Daily Papers fixture entry an arxiv: identity", () => {
    const dir = path.join(import.meta.dirname, "../../fixtures/feeds");
    const arxiv = parseFeed("atom", readFileSync(path.join(dir, "arxiv-serving.atom.xml"), "utf8"));
    const hf = parseFeed(
      "hf_daily_papers",
      readFileSync(path.join(dir, "hf-daily-papers-2026-11-13.json"), "utf8"),
    );
    for (const item of arxiv) expect(itemKey("atom", item)).toMatch(/^arxiv:\d{4}\.\d{5}$/);
    for (const item of hf) expect(itemKey("hf_daily_papers", item)).toMatch(/^arxiv:\d{4}\.\d{5}$/);
  });
});

describe("newestFirst", () => {
  const at = (key: string, published_at: string | null) => ({ item_key: key, published_at });

  it("orders by date, newest first, keeping feed order for equal dates and undated Items last", () => {
    const items = [
      at("old", "2026-01-01T00:00:00.000Z"),
      at("undated-1", null),
      at("tie-a", "2026-11-12T00:00:00.000Z"),
      at("newest", "2026-11-14T00:00:00.000Z"),
      at("tie-b", "2026-11-12T00:00:00.000Z"),
      at("undated-2", null),
    ];
    expect(newestFirst(items).map((i) => i.item_key)).toEqual([
      "newest",
      "tie-a",
      "tie-b",
      "old",
      "undated-1",
      "undated-2",
    ]);
  });

  it("does not reorder its input", () => {
    const items = [at("a", "2026-01-01T00:00:00.000Z"), at("b", "2026-02-01T00:00:00.000Z")];
    newestFirst(items);
    expect(items.map((i) => i.item_key)).toEqual(["a", "b"]);
  });
});
