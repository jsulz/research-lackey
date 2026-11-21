import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

describe("parseFeed, identifiers and malformed entries", () => {
  it("keeps internal whitespace in GUIDs and links, trimming only the ends", () => {
    const text = `<rss><channel>
      <item><guid> a  b </guid><link>https://example.com/x  y</link><title>One</title></item>
      <item><guid>a b</guid><title>Two</title></item></channel></rss>`;
    const items = parseFeed("rss2", text);
    expect(items.map((i) => i.externalId)).toEqual(["a  b", "a b"]);
    expect(items[0]?.url).toBe("https://example.com/x  y");
  });

  it.each([
    ["rss2", "<rss><channel><item/></channel></rss>"],
    ["rss2", "<rss><channel><item><description>no id</description></item></channel></rss>"],
    ["atom", '<feed xmlns="http://www.w3.org/2005/Atom"><entry></entry></feed>'],
    ["hf_daily_papers", "[{},{}]"],
    ["hf_daily_papers", '[{"title": "no paper id", "paper": {}}]'],
    ["hf_daily_papers", "[1]"],
  ] as const)("%s rejects an entry with no id, link or paper ID: %s", (format, text) => {
    expect(() => parseFeed(format, text)).toThrow(/entry 1/);
  });
});

describe("parseFeed, malformed XML", () => {
  it.each([
    ["rss2", "<rss><channel><item><guid>x</guid></item></wrong></rss>"],
    ["atom", '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id></feed>'],
  ] as const)("%s rejects text that is not well-formed: %s", (format, text) => {
    expect(() => parseFeed(format, text)).toThrow(/not well-formed XML.*line 1/);
  });
});

describe("parseFeed, character references", () => {
  it("decodes numeric references once, so identities match however the feed escapes them", () => {
    const text = `<rss><channel>
      <item><guid>https://e.com/p?a=1&#38;b=2</guid><title>Caf&#233; &#x41;</title></item>
      <item><guid>https://e.com/p?a=1&amp;b=2</guid><title>Literal &amp;#38; stays</title></item>
    </channel></rss>`;
    const items = parseFeed("rss2", text);
    expect(items.map((i) => i.externalId)).toEqual([
      "https://e.com/p?a=1&b=2",
      "https://e.com/p?a=1&b=2",
    ]);
    expect(items.map((i) => i.title)).toEqual(["Café A", "Literal &#38; stays"]);
  });
});

const ATOM_NS = "http://www.w3.org/2005/Atom";

/** Rewrites a default-namespace Atom document so every Atom element carries the `atom:` prefix. */
function prefixAtom(text: string): string {
  return text
    .replace(/<(\/?)([A-Za-z][\w.-]*)(?=[\s/>])/g, "<$1atom:$2")
    .replace(`xmlns="${ATOM_NS}"`, `xmlns:atom="${ATOM_NS}"`);
}

