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

  it("reads every entry and link when Atom is bound to both the default namespace and a prefix", () => {
    const text = `<a:feed xmlns:a="${ATOM_NS}" xmlns="${ATOM_NS}">
      <a:entry><a:id>1</a:id><a:link rel="self" href="https://example.com/self"/><link href="https://example.com/alt"/></a:entry>
      <entry><id>2</id><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Second <b>entry</b></div></title></entry>
      <a:entry><a:id>3</a:id><a:title>Third</a:title></a:entry>
    </a:feed>`;
    expect(parseFeed("atom", text).map((i) => [i.externalId, i.url, i.title])).toEqual([
      ["1", "https://example.com/alt", ""],
      ["2", "", "Second entry"],
      ["3", "", "Third"],
    ]);
  });

  it("reads a prefix that contains a dot", () => {
    const text = `<a.b:feed xmlns:a.b="${ATOM_NS}"><a.b:entry><a.b:id>urn:x:1</a.b:id><a.b:link href="https://example.com/1"/></a.b:entry></a.b:feed>`;
    expect(parseFeed("atom", text)).toEqual([
      expect.objectContaining({ externalId: "urn:x:1", url: "https://example.com/1" }),
    ]);
  });

  it("reads an unqualified feed that declares an Atom prefix it does not use, as before", () => {
    const text = `<feed xmlns:a="${ATOM_NS}"><entry><id>urn:x:1</id><title>Unqualified</title></entry></feed>`;
    expect(parseFeed("atom", text)).toEqual([
      expect.objectContaining({ externalId: "urn:x:1", title: "Unqualified" }),
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
      "a search element",
      `<div ${XHTML}>Intro<search>Find papers</search>End</div>`,
      "Intro Find papers End",
    ],
    [
      "script, style, svg and template bodies",
      `<div ${XHTML}><style>.note { color: red; }</style><p>Results</p><script>alert(1)</script><template>t</template><svg xmlns="http://www.w3.org/2000/svg"><title>icon</title></svg></div>`,
      "Results",
    ],
    [
      "a center element",
      `<div ${XHTML}>before<center>centered</center>after</div>`,
      "before centered after",
    ],
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
// The `-2026-11-22` rows are the wave 2 Sources' captures, computed when they were added.
const FIXTURE_DIGESTS = [
  [
    "arxiv-serving.atom.xml",
    "atom",
    50,
    "a35cd89ba2afdc7eb656406e785417290b44a80210d7ad626e897132eb451721",
  ],
  [
    "arxiv-training-2026-11-22.atom.xml",
    "atom",
    50,
    "6bb7bff9e8e79d3589419da6e8e321a15e78ff2e7cbdfb5ac4b2ac82b082c226",
  ],
  [
    "cloudflare-workers-ai-2026-11-22.rss.xml",
    "rss2",
    20,
    "3605d36a4eb8719686ec646119be4743aa13fdce42a0a7ccb2607e9073348e4d",
  ],
  [
    "google-cloud-ai-infra-2026-11-22.rss.xml",
    "rss2",
    20,
    "bb771d4f34b562e6db2fda812bbaf83d86cfd9cc0e84b917355a42a6e9701bc5",
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
    "nvidia-inference-2026-11-22.atom.xml",
    "atom",
    84,
    "8cb3756136bc2c75187a150cc22ee534ce8e293e51655a61d657866dc300dedc",
  ],
  [
    "pytorch-blog-2026-11-22.rss.xml",
    "rss2",
    10,
    "eb9e1e0c710eebdffb3e37ec0649562917da798231a034c9ce6d5cedba998126",
  ],
  [
    "semianalysis-2026-11-22.rss.xml",
    "rss2",
    20,
    "267035d72417ea8ca847b08b20fd27d26e3e3d816f587316c088ac96fd54fea4",
  ],
  [
    "sglang-releases-2026-11-22.atom.xml",
    "atom",
    10,
    "7eee438e07fa114dd3a512b6c979fd3483fca66c5741865d6dc3b26db653d291",
  ],
  [
    "summary-and-content.atom.xml",
    "atom",
    2,
    "6743361d9bbe5d012b56c2c6dc8f8ae8265d47bcc125efb82c5d28b21ad197d6",
  ],
  [
    "together-blog-2026-11-22.rss.xml",
    "rss2",
    100,
    "3bd4cef5d102e79cf44815f2e47770079588bffdeb268d26bfaa1406a9f76573",
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

// Captured from the live feeds on 2026-11-22. `semianalysis` has its `content:encoded` bodies
// removed (the RSS parser does not read them). Email addresses in `semianalysis`,
// `cloudflare-workers-ai` and `google-cloud-ai-infra` are replaced; the rest are as served.
describe("parseFeed, the wave 2 Sources' captures", () => {
  it.each([
    [
      "arxiv-training-2026-11-22.atom.xml",
      "atom",
      50,
      "http://arxiv.org/abs/2611.26156v1",
      "https://arxiv.org/abs/2611.26156v1",
      "Towards Scale-Up Networking: Challenges and Open Questions",
      "2026-11-19T14:12:24.000Z",
      0,
    ],
    [
      "pytorch-blog-2026-11-22.rss.xml",
      "rss2",
      10,
      "https://pytorch.org/?p=211820",
      "https://pytorch.org/blog/2026-pytorch-foundation-contributor-awards/",
      "Celebrating the 2026 PyTorch Foundation Contributor Award Winners and Nominees",
      "2026-11-16T20:16:55.000Z",
      0,
    ],
    [
      "nvidia-inference-2026-11-22.atom.xml",
      "atom",
      84,
      "https://developer.nvidia.com/blog/?p=125544",
      "https://developer.nvidia.com/blog/build-tool-calling-parsers-in-rust-with-ai-agents/",
      "Build Tool-Calling Parsers in Rust with AI Agents",
      "2026-11-19T16:30:46.000Z",
      0,
    ],
    [
      "cloudflare-workers-ai-2026-11-22.rss.xml",
      "rss2",
      20,
      "01M7R89D5X67THE8N5T2YSWARZ",
      "https://blog.cloudflare.com/open-clairic/",
      "An updated Clairic and Clairic-flash are now open-weight, from the new Workers AI Superintelligence team",
      "2026-11-18T22:00:00.000Z",
      0,
    ],
    [
      "together-blog-2026-11-22.rss.xml",
      "rss2",
      100,
      "https://www.together.ai/blog/security-event-prompt-leakage-for-requests-in-june-and-july-of-2026",
      "https://www.together.ai/blog/security-event-prompt-leakage-for-requests-in-june-and-july-of-2026",
      "Security event: Prompt leakage for requests in June and July of 2026",
      "2026-11-21T00:00:00.000Z",
      10,
    ],
    [
      "google-cloud-ai-infra-2026-11-22.rss.xml",
      "rss2",
      20,
      "https://cloud.google.com/blog/products/storage-data-transfer/cost-effective-ai-context-extraction-from-unstructured-gcs-data/",
      "https://cloud.google.com/blog/products/storage-data-transfer/cost-effective-ai-context-extraction-from-unstructured-gcs-data/",
      "Introducing object enrichments: Transform unstructured data into agent-ready context",
      "2026-11-19T17:00:00.000Z",
      0,
    ],
    [
      "sglang-releases-2026-11-22.atom.xml",
      "atom",
      10,
      "tag:github.com,2008:Repository/740303686/router-v0.1.0",
      "https://github.com/sgl-project/sglang/releases/tag/router-v0.1.0",
      "router-v0.1.0",
      "2026-11-18T00:34:15.000Z",
      0,
    ],
    [
      "semianalysis-2026-11-22.rss.xml",
      "rss2",
      20,
      "https://newsletter.semianalysis.com/p/nvidia-and-the-world-without-jensen",
      "https://newsletter.semianalysis.com/p/nvidia-and-the-world-without-jensen",
      "Nvidia and the World Without Jensen",
      "2026-11-12T18:06:26.000Z",
      0,
    ],
  ] as const)(
    "%s parses to Items, each with an id, an https link and a date",
    (name, format, count, externalId, url, title, publishedAt, untitled) => {
      const items = parseFeed(format, fixture(name));

      expect(items).toHaveLength(count);
      expect(items[0]).toMatchObject({ externalId, url, title, publishedAt });
      expect(new Set(items.map((i) => i.externalId)).size).toBe(count);
      for (const item of items) {
        expect(item.url, item.externalId).toMatch(/^https:\/\//);
        expect(Number.isNaN(Date.parse(item.publishedAt ?? "")), item.externalId).toBe(false);
      }
      // Together's feed serves 10 entries with an empty <title>; every other entry has one.
      expect(items.filter((i) => (i.title ?? "").trim() === "")).toHaveLength(untitled);
    },
  );
});

describe("parseFeed, committed fixtures", () => {
  it.each(FIXTURE_DIGESTS)(
    "%s parses to the same Items as before",
    (name, format, count, digest) => {
      const items = parseFeed(format, fixture(name));
      expect(items).toHaveLength(count);
      expect(createHash("sha256").update(JSON.stringify(items)).digest("hex")).toBe(digest);
    },
  );

  it("holds no email address except the redaction placeholder", () => {
    // Captured before this check, with commit authors' addresses in release notes.
    const exempt = ["vllm-releases-2026-11-17.atom.xml"];
    const dir = path.join(import.meta.dirname, "../../fixtures/feeds");
    const address = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
    for (const name of readdirSync(dir).filter((f) => !exempt.includes(f))) {
      const others = (fixture(name).match(address) ?? []).filter(
        (found) => found !== "redacted@example.invalid",
      );
      expect(others.length, name).toBe(0);
    }
  });

  it("covers every committed fixture", () => {
    const files = readdirSync(path.join(import.meta.dirname, "../../fixtures/feeds")).sort();
    expect(FIXTURE_DIGESTS.map(([name]) => name)).toEqual(files);
  });
});
