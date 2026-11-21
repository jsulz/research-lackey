import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FixtureSourceFetcher } from "../../src/adapters/fixture-source-fetcher";
import type { Source } from "../../src/core/ports";

async function seedSources(): Promise<Source[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, topic_id, format, fixture_ref FROM sources WHERE topic_id = 'ai-infra' ORDER BY id",
  ).all<Source>();
  return results;
}

async function itemKeys(source: Pick<Source, "id" | "format" | "fixture_ref">) {
  const items = await new FixtureSourceFetcher().fetch(source as Source);
  return new Set(items.map((i) => i.url));
}

describe("seed Sources", () => {
  it("each point at a bundled fixture that parses into Items", async () => {
    const sources = await seedSources();
    expect(sources.map((s) => s.id)).toEqual([
      "arxiv-serving",
      "hf-daily-papers",
      "modal-blog",
      "vllm-blog",
      "vllm-releases",
    ]);
    for (const source of sources) {
      expect((await itemKeys(source)).size, source.id).toBeGreaterThan(0);
    }
  });

  it("have no filters, so every Item they read passes", async () => {
    const { results } = await env.DB.prepare(
      `SELECT include_keywords, exclude_keywords, exclude_title_pattern FROM sources
       WHERE topic_id = 'ai-infra'`,
    ).all();
    expect(results).toHaveLength(5);
    for (const row of results) {
      expect(row).toEqual({
        include_keywords: "[]",
        exclude_keywords: "[]",
        exclude_title_pattern: null,
      });
    }
  });

  it("can't store a keyword list that is not a JSON array", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE sources SET include_keywords = '\"llm\"' WHERE id = 'vllm-blog'",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  // The 2026-11-17 captures give production new Items to report: the entries published since
  // the earlier capture. (A feed lists a fixed number of entries, so its oldest may drop off.)
  it.each([
    ["vllm-blog", "vllm-blog.rss.xml", "vllm-blog-2026-11-17.rss.xml", 1],
    ["vllm-releases", "vllm-releases.atom.xml", "vllm-releases-2026-11-17.atom.xml", 1],
  ])(
    "%s reads its 2026-11-17 capture, %s plus new entries",
    async (id, previous, current, added) => {
      const source = (await seedSources()).find((s) => s.id === id);
      expect(source?.fixture_ref).toBe(current);
      const before = await itemKeys({
        id,
        format: source?.format ?? "atom",
        fixture_ref: previous,
      });
      const after = await itemKeys({ id, format: source?.format ?? "atom", fixture_ref: current });
      const newOnes = [...after].filter((k) => !before.has(k));
      expect(newOnes).toHaveLength(added);
    },
  );
});