describe("parseFeed, Atom elements with a namespace prefix", () => {
  it.each(["arxiv-serving.atom.xml", "summary-and-content.atom.xml", "vllm-releases.atom.xml"])(
    "%s parses to the same Items with every Atom element prefixed",
    (name) => {
      const plain = fixture(name);
      const prefixed = prefixAtom(plain);
      expect(prefixed).toMatch(/<atom:feed [^>]*xmlns:atom=/);
      expect(prefixed).not.toMatch(/<feed[\s>]/);
      expect(prefixed).not.toMatch(/<atom:(arxiv|opensearch|media):/);
      expect(parseFeed("atom", prefixed)).toEqual(parseFeed("atom", plain));
    },
  );

  it("reads a prefixed entry with any prefix name, keeping extension elements out of its fields", () => {
    const text = `<a:feed xmlns:a="${ATOM_NS}" xmlns:media="http://search.yahoo.com/mrss/">
      <a:entry>
        <a:id>urn:x:1</a:id>
        <media:title>Extension title</media:title>
        <a:title>Atom title</a:title>
        <a:link rel="alternate" href="https://example.com/1"/>
        <media:description>Extension description</media:description>
        <a:summary>Atom summary</a:summary>
        <a:updated>2026-11-20T00:00:00Z</a:updated>
      </a:entry>
    </a:feed>`;
    expect(parseFeed("atom", text)).toEqual([
      {
        externalId: "urn:x:1",
        url: "https://example.com/1",
        title: "Atom title",
        summary: "Atom summary",
        content: undefined,
        publishedAt: "2026-11-20T00:00:00.000Z",
      },
    ]);
  });

  it("does not read an extension title as the title when the Atom title is missing", () => {
    const text = `<atom:feed xmlns:atom="${ATOM_NS}" xmlns:media="http://search.yahoo.com/mrss/">
      <atom:entry><atom:id>urn:x:2</atom:id><media:title>Extension only</media:title></atom:entry>
    </atom:feed>`;
    expect(parseFeed("atom", text)[0]?.title).toBe("");
  });

  it("RSS keeps its own title and link when the channel declares the Atom and Media namespaces", () => {
    const text = `<rss xmlns:atom="${ATOM_NS}" xmlns:media="http://search.yahoo.com/mrss/"><channel>
      <atom:link rel="self" href="https://example.com/feed.xml"/>
      <item><media:title>Extension title</media:title><title>RSS title</title>
        <atom:link href="https://example.com/atom-link"/><link>https://example.com/rss-link</link></item>
    </channel></rss>`;
    expect(parseFeed("rss2", text)).toEqual([
      expect.objectContaining({ title: "RSS title", url: "https://example.com/rss-link" }),
    ]);
  });

  it.each([
    ["a non-Atom default namespace", ' xmlns="urn:example:extension"'],
    ["no default namespace", ""],
  ])("keeps unprefixed elements out of a prefixed Atom feed with %s", (_case, defaultNs) => {
    const text = `<a:feed xmlns:a="${ATOM_NS}"${defaultNs}>
      <a:entry><a:id>urn:x:1</a:id><title>Extension</title><a:title>Atom title</a:title><link href="https://example.com/ext"/></a:entry>
      <entry><id>urn:x:extension</id><title>Extension entry</title></entry>
    </a:feed>`;
    expect(parseFeed("atom", text)).toEqual([
      expect.objectContaining({ externalId: "urn:x:1", title: "Atom title", url: "" }),
    ]);
  });

  it("reads unprefixed elements as Atom when the default namespace is Atom as well", () => {
    const text = `<a:feed xmlns:a="${ATOM_NS}" xmlns="${ATOM_NS}">
      <a:entry><id>urn:x:1</id><a:title>Mixed</a:title><link href="https://example.com/1"/></a:entry></a:feed>`;
    expect(parseFeed("atom", text)).toEqual([
      expect.objectContaining({
        externalId: "urn:x:1",
        title: "Mixed",
        url: "https://example.com/1",
      }),
    ]);
  });

  it("leaves a prefix bound to another namespace alone", () => {
    const text = `<x:feed xmlns:x="http://example.com/not-atom"><x:entry><x:id>1</x:id></x:entry></x:feed>`;
    expect(() => parseFeed("atom", text)).toThrow(/no feed element/);
  });
});

