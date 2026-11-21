import { describe, expect, it } from "vitest";
import {
  filtersProblem,
  NO_FILTERS,
  passesFilters,
  type SourceFilters,
} from "../../src/core/source-filters";

function filters(f: Partial<SourceFilters>): SourceFilters {
  return { ...NO_FILTERS, ...f };
}

const kvPaper = { title: "Paged KV cache eviction", summary: "We study serving at scale." };
const robotics = { title: "Humanoid grasping", summary: "A robotics benchmark." };

describe("include keywords", () => {
  it("pass every Item when the list is empty", () => {
    expect(passesFilters(NO_FILTERS, kvPaper)).toBe(true);
    expect(passesFilters(NO_FILTERS, robotics)).toBe(true);
    expect(passesFilters(NO_FILTERS, { title: "No summary", summary: null })).toBe(true);
  });

  it("pass only Items whose title or summary contains one of them", () => {
    const f = filters({ include_keywords: ["inference", "serving"] });
    expect(passesFilters(f, kvPaper)).toBe(true); // summary
    expect(passesFilters(f, { title: "Fast inference kernels", summary: null })).toBe(true); // title
    expect(passesFilters(f, robotics)).toBe(false);
  });

  it("match case-insensitively, either way round", () => {
    expect(passesFilters(filters({ include_keywords: ["kv cache"] }), kvPaper)).toBe(true);
    expect(passesFilters(filters({ include_keywords: ["SERVING"] }), kvPaper)).toBe(true);
  });

  it("match the summary's text, not its markup or line breaks", () => {
    const f = filters({ include_keywords: ["kv cache", "a & b"] });
    expect(passesFilters(f, { title: "x", summary: "<p><b>KV</b>\n  cache</p>" })).toBe(true);
    expect(passesFilters(f, { title: "x", summary: "A &amp; B" })).toBe(true);
    expect(
      passesFilters(filters({ include_keywords: ["strong"] }), {
        title: "x",
        summary: "<strong>tag names</strong> are not text",
      }),
    ).toBe(false);
  });
  it("keep markup in the title from hiding the summary", () => {
    const f = filters({ include_keywords: ["inference"] });
    expect(
      passesFilters(f, { title: "Release notes <!--", summary: "GPU inference improvements" }),
    ).toBe(true);
    expect(passesFilters(f, { title: "Release <b", summary: "inference" })).toBe(true);
  });
});

describe("exclude keywords", () => {
  it("remove Items whose title or summary contains any of them", () => {
    const f = filters({ exclude_keywords: ["robotics", "Diffusion"] });
    expect(passesFilters(f, robotics)).toBe(false); // summary
    expect(passesFilters(f, { title: "diffusion models", summary: null })).toBe(false); // title
    expect(passesFilters(f, kvPaper)).toBe(true);
  });

  it("win over include keywords", () => {
    const f = filters({ include_keywords: ["serving"], exclude_keywords: ["eviction"] });
    expect(passesFilters(f, kvPaper)).toBe(false);
  });
});

describe("exclude title pattern", () => {
  const f = filters({ exclude_title_pattern: "rc\\d+" });

  it("removes Items whose title matches", () => {
    expect(passesFilters(f, { title: "v0.34.0rc4", summary: null })).toBe(false);
    expect(passesFilters(f, { title: "v0.33.0rc2: [ROCm] Skip GEMM", summary: null })).toBe(false);
    expect(passesFilters(f, { title: "v0.34.0", summary: null })).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(passesFilters(f, { title: "v1.0.0-RC1", summary: null })).toBe(false);
  });

  it("tests only the title", () => {
    expect(passesFilters(f, { title: "v0.34.0", summary: "Follows rc4." })).toBe(true);
  });
});

describe("filtersProblem", () => {
  it("accepts no filters and well-formed ones", () => {
    expect(filtersProblem(NO_FILTERS)).toBeNull();
    expect(
      filtersProblem(
        filters({ include_keywords: ["a"], exclude_keywords: ["b"], exclude_title_pattern: "rc" }),
      ),
    ).toBeNull();
  });

  it("rejects an empty or non-string keyword", () => {
    expect(filtersProblem(filters({ include_keywords: [" "] }))).toMatch(/include_keywords/);
    expect(filtersProblem(filters({ exclude_keywords: [3 as unknown as string] }))).toMatch(
      /exclude_keywords/,
    );
  });

  it("rejects a pattern that does not compile", () => {
    expect(filtersProblem(filters({ exclude_title_pattern: "rc(" }))).toMatch(
      /exclude_title_pattern/,
    );
  });

  it("rejects an empty pattern, which would remove every Item", () => {
    expect(filtersProblem(filters({ exclude_title_pattern: "" }))).toMatch(/exclude_title_pattern/);
  });
});
