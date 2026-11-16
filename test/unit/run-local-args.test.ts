import { describe, expect, it } from "vitest";
import { parseRunLocalArgs } from "../../scripts/run-local-args";

describe("parseRunLocalArgs", () => {
  it("reads --topic and defaults the port to 8787", () => {
    expect(parseRunLocalArgs(["--topic", "ai-infra"])).toEqual({
      ok: true,
      topic: "ai-infra",
      port: 8787,
    });
  });

  it("reads --port", () => {
    expect(parseRunLocalArgs(["--topic", "ai-infra", "--port", "8799"])).toMatchObject({
      ok: true,
      port: 8799,
    });
  });

  it.each([
    ["no --topic", []],
    ["--topic without a value", ["--topic"]],
    ["an invalid Topic ID", ["--topic", "AI Infra"]],
    ["a non-numeric port", ["--topic", "ai-infra", "--port", "abc"]],
    ["an unknown flag", ["--topic", "ai-infra", "--remote"]],
  ])("rejects %s", (_label, argv) => {
    expect(parseRunLocalArgs(argv)).toMatchObject({ ok: false });
  });
});
