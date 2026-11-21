import { describe, expect, it } from "vitest";
import { previousUtcDay, sourceRequestUrl } from "../../src/core/source-url";

const HF = "https://huggingface.co/api/daily_papers?date={date}";

describe("sourceRequestUrl", () => {
  it.each([
    ["mid-day", "2026-11-22T12:00:03Z", "2026-11-21"],
    ["the first second of a UTC day", "2026-11-22T00:00:00Z", "2026-11-21"],
    ["the last second of a UTC day", "2026-11-22T23:59:59Z", "2026-11-21"],
    ["the first of a month", "2026-12-01T12:00:00Z", "2026-11-30"],
    ["the first of a year", "2027-01-01T00:30:00Z", "2026-12-31"],
    ["1 March of a leap year", "2028-03-01T12:00:00Z", "2028-02-29"],
    ["1 March of a common year", "2027-03-01T12:00:00Z", "2027-02-28"],
  ])("resolves {date} to the previous UTC day: %s", (_name, startedAt, day) => {
    expect(sourceRequestUrl(HF, new Date(startedAt))).toEqual({
      ok: true,
      url: `https://huggingface.co/api/daily_papers?date=${day}`,
    });
  });

  it("uses the UTC day, whatever offset the Run start was written with", () => {
    // 01:00 on the 22nd at +02:00 is 23:00 UTC on the 21st.
    expect(previousUtcDay(new Date("2026-11-22T01:00:00+02:00"))).toBe("2026-11-20");
  });

  it("resolves every {date} in the URL", () => {
    expect(
      sourceRequestUrl(
        "https://example.com/{date}/feed?d={date}",
        new Date("2026-11-22T12:00:00Z"),
      ),
    ).toEqual({ ok: true, url: "https://example.com/2026-11-21/feed?d=2026-11-21" });
  });

  it("returns a URL with no placeholder exactly as stored", () => {
    const url =
      "https://export.arxiv.org/api/query?search_query=%28cat:cs.DC+OR+cat:cs.PF%29+AND+abs:%22KV+cache%22&max_results=50";
    expect(sourceRequestUrl(url, new Date("2026-11-22T12:00:00Z"))).toEqual({ ok: true, url });
  });

  it.each([
    ["a Source with no URL", null, "Source has no URL"],
    ["a blank URL", "  ", "Source has no URL"],
    [
      "a placeholder it does not know",
      "https://example.com/?d={Date}",
      "Source URL has an unknown placeholder {Date}",
    ],
    [
      "an empty placeholder",
      "https://example.com/?d={}",
      "Source URL has an unknown placeholder {}",
    ],
    ["a relative URL", "/blog/atom.xml", "Source URL does not parse"],
    ["a host-only string", "example.com/feed", "Source URL does not parse"],
    ["a file URL", "file:///etc/passwd", "Source URL scheme file: is not http or https"],
    ["an ftp URL", "ftp://example.com/feed.xml", "Source URL scheme ftp: is not http or https"],
    [
      "a javascript URL",
      "javascript:alert(1)",
      "Source URL scheme javascript: is not http or https",
    ],
  ])("rejects %s", (_name, url, reason) => {
    expect(sourceRequestUrl(url, new Date("2026-11-22T12:00:00Z"))).toEqual({ ok: false, reason });
  });

  it("rejects a Run start that is not a date", () => {
    expect(sourceRequestUrl(HF, new Date("nope"))).toEqual({
      ok: false,
      reason: "Run start is not a date",
    });
  });
});