describe("parseFeed, Atom XHTML text", () => {
  const XHTML = 'xmlns="http://www.w3.org/1999/xhtml"';
  function entry(fields: string): string {
    return `<feed xmlns="${ATOM_NS}"><entry><id>urn:x:1</id>${fields}</entry></feed>`;
  }

  it("reads an XHTML title, summary and content as text in document order", () => {
    const [item] = parseFeed(
      "atom",
      entry(`
        <title type="xhtml"><div ${XHTML}>Hello <b>big</b> world</div></title>
        <summary type="xhtml"><div ${XHTML}>Caf&#233; &amp; <i>more</i>!</div></summary>
        <content type="xhtml"><div ${XHTML}><p>First paragraph.</p><p>Second<br/>line</p></div></content>`),
    );
    expect(item).toMatchObject({
      title: "Hello big world",
      summary: "Café & more!",
      content: "First paragraph. Second line",
    });
  });

  it.each([
    ["nested inline elements", `<div ${XHTML}>a<b>b<i>c</i>d</b>e</div>`, "abcde"],
    ["CDATA inside XHTML", `<div ${XHTML}>x <![CDATA[<y> & z]]></div>`, "x <y> & z"],
    [
      "a quoted > in an attribute",
      `<div ${XHTML}><a title="a>b" href="#">link</a> text</div>`,
      "link text",
    ],
    [
      "a prefixed XHTML div",
      `<h:div xmlns:h="http://www.w3.org/1999/xhtml">one<h:br/>two</h:div>`,
      "one two",
    ],
    ["list items", `<div ${XHTML}><ul><li>one</li><li>two</li></ul></div>`, "one two"],
    [
      "details and summary",
      `<div ${XHTML}>Intro<details><summary>Notes</summary>Body</details>End</div>`,
      "Intro Notes Body End",
    ],
    ["a comment", `<div ${XHTML}>keep<!-- drop -->this</div>`, "keepthis"],
  ])("handles %s", (_case, xhtml, expected) => {
    const [item] = parseFeed("atom", entry(`<title type="xhtml">${xhtml}</title>`));
    expect(item?.title).toBe(expected);
  });

  it("reads an empty XHTML summary as no summary", () => {
    const [item] = parseFeed(
      "atom",
      entry(`<title>T</title><summary type="xhtml"><div ${XHTML}/></summary>`),
    );
    expect(item?.summary).toBeUndefined();
  });

  it("reads XHTML text in a prefixed Atom document, entry by entry", () => {
    const text = `<atom:feed xmlns:atom="${ATOM_NS}">
      <atom:entry><atom:id>1</atom:id><atom:title>Plain</atom:title></atom:entry>
      <atom:entry><atom:id>2</atom:id><atom:title type="xhtml"><div ${XHTML}>Rich <em>text</em></div></atom:title></atom:entry>
    </atom:feed>`;
    expect(parseFeed("atom", text).map((i) => i.title)).toEqual(["Plain", "Rich text"]);
  });
});

// sha256 of JSON.stringify(parseFeed(format, fixture)), computed on `main` at 5ab5690
// before the namespace-prefix and XHTML changes.
const FIXTURE_DIGESTS = [
  [
    "arxiv-serving.atom.xml",
    "atom",
    50,
    "a35cd89ba2afdc7eb656406e785417290b44a80210d7ad626e897132eb451721",
  ],
  [
    "hf-daily-papers-2026-11-13.json",
    "hf_daily_papers",
    34,
    "bc054c4d7346f0ff9d65c9f643626517de4e0c115c82799a50b347ae1ef60351",
  ],
  [
    "modal-blog.atom.xml",
    "atom",
    157,
    "04c2af3a9311b5f02d39b0130929aeb25f7a2ce84b16d21679d1a61645186816",
  ],
  [
    "summary-and-content.atom.xml",
    "atom",
    2,
    "6743361d9bbe5d012b56c2c6dc8f8ae8265d47bcc125efb82c5d28b21ad197d6",
  ],
  [
    "vllm-blog-2026-11-17.rss.xml",
    "rss2",
    50,
    "67f71487cae5ba3b10d2888f151e144f18ca1c337682128a33199751b67c4a89",
  ],
  [
    "vllm-blog-plus-one.rss.xml",
    "rss2",
    51,
    "787ed48353a9a3e338bdc650ac193326b8c7d099b331f119e3dba5e2612c67d8",
  ],
  [
    "vllm-blog.rss.xml",
    "rss2",
    50,
    "11a47933bc3221a1adb6591c5123f8d35a516ae070ad9a85a6ee65dddd616588",
  ],
  [
    "vllm-releases-2026-11-17.atom.xml",
    "atom",
    10,
    "5b705192570a5bdd4d59ef54b68ab0f416032ed4223c828419b6ba3c301cea1c",
  ],
  [
    "vllm-releases.atom.xml",
    "atom",
    10,
    "26e76cde4f974743d741dd1bacc59e8bce3f90bf4d0412d71e712f388f390bee",
  ],
] as const;

describe("parseFeed, committed fixtures", () => {
  it.each(FIXTURE_DIGESTS)(
    "%s parses to the same Items as before",
    (name, format, count, digest) => {
      const items = parseFeed(format, fixture(name));
      expect(items).toHaveLength(count);
      expect(createHash("sha256").update(JSON.stringify(items)).digest("hex")).toBe(digest);
    },
  );

  it("covers every committed fixture", () => {
    const files = readdirSync(path.join(import.meta.dirname, "../../fixtures/feeds")).sort();
    expect(FIXTURE_DIGESTS.map(([name]) => name)).toEqual(files);
  });
});
