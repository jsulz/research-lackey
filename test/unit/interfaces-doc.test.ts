import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_PATH, PORTS_PATH, renderInterfacesDoc } from "../../scripts/docs-interfaces";

describe("docs/interfaces.md", () => {
  it("matches src/core/ports.ts (run `npm run docs:interfaces` to fix)", () => {
    const expected = renderInterfacesDoc(readFileSync(PORTS_PATH, "utf8"));
    expect(readFileSync(DOC_PATH, "utf8")).toBe(expected);
  });
});
