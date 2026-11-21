import arxivServing from "../../fixtures/feeds/arxiv-serving.atom.xml";
import hfDailyPapers from "../../fixtures/feeds/hf-daily-papers-2026-11-13.json";
import modalBlog from "../../fixtures/feeds/modal-blog.atom.xml";
import vllmBlog from "../../fixtures/feeds/vllm-blog.rss.xml";
import vllmBlog20261117 from "../../fixtures/feeds/vllm-blog-2026-11-17.rss.xml";
import vllmBlogPlusOne from "../../fixtures/feeds/vllm-blog-plus-one.rss.xml";
import vllmReleases from "../../fixtures/feeds/vllm-releases.atom.xml";
import vllmReleases20261117 from "../../fixtures/feeds/vllm-releases-2026-11-17.atom.xml";
import { parseFeed } from "../core/feeds";
import type { RawItem, Source, SourceFetcher } from "../core/ports";

/**
 * Fixture files bundled with the Worker, by `sources.fixture_ref`. Wrangler's `Text` module rule
 * (`wrangler.jsonc` `rules`) imports each as a string; a bundler that still parses `.json` gives
 * an object, which is serialized back to text.
 */
const FIXTURES: Record<string, unknown> = {
  "arxiv-serving.atom.xml": arxivServing,
  "hf-daily-papers-2026-11-13.json": hfDailyPapers,
  "modal-blog.atom.xml": modalBlog,
  "vllm-blog.rss.xml": vllmBlog,
  "vllm-blog-2026-11-17.rss.xml": vllmBlog20261117,
  "vllm-blog-plus-one.rss.xml": vllmBlogPlusOne,
  "vllm-releases.atom.xml": vllmReleases,
  "vllm-releases-2026-11-17.atom.xml": vllmReleases20261117,
};

/**
 * Test-only: an Atom feed of 12 entries with 100,000 characters of content each, about 1.2 MB of
 * entries, shaped like a GitHub releases feed. Built on demand so no megabyte file is committed.
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

/** Fixtures generated in code, by `sources.fixture_ref`. Test-only. */
const GENERATED: Record<string, () => string> = {
  "oversized.atom.xml": oversizedFeed,
};

/** SourceFetcher that reads bundled fixture files. No network. */
export class FixtureSourceFetcher implements SourceFetcher {
  async fetch(source: Source): Promise<RawItem[]> {
    const ref = source.fixture_ref;
    if (ref === null) throw new Error(`Source ${source.id} has no fixture`);
    const generate = Object.hasOwn(GENERATED, ref) ? GENERATED[ref] : undefined;
    if (generate) return parseFeed(source.format, generate());
    if (!Object.hasOwn(FIXTURES, ref)) throw new Error(`Fixture not found: ${ref}`);
    const fixture = FIXTURES[ref];
    const text = typeof fixture === "string" ? fixture : JSON.stringify(fixture);
    return parseFeed(source.format, text);
  }
}
