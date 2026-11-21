import { describe, expect, it } from "vitest";
import type { ReportDocument } from "../../src/core/ports";
import {
  ARXIV_ATTRIBUTION,
  findingId,
  publicReportDetail,
  reportAttributions,
  reportId,
  reportJsonSchema,
  reportMarkdown,
  validateReport,
} from "../../src/core/report";

const REFS = ["I1", "I2", "I3"];

const VALID = {
  summary: "Two serving advances this week.",
  key_developments: [
    {
      title: "Speculative decoding in vLLM",
      what_is_new: "vLLM 0.12 ships EAGLE-3.",
      why_it_matters: "Lower latency per token.",
      sources: ["I1", "I3"],
    },
    {
      title: "Disaggregated prefill",
      what_is_new: "A paper splits prefill and decode.",
      why_it_matters: "Better GPU utilization.",
      sources: ["I2"],
    },
  ],
  implications: "Serving stacks converge on speculative decoding.",
  worth_watching: ["EAGLE-3 adoption", "Prefill disaggregation in SGLang"],
};

describe("validateReport", () => {
  it("accepts a document matching the schema", () => {
    expect(validateReport(VALID, REFS)).toEqual({ ok: true, report: VALID });
  });

  it("accepts zero key developments (a Report with no Findings)", () => {
    const empty = { ...VALID, key_developments: [] };
    expect(validateReport(empty, REFS)).toEqual({ ok: true, report: empty });
  });

  it("drops repeated source refs within a Finding", () => {
    const [first, ...rest] = VALID.key_developments;
    const repeated = {
      ...VALID,
      key_developments: [{ ...first, sources: ["I1", "I1", "I3"] }, ...rest],
    };
    const result = validateReport(repeated, REFS);
    expect(result.ok && result.report.key_developments[0]?.sources).toEqual(["I1", "I3"]);
  });

  it.each([
    ["not an object", "nope", /object/],
    ["missing summary", { ...VALID, summary: undefined }, /summary/],
    ["blank summary", { ...VALID, summary: "  " }, /summary/],
    ["key_developments not an array", { ...VALID, key_developments: {} }, /key_developments/],
    [
      "a Finding without why_it_matters",
      { ...VALID, key_developments: [{ ...VALID.key_developments[0], why_it_matters: "" }] },
      /why_it_matters/,
    ],
    [
      "a Finding citing no Item",
      { ...VALID, key_developments: [{ ...VALID.key_developments[0], sources: [] }] },
      /sources/,
    ],
    [
      "a Finding citing an unknown Item",
      { ...VALID, key_developments: [{ ...VALID.key_developments[0], sources: ["I9"] }] },
      /I9/,
    ],
    ["implications not a string", { ...VALID, implications: 3 }, /implications/],
    ["worth_watching with a non-string", { ...VALID, worth_watching: ["a", 2] }, /worth_watching/],
  ])("rejects %s", (_name, doc, reason) => {
    const result = validateReport(doc, REFS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe("reportJsonSchema", () => {
  it("limits each Finding's sources to the refs given, and closes every object", () => {
    const schema = reportJsonSchema(REFS) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        key_developments: {
          items: {
            additionalProperties: boolean;
            properties: { sources: { items: { enum: string[] } } };
          };
        };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "summary",
      "key_developments",
      "implications",
      "worth_watching",
    ]);
    const finding = schema.properties.key_developments.items;
    expect(finding.additionalProperties).toBe(false);
    expect(finding.properties.sources.items.enum).toEqual(REFS);
  });
});

describe("Report and Finding IDs", () => {
  it("derive from the Run ID, so a retried publish writes the same rows", () => {
    expect(reportId("topic-ai-infra-20261116T1200Z")).toBe("rpt_topic-ai-infra-20261116T1200Z");
    expect(findingId("rpt_topic-ai-infra-20261116T1200Z", 2)).toBe(
      "fnd_topic-ai-infra-20261116T1200Z_2",
    );
  });
});

describe("reportMarkdown", () => {
  it("renders the four sections with each Finding's source links", () => {
    const md = reportMarkdown({
      id: "rpt_x",
      run_id: "x",
      topic: { id: "ai-infra", name: "AI infrastructure platforms" },
      generated_at: "2026-11-16T12:01:31Z",
      model: "claude-haiku-5-5",
      summary: VALID.summary,
      findings: [
        {
          id: "fnd_x_1",
          position: 1,
          title: "Speculative decoding in vLLM",
          what_is_new: "vLLM 0.12 ships EAGLE-3.",
          why_it_matters: "Lower latency per token.",
          items: [
            {
              source_id: "vllm-releases",
              item_key: "v0.12.0",
              title: "v0.12.0",
              url: "https://github.com/vllm-project/vllm/releases/tag/v0.12.0",
            },
          ],
        },
      ],
      implications: VALID.implications,
      worth_watching: VALID.worth_watching,
    });
    expect(md).toBe(
      [
        "# AI infrastructure platforms",
        "",
        "Generated 2026-11-16T12:01:31Z",
        "",
        "## Summary",
        "",
        "Two serving advances this week.",
        "",
        "## Key developments",
        "",
        "### Speculative decoding in vLLM",
        "",
        "**What is new:** vLLM 0.12 ships EAGLE-3.",
        "",
        "**Why it matters:** Lower latency per token.",
        "",
        "Sources:",
        "- [v0\\.12\\.0](https://github.com/vllm-project/vllm/releases/tag/v0.12.0)",
        "",
        "## Technical and competitive implications",
        "",
        "Serving stacks converge on speculative decoding.",
        "",
        "## Worth watching",
        "",
        "- EAGLE-3 adoption",
        "- Prefill disaggregation in SGLang",
        "",
      ].join("\n"),
    );
  });

  it("escapes every ASCII punctuation character in feed-controlled link text", () => {
    const lines = sourceLines(
      reportMarkdown(
        docWith([item("a](javascript:alert(1)) [b] \\ `c` *d* _e_ <script>&", URL_OK)]),
      ),
    );
    expect(lines).toEqual([
      "- [a\\]\\(javascript\\:alert\\(1\\)\\) \\[b\\] \\\\ \\`c\\` \\*d\\* \\_e\\_ \\<script\\>\\&](https://example.com/a)",
    ]);
  });

  it("collapses whitespace in link text so a title can't break the line or the link", () => {
    const lines = sourceLines(reportMarkdown(docWith([item("one\n\n## two\r\n\tthree", URL_OK)])));
    expect(lines).toEqual(["- [one \\#\\# two three](https://example.com/a)"]);
  });

  it("keeps link text inside one link under adversarial repetition", () => {
    const title = "]".repeat(10_000);
    const [line] = sourceLines(reportMarkdown(docWith([item(title, URL_OK)])));
    expect(line).toBe(`- [${"\\]".repeat(10_000)}](https://example.com/a)`);
  });

  it("percent-encodes characters that could end or break a link destination", () => {
    const lines = sourceLines(
      reportMarkdown(
        docWith([
          item("t", "https://example.com/a(b)c"),
          item("t", "https://example.com/x?q=a b&r=\"'<>\\"),
          item("t", "https://example.com/p) [x](javascript:alert(1)"),
          item("t", "https://example.com/c\u0001d#f g"),
          item("t", "https://example.com/search?q=a&copy;b&amp;c"),
        ]),
      ),
    );
    expect(lines).toEqual([
      "- [t](https://example.com/a%28b%29c)",
      "- [t](https://example.com/x?q=a%20b&amp;r=%22%27%3C%3E%5C)",
      "- [t](https://example.com/p%29%20[x]%28javascript:alert%281%29)",
      "- [t](https://example.com/c%01d#f%20g)",
      // Renderers decode entities in destinations, so `&` is written as `&amp;`.
      "- [t](https://example.com/search?q=a&amp;copy;b&amp;amp;c)",
    ]);
    for (const l of lines) expect(l.match(/\]\(/g)).toHaveLength(1);
  });

  it.each([
    ["javascript:alert(1)"],
    [" JavaScript:alert(1)"],
    ["java\nscript:alert(1)"],
    ["JAVA\tSCRIPT:alert(1)"],
    ["data:text/html,<b>hi</b>"],
    ["ftp://example.com/file"],
    ["/relative/path"],
    [""],
    ["not a url"],
  ])("renders a source whose URL %j is not http or https as plain text", (url) => {
    const lines = sourceLines(reportMarkdown(docWith([item("Paper [1]", url)])));
    expect(lines).toEqual(["- ` Paper [1] `"]);
  });

  it("writes a plain-text title as a code span, so GFM can't autolink it", () => {
    const lines = sourceLines(
      reportMarkdown(
        docWith([
          item("papers@example.com", "mailto:papers@example.com"),
          item("mailto:a@b.com <b>x</b>", "javascript:x"),
          item("a`b``c", "javascript:x"),
          item("`edge`", "javascript:x"),
          item("multi\nline  title", "javascript:x"),
        ]),
      ),
    );
    expect(lines).toEqual([
      "- ` papers@example.com `",
      "- ` mailto:a@b.com <b>x</b> `",
      "- ``` a`b``c ```",
      "- `` `edge` ``",
      "- ` multi line title `",
    ]);
  });

  it("keeps a plain-text title in one code span under adversarial repetition", () => {
    const [line] = sourceLines(reportMarkdown(docWith([item("`".repeat(10_000), "javascript:x")])));
    expect(line).toBe(`- ${"`".repeat(10_001)} ${"`".repeat(10_000)} ${"`".repeat(10_001)}`);
  });

  it("handles a plain-text title with very many backtick runs", () => {
    const [line] = sourceLines(
      reportMarkdown(docWith([item("`a".repeat(200_000), "javascript:x")])),
    );
    expect(line?.startsWith("- `` `a`a")).toBe(true);
  });

  it("accepts http and https in any case, writing the normalized URL", () => {
    const lines = sourceLines(
      reportMarkdown(
        docWith([item("a", "HTTPS://Example.com/A"), item("b", "  http://example.com/b  ")]),
      ),
    );
    expect(lines).toEqual(["- [a](https://example.com/A)", "- [b](http://example.com/b)"]);
  });

  it("adds an Attributions section after Worth watching only when there are attributions", () => {
    const withLine = reportMarkdown({
      ...docWith([item("a", URL_OK)]),
      attributions: [ARXIV_ATTRIBUTION],
    });
    expect(withLine.endsWith(`## Attributions\n\n${ARXIV_ATTRIBUTION}\n`)).toBe(true);
    expect(reportMarkdown({ ...docWith([item("a", URL_OK)]), attributions: [] })).not.toContain(
      "Attributions",
    );
    expect(reportMarkdown(docWith([item("a", URL_OK)]))).not.toContain("Attributions");
  });
});

const URL_OK = "https://example.com/a";

function item(title: string, url: string, item_key = "k") {
  return { source_id: "s", item_key, title, url };
}

function docWith(items: ReturnType<typeof item>[]): ReportDocument {
  return {
    id: "rpt_x",
    run_id: "x",
    topic: { id: "ai-infra", name: "AI infrastructure platforms" },
    generated_at: "2026-11-16T12:01:31Z",
    model: "claude-haiku-5-5",
    summary: "S",
    findings: [
      { id: "fnd_x_1", position: 1, title: "F", what_is_new: "N", why_it_matters: "W", items },
    ],
    implications: "I",
    worth_watching: [],
  };
}

/** The source lines of the first Finding. */
function sourceLines(md: string): string[] {
  const lines = md.split("\n");
  const start = lines.indexOf("Sources:") + 1;
  const end = lines.indexOf("", start);
  return lines.slice(start, end);
}

describe("reportAttributions", () => {
  it("credits arXiv when any Finding cites an Item whose key starts with arxiv:", () => {
    const doc = docWith([
      item("a", URL_OK, "https://blog/x"),
      item("b", URL_OK, "arxiv:2611.17097"),
    ]);
    expect(reportAttributions(doc.findings)).toEqual([ARXIV_ATTRIBUTION]);
  });

  it("returns an empty list when no Finding cites an arXiv Item", () => {
    const doc = docWith([
      item("a", URL_OK, "https://arxiv.org/abs/1"),
      item("b", URL_OK, "xarxiv:1"),
    ]);
    expect(reportAttributions(doc.findings)).toEqual([]);
  });

  it("has the arXiv line from the API contract", () => {
    expect(ARXIV_ATTRIBUTION).toBe(
      "Thank you to arXiv for use of its open access interoperability.",
    );
  });
});

describe("publicReportDetail attributions", () => {
  const row = {
    id: "rpt_x",
    topic: { id: "ai-infra", name: "AI infrastructure platforms" },
    run: { id: "x", started_at: "a", ended_at: "b", duration_ms: 1 },
    tokens: [],
    cost_usd: 0,
    finding_count: 1,
    summary: "S",
  };

  it("passes on the stored attributions", () => {
    const doc = { ...docWith([item("a", URL_OK)]), attributions: [ARXIV_ATTRIBUTION] };
    expect(publicReportDetail(row, doc).attributions).toEqual([ARXIV_ATTRIBUTION]);
  });

  it("returns an empty list for a document published before attributions existed", () => {
    expect(publicReportDetail(row, docWith([item("a", URL_OK)])).attributions).toEqual([]);
  });

  it.each([[null], ["line"], [[1]], [[{ content: "x" }]]])(
    "rejects a document whose attributions is %j",
    (value) => {
      const doc = {
        ...docWith([item("a", URL_OK)]),
        attributions: value,
      } as unknown as ReportDocument;
      expect(() => publicReportDetail(row, doc)).toThrow("attributions");
    },
  );
});
