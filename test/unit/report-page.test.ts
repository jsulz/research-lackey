import { describe, expect, it } from "vitest";
import { fetchReport, type PublicReportDetail, route, safeHref } from "../../src/web/report";

const DETAIL: PublicReportDetail = {
  id: "rpt_run-a",
  topic: { id: "ai-infra", name: "AI infrastructure platforms" },
  run: {
    id: "run-a",
    started_at: "2026-11-16T12:00:04Z",
    ended_at: "2026-11-16T12:01:31Z",
    duration_ms: 87000,
  },
  tokens: [{ model: "claude-haiku-5-5", input: 2649, output: 1120 }],
  cost_usd: 0.0008249,
  finding_count: 1,
  summary: "Two serving releases.",
  sections: {
    summary: "Two serving releases.",
    key_developments: [
      {
        finding_id: "fnd_run-a_1",
        title: "vLLM v0.34.0 ships",
        what_is_new: "A new scheduler.",
        why_it_matters: "Lower tail latency.",
        sources: [{ title: "v0.34.0", url: "https://github.com/vllm-project/vllm" }],
      },
    ],
    implications: "Serving cost keeps falling.",
    worth_watching: ["Scheduler benchmarks"],
  },
};

/** A fetch that answers every request with `status` and `body`, and records the URLs asked. */
function answering(status: number, body: unknown) {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, urls };
}

describe("route", () => {
  it("routes /reports/<id> to the report page with the decoded ID", () => {
    expect(route("/reports/rpt_run-a")).toEqual({ page: "report", id: "rpt_run-a" });
    expect(route("/reports/rpt_run%3Aa")).toEqual({ page: "report", id: "rpt_run:a" });
  });

  it("routes malformed report paths to the report page with no ID (not found)", () => {
    expect(route("/reports/")).toEqual({ page: "report", id: null });
    expect(route("/reports/a/b")).toEqual({ page: "report", id: null });
    expect(route("/reports/%E0%A4%A")).toEqual({ page: "report", id: null });
  });

  it("routes everything else to the homepage", () => {
    expect(route("/")).toEqual({ page: "home" });
    expect(route("/reports")).toEqual({ page: "home" });
    expect(route("/other")).toEqual({ page: "home" });
  });
});

describe("fetchReport", () => {
  it("returns the Report from GET /api/reports/<id>, with the ID encoded", async () => {
    const api = answering(200, DETAIL);
    await expect(fetchReport("rpt_run:a", api.fn)).resolves.toEqual({
      kind: "found",
      report: DETAIL,
    });
    expect(api.urls).toEqual(["/api/reports/rpt_run%3Aa"]);
  });

  it("returns not_found on 404 so the page shows the not-found state", async () => {
    const api = answering(404, { error: "not_found" });
    await expect(fetchReport("nope", api.fn)).resolves.toEqual({ kind: "not_found" });
  });

  it("rejects on any other non-2xx response so the page shows the error state", async () => {
    await expect(fetchReport("x", answering(500, {}).fn)).rejects.toThrow("500");
  });

  it("rejects a body missing a section", async () => {
    const { implications: _dropped, ...sections } = DETAIL.sections;
    const bad = { ...DETAIL, sections };
    await expect(fetchReport("x", answering(200, bad).fn)).rejects.toThrow("unexpected shape");
  });

  it("rejects a Finding with a malformed source", async () => {
    const [finding] = DETAIL.sections.key_developments;
    const bad = {
      ...DETAIL,
      sections: {
        ...DETAIL.sections,
        key_developments: [{ ...finding, sources: [{ title: "t" }] }],
      },
    };
    await expect(fetchReport("x", answering(200, bad).fn)).rejects.toThrow("unexpected shape");
  });

  it("rejects a body missing a list field", async () => {
    const { cost_usd: _dropped, ...bad } = DETAIL;
    await expect(fetchReport("x", answering(200, bad).fn)).rejects.toThrow("unexpected shape");
  });
});

describe("safeHref", () => {
  it("keeps http and https URLs", () => {
    expect(safeHref("https://vllm.ai/blog/post")).toBe("https://vllm.ai/blog/post");
    expect(safeHref("http://example.com/a?b=c")).toBe("http://example.com/a?b=c");
  });

  it("drops any other scheme and relative or malformed URLs", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("/reports/x")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});
