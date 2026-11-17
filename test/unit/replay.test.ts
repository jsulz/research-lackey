import { describe, expect, it } from "vitest";
import { CONFIG } from "../../src/core/config";
import { canonicalJson } from "../../src/core/hashing";
import { parseRunConfig, priorStage } from "../../src/core/replay";
import { parseRunParams, replayRunId } from "../../src/core/run-ids";

const INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/;

/** A deep copy of the committed config, for tests to change. */
function copy(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(CONFIG));
}

describe("replayRunId", () => {
  it("is replay-<topic>-<UTC time in ISO 8601 basic format, to the second>", () => {
    expect(replayRunId("ai-infra", new Date("2026-11-17T05:01:02.345Z"))).toBe(
      "replay-ai-infra-20261117T050102Z",
    );
  });

  it("is a valid Workflow instance ID for the longest allowed Topic ID", () => {
    expect(replayRunId("a".repeat(76), new Date("2026-12-31T23:59:59Z"))).toMatch(INSTANCE_ID);
  });
});

describe("priorStage", () => {
  it("is the stage whose Step artifact output a Replay reuses", () => {
    expect(priorStage("triage")).toBe("dedupe");
    expect(priorStage("synthesis")).toBe("triage");
  });
});

describe("parseRunConfig", () => {
  it("accepts the committed config unchanged", () => {
    const parsed = parseRunConfig(copy());
    expect(parsed).toEqual({ ok: true, config: CONFIG });
  });

  it("keeps only known fields, so the snapshot is the effective config", () => {
    const parsed = parseRunConfig({ ...copy(), note: "extra" });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(canonicalJson(parsed.config)).toBe(canonicalJson(CONFIG));
  });

  it("accepts another Synthesis model that has a price", () => {
    const c = copy() as {
      tasks: { synthesis: { model: string } };
      prices: Record<string, unknown>;
    };
    c.tasks.synthesis.model = "claude-sonnet-5-5";
    c.prices["claude-sonnet-5-5"] = {
      standard: { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 },
    };
    const parsed = parseRunConfig(c);
    expect(parsed).toMatchObject({
      ok: true,
      config: { tasks: { synthesis: { model: "claude-sonnet-5-5" } } },
    });
  });

  const cases: [string, (c: Record<string, unknown>) => unknown][] = [
    ["a non-object", () => "config"],
    ["a missing limit", (c) => ({ ...c, triage_limit: undefined })],
    ["a zero limit", (c) => ({ ...c, synthesis_k: 0 })],
    ["a fractional limit", (c) => ({ ...c, first_poll_cap: 1.5 })],
    [
      "a missing task",
      (c) => ({ ...c, tasks: { triage: (c.tasks as { triage: unknown }).triage } }),
    ],
    [
      "an unknown effort",
      (c) => {
        (c.tasks as { triage: { effort: string } }).triage.effort = "extreme";
        return c;
      },
    ],
    [
      "a task model with no price",
      (c) => {
        (c.tasks as { synthesis: { model: string } }).synthesis.model = "claude-unknown";
        return c;
      },
    ],
    [
      "a negative price",
      (c) => {
        const prices = c.prices as Record<string, { standard: { input: number } }>;
        const haiku = prices["claude-haiku-5-5"];
        if (haiku) haiku.standard.input = -1;
        return c;
      },
    ],
    [
      "a price large enough to overflow a stage's cost",
      (c) => {
        const prices = c.prices as Record<string, { standard: { input: number } }>;
        const haiku = prices["claude-haiku-5-5"];
        if (haiku) haiku.standard.input = 1e308;
        return c;
      },
    ],
  ];
  it.each(cases)("rejects %s", (_label, change) => {
    expect(parseRunConfig(change(copy()))).toMatchObject({ ok: false });
  });
});

describe("parseRunParams for a Replay", () => {
  const params = { kind: "replay", source_run_id: "manual-ai-infra-20261117T043449Z" };

  it("accepts a source Run, a starting stage and a config", () => {
    expect(
      parseRunParams("replay-ai-infra-x", { ...params, from_stage: "synthesis", config: copy() }),
    ).toEqual({
      ok: true,
      replay: {
        kind: "replay",
        source_run_id: "manual-ai-infra-20261117T043449Z",
        from_stage: "synthesis",
        config: CONFIG,
      },
    });
  });

  it.each([
    ["no source Run", { kind: "replay", from_stage: "triage", config: copy() }],
    [
      "an invalid source Run ID",
      { ...params, source_run_id: "a b", from_stage: "triage", config: copy() },
    ],
    ["a stage before triage", { ...params, from_stage: "dedupe", config: copy() }],
    ["a stage after synthesis", { ...params, from_stage: "publish", config: copy() }],
    ["no config", { ...params, from_stage: "triage" }],
    ["an invalid config", { ...params, from_stage: "triage", config: { triage_limit: 5 } }],
  ])("rejects %s", (_label, payload) => {
    expect(parseRunParams("id", payload)).toMatchObject({ ok: false });
  });
});
