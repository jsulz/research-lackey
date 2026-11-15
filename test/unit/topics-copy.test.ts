import { describe, expect, it } from "vitest";
import { fetchTopics, formatLastChecked, formatUtc } from "../../src/web/topics";

describe("formatLastChecked", () => {
  it('reads "Not yet checked" when the Topic has no Run', () => {
    expect(formatLastChecked({ last_checked_at: null, last_run_status: null })).toBe(
      "Not yet checked",
    );
  });

  it("shows the UTC time and the Run status", () => {
    expect(
      formatLastChecked({
        last_checked_at: "2026-11-15T09:00:00Z",
        last_run_status: "completed_no_new_findings",
      }),
    ).toBe("Last checked 2026-11-15 09:00 UTC: No new findings");
  });
});

describe("formatUtc", () => {
  it("returns unparseable input unchanged", () => {
    expect(formatUtc("not a date")).toBe("not a date");
  });
});

describe("fetchTopics", () => {
  it("rejects on a non-2xx response so the page shows the error state", async () => {
    const fake = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchTopics(fake)).rejects.toThrow("500");
  });
});
