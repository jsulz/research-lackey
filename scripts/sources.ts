// Prints each Source's health from its Polls. Reads production D1 unless `--local` is given.
// Run: npm run sources [-- --local]
import { spawnSync } from "node:child_process";
import { sources } from "./sources-lib.ts";

const result = sources(process.argv.slice(2), (args) => {
  const run = spawnSync("npx", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: run.error ? null : run.status,
    stdout: run.stdout ?? "",
    stderr: run.error ? `${run.stderr ?? ""}${run.error.message}` : (run.stderr ?? ""),
  };
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
