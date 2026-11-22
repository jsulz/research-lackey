// Stands in for src/worker/source-fetcher-factory.ts in integration tests (alias in
// vitest.integration.config.ts). It builds the real HttpSourceFetcher over a fake outbound fetch
// that serves the fixture files by URL, so no test reaches the network. Tests script failures per
// URL and read every request made.
import arxivServing from "../../fixtures/feeds/arxiv-serving.atom.xml";
import arxivTraining from "../../fixtures/feeds/arxiv-training-2026-11-22.atom.xml";
import cloudflareWorkersAi from "../../fixtures/feeds/cloudflare-workers-ai-2026-11-22.rss.xml";
import googleCloudAiInfra from "../../fixtures/feeds/google-cloud-ai-infra-2026-11-22.rss.xml";
import hfDailyPapers from "../../fixtures/feeds/hf-daily-papers-2026-11-13.json";
import modalBlog from "../../fixtures/feeds/modal-blog.atom.xml";
import nvidiaInference from "../../fixtures/feeds/nvidia-inference-2026-11-22.atom.xml";
import pytorchBlog from "../../fixtures/feeds/pytorch-blog-2026-11-22.rss.xml";
import semianalysis from "../../fixtures/feeds/semianalysis-2026-11-22.rss.xml";
import sglangReleases from "../../fixtures/feeds/sglang-releases-2026-11-22.atom.xml";
import summaryAndContent from "../../fixtures/feeds/summary-and-content.atom.xml";
import togetherBlog from "../../fixtures/feeds/together-blog-2026-11-22.rss.xml";
import vllmBlog from "../../fixtures/feeds/vllm-blog.rss.xml";
import vllmBlog20261117 from "../../fixtures/feeds/vllm-blog-2026-11-17.rss.xml";
import vllmBlogPlusOne from "../../fixtures/feeds/vllm-blog-plus-one.rss.xml";
import vllmReleases from "../../fixtures/feeds/vllm-releases.atom.xml";
import vllmReleases20261117 from "../../fixtures/feeds/vllm-releases-2026-11-17.atom.xml";
import { HttpSourceFetcher, type OutboundInit } from "../../src/adapters/http-source-fetcher";
import type { FetchConfig } from "../../src/core/config";
import type { SourceFetcher } from "../../src/core/ports";

/** Fixture files serve at `https://feeds.test/<file name>`. */
export const FEEDS = "https://feeds.test/";

/**
 * Fixture files by name. Wrangler's `Text` module rule imports each as a string; a bundler that
 * still parses `.json` gives an object, which is serialized back to text.
 */
const FIXTURES: Record<string, unknown> = {
  "arxiv-serving.atom.xml": arxivServing,
  "arxiv-training-2026-11-22.atom.xml": arxivTraining,
  "cloudflare-workers-ai-2026-11-22.rss.xml": cloudflareWorkersAi,
  "google-cloud-ai-infra-2026-11-22.rss.xml": googleCloudAiInfra,
  "hf-daily-papers-2026-11-13.json": hfDailyPapers,
  "modal-blog.atom.xml": modalBlog,
  "nvidia-inference-2026-11-22.atom.xml": nvidiaInference,
  "pytorch-blog-2026-11-22.rss.xml": pytorchBlog,
  "semianalysis-2026-11-22.rss.xml": semianalysis,
  "sglang-releases-2026-11-22.atom.xml": sglangReleases,
  "summary-and-content.atom.xml": summaryAndContent,
  "together-blog-2026-11-22.rss.xml": togetherBlog,
  "vllm-blog.rss.xml": vllmBlog,
  "vllm-blog-2026-11-17.rss.xml": vllmBlog20261117,
  "vllm-blog-plus-one.rss.xml": vllmBlogPlusOne,
  "vllm-releases.atom.xml": vllmReleases,
  "vllm-releases-2026-11-17.atom.xml": vllmReleases20261117,
};

/**
 * An Atom feed of 12 entries with 100,000 characters of content each, about 1.2 MB of entries,
 * shaped like a GitHub releases feed. Built on demand so no megabyte file is committed.
 */
function oversizedFeed(): string {
  const entries = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    const body = `Release ${n} notes. `.padEnd(100_000, "lorem ipsum ");
    return `<entry><id>tag:example.com,2026:oversized/${n}</id><title>Oversized ${n}</title>
<link rel="alternate" href="https://example.com/oversized/${n}"/>
<updated>2026-11-${String(n).padStart(2, "0")}T00:00:00Z</updated>
<content type="html">${body}</content></entry>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:example.com,2026:oversized</id>
<title>Oversized fixture</title><updated>2026-11-12T00:00:00Z</updated>${entries.join("\n")}</feed>`;
}

/** Feeds generated in code, by name. */
const GENERATED: Record<string, () => string> = {
  "oversized.atom.xml": oversizedFeed,
};

/**
 * The seeded Sources' live URLs (migrations 0008 and 0009), each answered with its fixture
 * capture. The first matching prefix wins, so the arXiv training query comes before the prefix
 * every other arXiv query matches.
 */
