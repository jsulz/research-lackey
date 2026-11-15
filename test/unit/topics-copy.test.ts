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

  it("shows an unknown status from a newer API as-is", () => {
    expect(
      formatLastChecked({
        last_checked_at: "2026-11-15T09:00:00Z",
        last_run_status: "paused" as never,
      }),
    ).toBe("Last checked 2026-11-15 09:00 UTC: paused");
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

  const respond = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

  it.each([
    ["an object", {}],
    ["null", null],
    ["a null row", [null]],
    ["a row without a name", [{ id: "x", last_checked_at: null, last_run_status: null }]],
    ["a numeric time", [{ id: "x", name: "X", last_checked_at: 1, last_run_status: null }]],
  ])("rejects %s so the page shows the error state", async (_label, body) => {
    await expect(fetchTopics(respond(body))).rejects.toThrow("unexpected shape");
  });

  it("returns well-formed rows", async () => {
    const rows = [{ id: "a", name: "A", last_checked_at: null, last_run_status: null }];
    await expect(fetchTopics(respond(rows))).resolves.toEqual(rows);
  });
});
