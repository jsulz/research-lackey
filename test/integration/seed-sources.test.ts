import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1RunStore } from "../../src/adapters/d1-run-store";
import { CONFIG } from "../../src/core/config";
import { filtersProblem } from "../../src/core/source-filters";
import { sourceRequestUrl } from "../../src/core/source-url";
import { STEP_TIMEOUT_MINUTES } from "../../src/worker/run-workflow";

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

const NO_FILTERS = { include_keywords: [], exclude_keywords: [], exclude_title_pattern: null };

describe("seed Sources", () => {
  it("each have their live feed URL and filters", async () => {
    const sources = await new D1RunStore(env.DB).listFeedSources("ai-infra");

    expect(sources.map((s) => [s.id, s.format, s.url])).toEqual([
      [
        "arxiv-serving",
        "atom",
        "https://export.arxiv.org/api/query?search_query=%28cat:cs.DC+OR+cat:cs.PF+OR+cat:cs.OS%29+AND+%28abs:%22LLM+serving%22+OR+abs:%22LLM+inference%22+OR+abs:%22KV+cache%22+OR+abs:%22speculative+decoding%22+OR+abs:%22inference+serving%22%29&sortBy=submittedDate&sortOrder=descending&max_results=50",
      ],
      [
        "arxiv-training",
        "atom",
        "https://export.arxiv.org/api/query?search_query=cat:cs.DC+AND+%28abs:%22distributed+training%22+OR+abs:%22pipeline+parallelism%22+OR+abs:%22tensor+parallelism%22+OR+abs:%22mixture+of+experts%22+OR+abs:%22GPU+cluster%22+OR+abs:%22fine-tuning%22%29&sortBy=submittedDate&sortOrder=descending&max_results=50",
      ],
      ["cloudflare-workers-ai", "rss2", "https://blog.cloudflare.com/tag/workers-ai/rss/"],
      [
        "google-cloud-ai-infra",
        "rss2",
        "https://cloudblog.withgoogle.com/topics/ai-infrastructure/rss/",
      ],
      ["hf-daily-papers", "hf_daily_papers", "https://huggingface.co/api/daily_papers?date={date}"],
      ["modal-blog", "atom", "https://modal.com/blog/atom.xml"],
      [
        "nvidia-inference",
        "atom",
        "https://developer.nvidia.com/blog/tag/inference-performance/feed/",
      ],
      ["pytorch-blog", "rss2", "https://pytorch.org/feed/"],
      ["semianalysis", "rss2", "https://newsletter.semianalysis.com/feed"],
      ["sglang-releases", "atom", "https://github.com/sgl-project/sglang/releases.atom"],
      ["together-blog", "rss2", "https://www.together.ai/blog/rss.xml"],
      ["vllm-blog", "rss2", "https://vllm.ai/blog/rss.xml"],
      ["vllm-releases", "atom", "https://github.com/vllm-project/vllm/releases.atom"],
    ]);
    expect(Object.fromEntries(sources.map((s) => [s.id, s.filters]))).toEqual({
      "arxiv-serving": NO_FILTERS,
      "arxiv-training": NO_FILTERS,
      "cloudflare-workers-ai": NO_FILTERS,
      "google-cloud-ai-infra": NO_FILTERS,
      "hf-daily-papers": {
        include_keywords: HF_KEYWORDS,
        exclude_keywords: [],
        exclude_title_pattern: null,
      },
      "modal-blog": NO_FILTERS,
      "nvidia-inference": NO_FILTERS,
      "pytorch-blog": NO_FILTERS,
      semianalysis: NO_FILTERS,
      "sglang-releases": {
        include_keywords: [],
        exclude_keywords: [],
        exclude_title_pattern: "^([a-z]+-)?v?\\d+(\\.\\d+)*[-.]?rc\\.?\\d*\\b",
      },
      "together-blog": NO_FILTERS,
      "vllm-blog": NO_FILTERS,
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

  it("sglang-releases' pattern removes release candidates, prefixed ones too, and keeps releases", async () => {
    const sources = await new D1RunStore(env.DB).listFeedSources("ai-infra");
    const pattern = sources.find((s) => s.id === "sglang-releases")?.filters.exclude_title_pattern;
    expect(pattern).toBeTruthy();
    const removed = (title: string) => new RegExp(pattern ?? "", "i").test(title);

    for (const title of [
      "v0.5.24rc0",
      "v0.6.0rc1: Release candidate",
      "0.6.0-rc.2",
      "v0.6.0.rc1",
      "router-v0.2.0rc1",
      "gateway-v0.3.0-rc.1",
    ]) {
      expect(removed(title), title).toBe(true);
    }
    // Every title in the 2026-11-22 capture, and titles that only mention "rc".
    for (const title of [
      "router-v0.1.0",
      "v0.5.23",
      "v0.5.15.post1",
      "v0.6.0: Arc GPU support",
      "Release v0.5.23",
      "v1.0.0 (source)",
    ]) {
      expect(removed(title), title).toBe(false);
    }
  });

  it("can all time out on every request within one fetch step's timeout", async () => {
    const sources = await new D1RunStore(env.DB).listFeedSources("ai-infra");
    const { timeout_ms, retries, backoff_ms, host_intervals_ms } = CONFIG.fetch;
    const requests = retries + 1;
    // Per Source: every request runs to the timeout, with the backoff waits between them.
    const perSource = requests * timeout_ms + backoff_ms * (2 ** retries - 1);
    // Each request to a spaced host can also wait that host's full interval first.
    const spacing = sources
      .map((s) => host_intervals_ms[new URL(s.url ?? "").hostname] ?? 0)
      .reduce((sum, interval) => sum + interval * requests, 0);

    expect(sources).toHaveLength(13);
    expect(sources.length * perSource + spacing).toBeLessThan(STEP_TIMEOUT_MINUTES * 60_000);
  });

  it("can't store a keyword list that is not a JSON array", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE sources SET include_keywords = '\"llm\"' WHERE id = 'vllm-blog'",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