const LIVE: [prefix: string, fixture: string][] = [
  [
    "https://export.arxiv.org/api/query?search_query=cat:cs.DC+AND+%28abs:%22distributed+training%22",
    "arxiv-training-2026-11-22.atom.xml",
  ],
  ["https://export.arxiv.org/api/query?", "arxiv-serving.atom.xml"],
  ["https://huggingface.co/api/daily_papers?date=", "hf-daily-papers-2026-11-13.json"],
  ["https://modal.com/blog/atom.xml", "modal-blog.atom.xml"],
  ["https://vllm.ai/blog/rss.xml", "vllm-blog-2026-11-17.rss.xml"],
  ["https://github.com/vllm-project/vllm/releases.atom", "vllm-releases-2026-11-17.atom.xml"],
  ["https://pytorch.org/feed/", "pytorch-blog-2026-11-22.rss.xml"],
  [
    "https://developer.nvidia.com/blog/tag/inference-performance/feed/",
    "nvidia-inference-2026-11-22.atom.xml",
  ],
  ["https://blog.cloudflare.com/tag/workers-ai/rss/", "cloudflare-workers-ai-2026-11-22.rss.xml"],
  ["https://www.together.ai/blog/rss.xml", "together-blog-2026-11-22.rss.xml"],
  [
    "https://cloudblog.withgoogle.com/topics/ai-infrastructure/rss/",
    "google-cloud-ai-infra-2026-11-22.rss.xml",
  ],
  ["https://github.com/sgl-project/sglang/releases.atom", "sglang-releases-2026-11-22.atom.xml"],
  ["https://newsletter.semianalysis.com/feed", "semianalysis-2026-11-22.rss.xml"],
];

function fixtureText(name: string): string | null {
  const generate = Object.hasOwn(GENERATED, name) ? GENERATED[name] : undefined;
  if (generate) return generate();
  if (!Object.hasOwn(FIXTURES, name)) return null;
  const fixture = FIXTURES[name];
  return typeof fixture === "string" ? fixture : JSON.stringify(fixture);
}

/** The body the fake serves for a URL, or null when it has none (a 404). */
function bodyFor(url: string): string | null {
  if (url.startsWith(FEEDS)) return fixtureText(url.slice(FEEDS.length).split("?")[0] ?? "");
  const live = LIVE.find(([prefix]) => url.startsWith(prefix));
  return live ? fixtureText(live[1]) : null;
}

/**
 * How the fake answers one request, instead of serving the URL's fixture: an HTTP status, no
 * answer until the request is aborted (`timeout`), or a connection error (`network`).
 */
export type FeedStep = { status: number } | "timeout" | "network";

/** One outbound request the Workflow made. `at` is `Date.now()` when it arrived. */
export interface FeedRequestSeen {
  url: string;
  headers: Record<string, string>;
  at: number;
}

/** Every outbound request, in order. */
export const requests: FeedRequestSeen[] = [];
/** Every wait the fetcher made (retry backoff and host spacing), in order, in milliseconds. */
export const sleeps: number[] = [];
/** The settings the Worker passed to the factory, before test overrides. Null until a Run fetches. */
export let workerSettings: FetchConfig | null = null;

/** The gap tests keep between arXiv requests unless one sets its own, in milliseconds. */
export const TEST_ARXIV_INTERVAL_MS = 20;

/**
 * Retry waits and arXiv spacing are short in tests unless one sets its own: the seed Topic has
 * two arXiv Sources, and the Worker's 3,000 ms between them would pass in real time.
 */
const DEFAULT_OVERRIDES: Partial<FetchConfig> = {
  backoff_ms: 1,
  host_intervals_ms: { "export.arxiv.org": TEST_ARXIV_INTERVAL_MS },
};
let overrides: Partial<FetchConfig> = { ...DEFAULT_OVERRIDES };
const scripted = new Map<string, FeedStep[]>();

/** The next requests to `url` get these answers, one each; later ones get its fixture again. */
export function scriptFeed(url: string, steps: FeedStep[]): void {
  scripted.set(url, [...steps]);
}

/** Settings that replace the Worker's for Runs started from now until `resetFeeds()`. */
export function overrideFetchSettings(settings: Partial<FetchConfig>): void {
  overrides = { ...overrides, ...settings };
}

/** Back to serving every fixture, with the default overrides. Clears recorded requests and waits. */
export function resetFeeds(): void {
  scripted.clear();
  overrides = { ...DEFAULT_OVERRIDES };
  requests.length = 0;
  sleeps.length = 0;
  workerSettings = null;
}

async function fakeFetch(url: string, init: OutboundInit): Promise<Response> {
  requests.push({ url, headers: { ...init.headers }, at: Date.now() });
  const step = scripted.get(url)?.shift();
  if (step === "network") throw new TypeError("fake network error");
  if (step === "timeout") {
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("The request was aborted")));
    });
  }
  if (step) return new Response(`status ${step.status}`, { status: step.status });
  const body = bodyFor(url);
  if (body === null) return new Response("not found", { status: 404 });
  return new Response(body, { status: 200 });
}

export function createSourceFetcher(settings: FetchConfig): SourceFetcher {
  workerSettings = settings;
  return new HttpSourceFetcher({
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    now: () => Date.now(),
    settings: { ...settings, ...overrides },
  });
}
