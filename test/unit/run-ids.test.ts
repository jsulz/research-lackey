import { describe, expect, it } from "vitest";
import { isValidTopicId, manualRunId, parseRunParams } from "../../src/core/run-ids";

// Workflow instance IDs allow only letters, digits, `-` and `_`, up to 100 characters.
const INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/;

describe("manualRunId", () => {
  it("is manual-<topic>-<UTC time in ISO 8601 basic format, to the second>", () => {
    expect(manualRunId("ai-infra", new Date("2026-11-16T01:07:57.123Z"))).toBe(
      "manual-ai-infra-20261116T010757Z",
    );
  });

  it("is a valid Workflow instance ID for the longest allowed Topic ID", () => {
    const id = manualRunId("a".repeat(76), new Date("2026-12-31T23:59:59Z"));
    expect(id).toMatch(INSTANCE_ID);
  });
});

describe("isValidTopicId", () => {
  it.each(["ai-infra", "a", "x1-2", "a".repeat(76)])("accepts %j", (id) => {
    expect(isValidTopicId(id)).toBe(true);
  });

  it.each(["", "AI", "ai infra", "ai.infra", "ai_infra", "-ai", "a".repeat(77)])(
    "rejects %j",
    (id) => {
      expect(isValidTopicId(id)).toBe(false);
    },
  );
});

describe("parseRunParams", () => {
  it("accepts manual params and uses the instance ID as the Run ID", () => {
    expect(parseRunParams("manual-ai-infra-x", { topic_id: "ai-infra", kind: "manual" })).toEqual({
      ok: true,
      run: { id: "manual-ai-infra-x", topic_id: "ai-infra", kind: "manual", scheduled_slot: null },
    });
  });

  it.each([
    ["no payload", undefined],
    ["an invalid Topic ID", { topic_id: "AI", kind: "manual" }],
    ["a replay kind", { topic_id: "ai-infra", kind: "replay" }],
    ["a scheduled Run without a slot", { topic_id: "ai-infra", kind: "scheduled" }],
    ["a non-string slot", { topic_id: "ai-infra", kind: "scheduled", scheduled_slot: 5 }],
  ])("rejects %s", (_label, payload) => {
    expect(parseRunParams("id", payload)).toMatchObject({ ok: false });
  });
});
