import { describe, expect, it } from "vitest";
import {
  formatReviewStub,
  PRODUCTION_BASE_URL,
  parseReviewStubArgs,
  reviewStub,
} from "../../scripts/review-stub-lib";

const REPORT = {
  id: "rpt_topic-ai-infra-20261117T1200Z",
  run: {
    id: "topic-ai-infra-20261117T1200Z",
    started_at: "2026-11-17T12:01:03.968Z",
    ended_at: "2026-11-17T12:01:24.528Z",
    duration_ms: 20560,
  },
  sections: {
    summary: "s",
    key_developments: [
      { finding_id: "fnd_topic-ai-infra-20261117T1200Z_1", title: "vLLM v0.34.0 ships" },
      { finding_id: "fnd_topic-ai-infra-20261117T1200Z_2", title: "RL on TPU v7" },
    ],
    implications: "i",
    worth_watching: [],
  },
};

const EXPECTED = `## 2026-11-17 · [rpt_topic-ai-infra-20261117T1200Z](https://lackey.jsulz.com/reports/rpt_topic-ai-infra-20261117T1200Z)

<!-- verdict: yes | no. Finding labels: new-to-me | known | noise | wrong -->
- Verdict:
- Reason:
- Findings:
  - \`fnd_topic-ai-infra-20261117T1200Z_1\` vLLM v0.34.0 ships · label:
  - \`fnd_topic-ai-infra-20261117T1200Z_2\` RL on TPU v7 · label:
`;

/** A fake `fetch` that records the URLs it was asked for and answers with one response. */
function fakeFetch(status: number, body: string) {
  const urls: string[] = [];
  const fn = async (url: string) => {
    urls.push(url);
    return new Response(body, { status });
  };
  return { fn, urls };
}

describe("formatReviewStub", () => {
  it("prints the date, link, verdict, reason and one line per Finding with an empty label", () => {
    expect(formatReviewStub(REPORT, PRODUCTION_BASE_URL)).toBe(EXPECTED);
  });

  it("keeps a multi-line title on one line", () => {
    const report = {
      ...REPORT,
      sections: {
        ...REPORT.sections,
        key_developments: [{ finding_id: "fnd_1", title: "two\nlines\t and  gaps " }],
      },
    };
    expect(formatReviewStub(report, PRODUCTION_BASE_URL)).toContain(
      "  - `fnd_1` two lines and gaps · label:\n",
    );
  });

  it("encodes the Report ID in the link", () => {
    const out = formatReviewStub({ ...REPORT, id: "rpt_a/b?c" }, "http://localhost:8787");
    expect(out).toContain("[rpt_a/b?c](http://localhost:8787/reports/rpt_a%2Fb%3Fc)");
  });

  it("says none when the Report has no Findings", () => {
    const report = { ...REPORT, sections: { ...REPORT.sections, key_developments: [] } };
    expect(formatReviewStub(report, PRODUCTION_BASE_URL)).toMatch(/- Findings: none\n$/);
  });
});

describe("parseReviewStubArgs", () => {
  it("reads the Report ID and defaults to the production base URL", () => {
    expect(parseReviewStubArgs(["rpt_x"])).toEqual({
      ok: true,
      reportId: "rpt_x",
      baseUrl: "https://lackey.jsulz.com",
    });
  });

  it("reads --base-url on either side of the ID and drops trailing slashes", () => {
    for (const argv of [
      ["--base-url", "http://localhost:8787/", "rpt_x"],
      ["rpt_x", "--base-url", "http://localhost:8787//"],
    ]) {
      expect(parseReviewStubArgs(argv)).toEqual({
        ok: true,
        reportId: "rpt_x",
        baseUrl: "http://localhost:8787",
      });
    }
  });

  it.each([
    ["no Report ID", []],
    ["two Report IDs", ["rpt_a", "rpt_b"]],
    ["--base-url without a value", ["rpt_x", "--base-url"]],
    ["a non-http base URL", ["rpt_x", "--base-url", "file:///etc"]],
    ["a base URL that does not parse", ["rpt_x", "--base-url", "lackey.jsulz.com"]],
    ["an unknown flag", ["rpt_x", "--remote"]],
  ])("rejects %s", (_label, argv) => {
    expect(parseReviewStubArgs(argv)).toMatchObject({ ok: false });
  });
});

describe("reviewStub", () => {
  it("fetches the Report from production and prints the block", async () => {
    const fetch = fakeFetch(200, JSON.stringify(REPORT));

    const result = await reviewStub(["rpt_topic-ai-infra-20261117T1200Z"], fetch.fn);

    expect(fetch.urls).toEqual([
      "https://lackey.jsulz.com/api/reports/rpt_topic-ai-infra-20261117T1200Z",
    ]);
    expect(result).toEqual({ code: 0, stdout: EXPECTED, stderr: "" });
  });

  it("fetches from --base-url and encodes the Report ID", async () => {
    const fetch = fakeFetch(200, JSON.stringify(REPORT));

    await reviewStub(["rpt_a/b", "--base-url", "http://localhost:8787/"], fetch.fn);

    expect(fetch.urls).toEqual(["http://localhost:8787/api/reports/rpt_a%2Fb"]);
  });

  it("prints the API's 404 and exits non-zero for an unknown Report ID", async () => {
    const fetch = fakeFetch(404, '{"error":"not_found"}');

    const result = await reviewStub(["rpt_nope"], fetch.fn);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'GET https://lackey.jsulz.com/api/reports/rpt_nope returned 404: {"error":"not_found"}',
    );
  });

  it("exits non-zero on a server error with an HTML body", async () => {
    const result = await reviewStub(["rpt_x"], fakeFetch(502, "<html>bad gateway</html>").fn);

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("returned 502: <html>bad gateway</html>");
  });

  it("exits non-zero when the request fails", async () => {
    const result = await reviewStub(["rpt_x"], async () => {
      throw new TypeError("fetch failed");
    });

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("fetch failed");
  });

  it.each([
    ["not JSON", "nope"],
    ["no sections", JSON.stringify({ ...REPORT, sections: undefined })],
    ["no run start", JSON.stringify({ ...REPORT, run: {} })],
    [
      "a Finding without a title",
      JSON.stringify({
        ...REPORT,
        sections: { ...REPORT.sections, key_developments: [{ finding_id: "fnd_1" }] },
      }),
    ],
  ])("exits non-zero when the body has %s", async (_label, body) => {
    const result = await reviewStub(["rpt_x"], fakeFetch(200, body).fn);

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).not.toBe("");
  });

  it("exits 2 with usage on bad arguments, before any request", async () => {
    const fetch = fakeFetch(200, "{}");

    const result = await reviewStub([], fetch.fn);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: npm run review-stub");
    expect(fetch.urls).toEqual([]);
  });
});
