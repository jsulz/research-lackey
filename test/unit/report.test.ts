import { describe, expect, it } from "vitest";
import {
  findingId,
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
        "- [v0.12.0](https://github.com/vllm-project/vllm/releases/tag/v0.12.0)",
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
});
