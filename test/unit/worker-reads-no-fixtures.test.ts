import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(import.meta.dirname, "../../src");

// Fixture feeds are for tests. The deployed Worker and the local dev Worker read live feeds, so
// no module under `src/` may import or name a fixture file.
describe("the Worker's source", () => {
  it("never names the fixtures directory", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.(ts|tsx)$/.test(f),
    );
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) =>
      /fixtures\//.test(readFileSync(path.join(SRC, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("builds its SourceFetcher from the HTTP factory", () => {
    const workflow = readFileSync(path.join(SRC, "worker/run-workflow.ts"), "utf8");
    expect(workflow).toContain("createSourceFetcher(config.fetch)");
    const factory = readFileSync(path.join(SRC, "worker/source-fetcher-factory.ts"), "utf8");
    expect(factory).toContain("new HttpSourceFetcher(");
    expect(factory).toContain("fetch(url, init)");
  });
});
