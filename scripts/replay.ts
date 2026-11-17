// Replays a local Run from a stage with an alternate config. Needs `npm run dev` running.
// Run: npm run replay -- --run <id> --from triage|synthesis --config <file> [--port <port>]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseRunConfig } from "../src/core/replay.ts";
import { type ReplayParams, replayRunId } from "../src/core/run-ids.ts";
import { parseReplayArgs, USAGE } from "./replay-args.ts";

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

const args = parseReplayArgs(process.argv.slice(2));
if (!args.ok) fail(`${args.error}\n${USAGE}`);

// A `.json` file is the config itself; anything else is a module exporting `CONFIG` or a default,
// so a copy of src/core/config.ts works as is.
const file = path.resolve(args.config);
let raw: unknown;
try {
  if (file.endsWith(".json")) raw = JSON.parse(readFileSync(file, "utf8"));
  else {
    const mod = (await import(pathToFileURL(file).href)) as { CONFIG?: unknown; default?: unknown };
    raw = mod.CONFIG ?? mod.default;
  }
} catch (err) {
  fail(`Could not read config ${args.config}: ${err instanceof Error ? err.message : String(err)}`);
}
const config = parseRunConfig(raw);
if (!config.ok) fail(`Invalid config ${args.config}: ${config.reason}`);

// The source Run's Topic, from local D1. The Run ID is validated, so quoting it is safe.
const query = spawnSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "research-lackey",
    "--local",
    "--json",
    "--command",
    `SELECT topic_id FROM runs WHERE id = '${args.run}'`,
  ],
  { encoding: "utf8" },
);
if (query.status !== 0) fail(`Could not read local D1:\n${query.stderr}`, query.status ?? 1);
const [result] = JSON.parse(query.stdout) as { results: { topic_id: string }[] }[];
const topic = result?.results[0]?.topic_id;
if (topic === undefined) fail(`Run ${args.run} not found in local D1`);

const runId = replayRunId(topic, new Date());
const params: ReplayParams = {
  kind: "replay",
  source_run_id: args.run,
  from_stage: args.from,
  config: config.config,
};
const trigger = spawnSync(
  "npx",
  [
    "wrangler",
    "workflows",
    "trigger",
    "research-run",
    JSON.stringify(params),
    "--local",
    "--port",
    String(args.port),
    "--id",
    runId,
  ],
  { stdio: "inherit" },
);
if (trigger.status !== 0) {
  fail(
    `Could not start Replay ${runId}. Is \`npm run dev\` running on port ${args.port}?`,
    trigger.status ?? 1,
  );
}
console.log(`Replay ${runId}`);
