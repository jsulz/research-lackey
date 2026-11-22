// Stands in for src/worker/source-fetcher-factory.ts in integration tests (alias in
// vitest.integration.config.ts). It builds the real HttpSourceFetcher over a fake outbound fetch
// that serves the fixture files by URL, so no test reaches the network. Tests script failures per
// URL and read every request made.
import arxivServing from "../../fixtures/feeds/arxiv-serving.atom.xml";
import hfDailyPapers from "../../fixtures/feeds/hf-daily-papers-2026-11-13.json";
import modalBlog from "../../fixtures/feeds/modal-blog.atom.xml";
import summaryAndContent from "../../fixtures/feeds/summary-and-content.atom.xml";
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
  "hf-daily-papers-2026-11-13.json": hfDailyPapers,
  "modal-blog.atom.xml": modalBlog,
  "summary-and-content.atom.xml": summaryAndContent,
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

/** The seeded Sources' live hosts (migration 0008), each answered with its fixture capture. */
const LIVE: [prefix: string, fixture: string][] = [
  ["https://export.arxiv.org/api/query?", "arxiv-serving.atom.xml"],
  ["https://huggingface.co/api/daily_papers?date=", "hf-daily-papers-2026-11-13.json"],
  ["https://modal.com/blog/atom.xml", "modal-blog.atom.xml"],
  ["https://vllm.ai/blog/rss.xml", "vllm-blog-2026-11-17.rss.xml"],
  ["https://github.com/vllm-project/vllm/releases.atom", "vllm-releases-2026-11-17.atom.xml"],
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

/** Retry waits are short in tests unless one sets its own. */
const DEFAULT_OVERRIDES: Partial<FetchConfig> = { backoff_ms: 1 };
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
