import type { ReplayStage } from "../src/core/ports.ts";
import { isReplayStage } from "../src/core/replay.ts";
import { isValidRunId } from "../src/core/run-ids.ts";

export const USAGE =
  "usage: npm run replay -- (--run <id> | --from-prod <id>) --from triage|synthesis --config <file> [--port <port>]";

export interface ReplayArgs {
  /** The source Run: a local Run (`--run`), or a production Run to copy first (`--from-prod`). */
  run: string;
  /** True when the source Run was named with `--from-prod`. */
  from_prod: boolean;
  from: ReplayStage;
  /** Path to a `.json` config, or a module exporting `CONFIG` (or a default export). */
  config: string;
  port: number;
}

/**
 * Parses `replay` arguments: exactly one of `--run` and `--from-prod`, then `--from` and `--config`
 * (both required) and `--port` (default 8787).
 */
export function parseReplayArgs(
  argv: readonly string[],
): ({ ok: true } & ReplayArgs) | { ok: false; error: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i] ?? "", argv[i + 1]];
    if (!["--run", "--from-prod", "--from", "--config", "--port"].includes(flag)) {
      return { ok: false, error: `unknown argument: ${flag}` };
    }
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    values[flag] = value;
  }
  const local = values["--run"];
  const prod = values["--from-prod"];
  if (local !== undefined && prod !== undefined) {
    return { ok: false, error: "give --run or --from-prod, not both" };
  }
  const run = local ?? prod;
  const from = values["--from"];
  const config = values["--config"];
  if (run === undefined) return { ok: false, error: "--run or --from-prod is required" };
  if (!isValidRunId(run)) return { ok: false, error: `invalid Run ID: ${run}` };
  if (from === undefined) return { ok: false, error: "--from is required" };
  if (!isReplayStage(from)) return { ok: false, error: `--from must be triage or synthesis` };
  if (config === undefined) return { ok: false, error: "--config is required" };
  const port = Number(values["--port"] ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `invalid port: ${values["--port"]}` };
  }
  return { ok: true, run, from_prod: prod !== undefined, from, config, port };
}
