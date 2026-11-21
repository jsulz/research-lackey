import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// These scripts run under plain Node with type stripping, not Vite: every module they reach must
// resolve as Node resolves it (value imports name the `.ts` file). With no arguments each prints
// its usage and exits 2 before doing any work. `sources` reads production when given no arguments,
// so it gets an unknown flag instead.
describe("Node entry points load", () => {
  it.each([
    ["scripts/run-local.ts", [], "usage: npm run run:local"],
    ["scripts/replay.ts", [], "usage: npm run replay"],
    ["scripts/review-stub.ts", [], "usage: npm run review-stub"],
    ["scripts/sources.ts", ["--no-such-flag"], "usage: npm run sources"],
  ])("%s prints its usage", (script, args, usage) => {
    // An empty PATH: no script can start `npx`, so none can reach Wrangler or the network.
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });

    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).toContain(usage);
    expect(result.status).toBe(2);
  });
});
