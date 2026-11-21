import { describe, expect, it } from "vitest";
import { allFailedReason, MAX_FAILURE_REASON } from "../../src/core/polls";

describe("allFailedReason", () => {
  it("names every Source and its reason, in order", () => {
    expect(
      allFailedReason([
        { source_id: "a", failure_reason: "HTTP 403" },
        { source_id: "b", failure_reason: "timed out" },
      ]),
    ).toBe("Every Source failed (2): a: HTTP 403; b: timed out");
  });

  it("trims long reasons to an equal share so every Source stays within the cap", () => {
    const failed = Array.from({ length: 13 }, (_, i) => ({
      source_id: `source-${i}`,
      failure_reason: `${"x".repeat(500)} end-${i}`,
    }));
    const reason = allFailedReason(failed);

    expect(reason.length).toBeLessThanOrEqual(MAX_FAILURE_REASON);
    for (const f of failed) expect(reason).toContain(`${f.source_id}: x`);
    expect(reason).toContain("…");
  });

  it("keeps short reasons whole when others are long", () => {
    const reason = allFailedReason([
      { source_id: "short", failure_reason: "HTTP 404" },
      { source_id: "long", failure_reason: "y".repeat(5000) },
    ]);

    expect(reason.length).toBeLessThanOrEqual(MAX_FAILURE_REASON);
    expect(reason).toContain("short: HTTP 404;");
  });
});
