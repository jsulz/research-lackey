import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../../src/core/feeds";

// Expected values were read from the fixture files with Python's standard XML and JSON
// parsers, independently of the code under test.

function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "../../fixtures/feeds", name), "utf8");
}

describe("parseFeed, RSS 2.0", () => {
  const items = parseFeed("rss2", fixture("vllm-blog.rss.xml"));

  it("returns every item", () => {
    expect(items).toHaveLength(50);
  });

  it("reads GUID, link, title, date and description", () => {
    expect(items[0]).toMatchObject({
      externalId: "https://vllm.ai/blog/2026-11-12-deepseek-v41-flash-vera-rubin",
      url: "https://vllm.ai/blog/2026-11-12-deepseek-v41-flash-vera-rubin",
      title:
        "DeepSeek-V4.1-Flash on Vera Rubin NVL72: 58x Throughput vs. GB300 NVL72 at 387 tokens/s",
      publishedAt: "2026-11-12T00:00:00.000Z",
    });
    expect(items[0]?.summary).toMatch(
      /^On one NVIDIA Vera Rubin NVL72 rack, vLLM serves DeepSeek-V4/,
    );
  });
});

describe("parseFeed, Atom", () => {
  it("reads id, the link without rel, and the updated time when there is no published time", () => {
    const items = parseFeed("atom", fixture("modal-blog.atom.xml"));
    expect(items).toHaveLength(157);
    expect(items[0]).toEqual({
      externalId: "https://modal.com/blog/scaling-intelligence",
      url: "https://modal.com/blog/scaling-intelligence",
      title: "Scaling Intelligence: A landmark commission and exhibition",
      summary: undefined,
      content: undefined,
      publishedAt: "2026-11-13T00:00:00.000Z",
    });
  });

  it("reads the alternate link, the published time and the summary of an arXiv entry", () => {
    const items = parseFeed("atom", fixture("arxiv-serving.atom.xml"));
    expect(items).toHaveLength(50);
    expect(items[0]).toMatchObject({
      externalId: "http://arxiv.org/abs/2611.17097v1",
      url: "https://arxiv.org/abs/2611.17097v1",
      title: "Broadcast, Don't Replicate: Eliminating Weight HBM in Datacenter LLM Serving",
      publishedAt: "2026-11-12T16:58:07.000Z",
    });
    expect(items[0]?.summary).toMatch(
      /^Large language model \(LLM\) inference at datacenter scale is /,
    );
  });

  it("reads HTML content when the entry has no summary (GitHub releases)", () => {
    const items = parseFeed("atom", fixture("vllm-releases.atom.xml"));
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({
      externalId: "tag:github.com,2008:Repository/599547518/v0.34.0rc4",
      url: "https://github.com/vllm-project/vllm/releases/tag/v0.34.0rc4",
      title: "v0.34.0rc4",
      summary: undefined,
      publishedAt: "2026-11-14T10:15:55.000Z",
    });
    expect(items[0]?.content).toMatch(
      /^<p>\[Release\]\[Tests\] Give the <a class="issue-link js-issue-l/,
    );
  });

  it("returns a one-entry feed as one item", () => {
    const one = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>urn:x:1</id><title>Only</title><link href="https://example.com/1"/></entry></feed>`;
    expect(parseFeed("atom", one)).toEqual([
      { externalId: "urn:x:1", url: "https://example.com/1", title: "Only" },
    ]);
  });
});

describe("parseFeed, Hugging Face Daily Papers JSON", () => {
  it("reads the paper ID, title, abstract and the paper's published time", () => {
    const items = parseFeed("hf_daily_papers", fixture("hf-daily-papers-2026-11-13.json"));
    expect(items).toHaveLength(34);
    expect(items[0]).toMatchObject({
      externalId: "2611.15777",
      url: "https://huggingface.co/papers/2611.15777",
      title: "SO-Arena: Benchmarking the Capability Spectrum and Reliability of System One Models",
      publishedAt: "2026-11-11T00:00:00.000Z",
    });
    expect(items[0]?.summary).toMatch(
      /^System One models promise fast, general-purpose decision-mak/,
    );
  });
});

describe("parseFeed, unreadable text", () => {
  it.each([
    ["rss2", "<html><body>not a feed</body></html>"],
    ["atom", "<rss><channel></channel></rss>"],
    ["hf_daily_papers", "{not json"],
    ["hf_daily_papers", '{"papers": []}'],
  ] as const)("%s rejects %s", (format, text) => {
    expect(() => parseFeed(format, text)).toThrow();
  });
});
