// Generates docs/interfaces.md from src/core/ports.ts.
// Run: npm run docs:interfaces. A unit test fails when the committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PORTS_PATH = fileURLToPath(new URL("../src/core/ports.ts", import.meta.url));
export const DOC_PATH = fileURLToPath(new URL("../docs/interfaces.md", import.meta.url));

export function renderInterfacesDoc(portsSource: string): string {
  return [
    "# Interfaces",
    "",
    "Generated from `src/core/ports.ts` by `npm run docs:interfaces`. Do not edit by hand.",
    "",
    "These are the boundaries between the pipeline core and its adapters (D1, R2, model calls, logging).",
    "",
    "```ts",
    portsSource.trimEnd(),
    "```",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(DOC_PATH, renderInterfacesDoc(readFileSync(PORTS_PATH, "utf8")));
  console.log(`wrote ${DOC_PATH}`);
}
