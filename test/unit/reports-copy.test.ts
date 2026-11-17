import { describe, expect, it } from "vitest";
import {
  fetchReports,
  formatCost,
  formatDuration,
  formatTokens,
  type PublicReport,
} from "../../src/web/reports";

describe("formatCost", () => {
  it("shows dollars to 2 decimal places", () => {
    expect(formatCost(0.0312)).toBe("$0.03");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0)).toBe("$0.00");
  });

  it('shows a non-zero cost that would round to $0.00 as "< $0.01"', () => {
    expect(formatCost(0.0008249)).toBe("< $0.01");
    expect(formatCost(0.0049)).toBe("< $0.01");
    expect(formatCost(0.005)).toBe("$0.01");
  });
});

describe("formatDuration", () => {
  it("uses seconds, then minutes and seconds, then hours and minutes", () => {
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(87_000)).toBe("1m 27s");
    expect(formatDuration(3_723_000)).toBe("1h 2m");
  });
});

describe("formatTokens", () => {
  it("lists input and output tokens per model", () => {
    expect(
      formatTokens([
        { model: "claude-haiku-5-5", input: 2649, output: 1120 },
        { model: "claude-sonnet-5-5", input: 18234, output: 2210 },
      ]),
    ).toBe("claude-haiku-5-5: 2,649 in, 1,120 out; claude-sonnet-5-5: 18,234 in, 2,210 out");
  });

  it('reads "No model calls" when the Run used no model', () => {
    expect(formatTokens([])).toBe("No model calls");
  });
});

const REPORT: PublicReport = {
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
  finding_count: 3,
  summary: "Three serving developments.",
};

function answering(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("fetchReports", () => {
  it("returns the Reports from GET /api/reports", async () => {
    await expect(fetchReports(answering(200, [REPORT]))).resolves.toEqual([REPORT]);
  });

  it("rejects on a non-2xx response so the page shows the error state", async () => {
    await expect(fetchReports(answering(500, {}))).rejects.toThrow("500");
  });

  it("rejects a row missing a contract field", async () => {
    const { cost_usd: _dropped, ...partial } = REPORT;
    await expect(fetchReports(answering(200, [partial]))).rejects.toThrow("unexpected shape");
  });

  it("rejects a malformed tokens entry", async () => {
    const bad = { ...REPORT, tokens: [{ model: "m", input: "12" }] };
    await expect(fetchReports(answering(200, [bad]))).rejects.toThrow("unexpected shape");
  });
});
