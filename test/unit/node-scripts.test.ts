import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// These scripts run under plain Node with type stripping, not Vite: every module they reach must
// resolve as Node resolves it (value imports name the `.ts` file). With no arguments each prints
// its usage and exits 2 before doing any work.
describe("Node entry points load", () => {
  it.each([
    ["scripts/run-local.ts", "usage: npm run run:local"],
    ["scripts/replay.ts", "usage: npm run replay"],
    ["scripts/review-stub.ts", "usage: npm run review-stub"],
  ])("%s prints its usage", (script, usage) => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });

    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).toContain(usage);
    expect(result.status).toBe(2);
  });
});
