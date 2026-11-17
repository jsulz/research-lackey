import { describe, expect, it } from "vitest";
import { parseReplayArgs } from "../../scripts/replay-args";

const BASE = ["--run", "manual-ai-infra-20261117T043449Z", "--from", "synthesis"];

describe("parseReplayArgs", () => {
  it("reads --run, --from and --config, and defaults the port to 8787", () => {
    expect(parseReplayArgs([...BASE, "--config", "alt.ts"])).toEqual({
      ok: true,
      run: "manual-ai-infra-20261117T043449Z",
      from: "synthesis",
      config: "alt.ts",
      port: 8787,
    });
  });

  it("reads --port", () => {
    expect(parseReplayArgs([...BASE, "--config", "alt.json", "--port", "8799"])).toMatchObject({
      ok: true,
      port: 8799,
    });
  });

  it.each([
    ["no --run", ["--from", "triage", "--config", "a.ts"]],
    ["no --from", ["--run", "r1", "--config", "a.ts"]],
    ["no --config", ["--run", "r1", "--from", "triage"]],
    ["--from fetch", ["--run", "r1", "--from", "fetch", "--config", "a.ts"]],
    ["a Run ID with a quote", ["--run", "r1'--", "--from", "triage", "--config", "a.ts"]],
    ["a flag without a value", [...BASE, "--config"]],
    ["an unknown flag", [...BASE, "--config", "a.ts", "--remote", "x"]],
    ["a non-numeric port", [...BASE, "--config", "a.ts", "--port", "abc"]],
  ])("rejects %s", (_label, argv) => {
    expect(parseReplayArgs(argv)).toMatchObject({ ok: false });
  });
});
