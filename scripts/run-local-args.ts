import { isValidTopicId } from "../src/core/run-ids.ts";

export const USAGE = "usage: npm run run:local -- --topic <id> [--port <port>]";

/** Parses `run:local` arguments: `--topic <id>` (required) and `--port <port>` (default 8787). */
export function parseRunLocalArgs(
  argv: readonly string[],
): { ok: true; topic: string; port: number } | { ok: false; error: string } {
  let topic: string | undefined;
  let port = 8787;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    if (flag === "--topic") topic = value;
    else if (flag === "--port") {
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: `invalid port: ${value}` };
      }
    } else return { ok: false, error: `unknown argument: ${flag}` };
  }
  if (topic === undefined) return { ok: false, error: "--topic is required" };
  if (!isValidTopicId(topic)) return { ok: false, error: `invalid Topic ID: ${topic}` };
  return { ok: true, topic, port };
}
