import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import { filtersProblem } from "../../src/core/source-filters";
import { sourceRequestUrl } from "../../src/core/source-url";

const HF_KEYWORDS = [
  "inference",
  "serving",
  "KV cache",
  "training",
  "distributed",
  "GPU",
  "kernel",
  "quantization",
  "mixture of experts",
  "throughput",
  "latency",
  "cluster",
  "parallelism",
  "storage",
  "checkpoint",
  "compiler",
];

describe("seed Sources", () => {
  it("each have their live feed URL and filters", async () => {
    const sources = await new D1RunStore(env.DB).listFeedSources("ai-infra");

    expect(sources.map((s) => [s.id, s.format, s.url])).toEqual([
      [
        "arxiv-serving",
        "atom",
        "https://export.arxiv.org/api/query?search_query=%28cat:cs.DC+OR+cat:cs.PF+OR+cat:cs.OS%29+AND+%28abs:%22LLM+serving%22+OR+abs:%22LLM+inference%22+OR+abs:%22KV+cache%22+OR+abs:%22speculative+decoding%22+OR+abs:%22inference+serving%22%29&sortBy=submittedDate&sortOrder=descending&max_results=50",
      ],
      ["hf-daily-papers", "hf_daily_papers", "https://huggingface.co/api/daily_papers?date={date}"],
      ["modal-blog", "atom", "https://modal.com/blog/atom.xml"],
      ["vllm-blog", "rss2", "https://vllm.ai/blog/rss.xml"],
      ["vllm-releases", "atom", "https://github.com/vllm-project/vllm/releases.atom"],
    ]);
    expect(Object.fromEntries(sources.map((s) => [s.id, s.filters]))).toEqual({
      "arxiv-serving": { include_keywords: [], exclude_keywords: [], exclude_title_pattern: null },
      "hf-daily-papers": {
        include_keywords: HF_KEYWORDS,
        exclude_keywords: [],
        exclude_title_pattern: null,
      },
      "modal-blog": { include_keywords: [], exclude_keywords: [], exclude_title_pattern: null },
      "vllm-blog": { include_keywords: [], exclude_keywords: [], exclude_title_pattern: null },
      "vllm-releases": {
        include_keywords: [],
        exclude_keywords: [],
        exclude_title_pattern: "^v?\\d+(\\.\\d+)*-?rc\\.?\\d*\\b",
      },
    });
  });

  it("each have a URL that resolves to an https request and filters that can be applied", async () => {
    const sources = await new D1RunStore(env.DB).listFeedSources("ai-infra");
    for (const source of sources) {
      const target = sourceRequestUrl(source.url, new Date("2026-11-22T12:00:00Z"));
      expect(target.ok && new URL(target.url).protocol, source.id).toBe("https:");
      expect(filtersProblem(source.filters), source.id).toBeNull();
    }
  });

  it("vllm-releases' pattern removes release candidates and keeps releases", async () => {
    const sources = await new D1RunStore(env.DB).listFeedSources("ai-infra");
    const pattern = sources.find((s) => s.id === "vllm-releases")?.filters.exclude_title_pattern;
    const removed = (title: string) => new RegExp(pattern ?? "", "i").test(title);

    for (const title of [
      "v0.34.0rc4",
      "v0.34.0rc0: [Transformers backend] Migrate Gemma and StableLM (#66393)",
      "v0.35.0-rc.1",
      "0.35.0RC2",
    ]) {
      expect(removed(title), title).toBe(true);
    }
    for (const title of ["v0.34.0", "v0.33.0", "v0.34.1: Fix orchestration", "v1.0.0 (source)"]) {
      expect(removed(title), title).toBe(false);
    }
  });

  it("can't store a keyword list that is not a JSON array", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE sources SET include_keywords = '\"llm\"' WHERE id = 'vllm-blog'",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
