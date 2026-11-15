import { describe, expect, it } from "vitest";
import { JsonLogger, parseLogLevel } from "../../src/adapters/json-logger";

function capture(level: Parameters<typeof parseLogLevel>[0]) {
  const lines: string[] = [];
  const log = new JsonLogger(parseLogLevel(level), (l) => lines.push(l));
  return { log, lines };
}

describe("JsonLogger", () => {
  it("emits debug lines at debug, as JSON with level, msg and fields", () => {
    const { log, lines } = capture("debug");
    log.debug("request", { path: "/api/topics", status: 200 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      level: "debug",
      msg: "request",
      path: "/api/topics",
      status: 200,
    });
  });

  it("suppresses debug at info and keeps info and above", () => {
    const { log, lines } = capture("info");
    log.debug("hidden");
    log.info("shown");
    log.error("also shown");
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["shown", "also shown"]);
  });

  it("does not let fields overwrite level or msg", () => {
    const { log, lines } = capture("info");
    log.info("real", { level: "debug", msg: "fake" });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "info", msg: "real" });
  });
});

describe("parseLogLevel", () => {
  it.each([
    ["debug", "debug"],
    [" WARN ", "warn"],
    [undefined, "info"],
    ["verbose", "info"],
    ["constructor", "info"],
    ["__proto__", "info"],
  ])("parses %j as %s", (input, expected) => {
    expect(parseLogLevel(input)).toBe(expected);
  });
});
