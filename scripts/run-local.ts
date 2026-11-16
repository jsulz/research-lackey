// Starts a manual Run against the local dev Worker. Needs `npm run dev` running.
// Run: npm run run:local -- --topic <id> [--port <port>]
import { spawnSync } from "node:child_process";
import { manualRunId, type RunParams } from "../src/core/run-ids.ts";
import { parseRunLocalArgs, USAGE } from "./run-local-args.ts";

const args = parseRunLocalArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}

const runId = manualRunId(args.topic, new Date());
const params: RunParams = { topic_id: args.topic, kind: "manual", scheduled_slot: null };
const result = spawnSync(
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
if (result.status !== 0) {
  console.error(`Could not start Run ${runId}. Is \`npm run dev\` running on port ${args.port}?`);
  process.exit(result.status ?? 1);
}
console.log(`Run ${runId}`);
