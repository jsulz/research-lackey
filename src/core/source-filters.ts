import { plainText } from "./item-text";
import type { SourceFilters } from "./ports";

export type { SourceFilters };

/** A Source with no filters: every Item passes. */
export const NO_FILTERS: SourceFilters = {
  include_keywords: [],
  exclude_keywords: [],
  exclude_title_pattern: null,
};

/** Why the filters can't be applied, or null when they can. */
export function filtersProblem(filters: SourceFilters): string | null {
  for (const field of ["include_keywords", "exclude_keywords"] as const) {
    const list: unknown = filters[field];
    if (!Array.isArray(list)) return `${field} is not a list`;
    for (const keyword of list) {
      if (typeof keyword !== "string" || keyword.trim() === "") {
        return `${field} holds ${JSON.stringify(keyword)}, not a non-empty string`;
      }
    }
  }
  const pattern: unknown = filters.exclude_title_pattern;
  if (pattern === null) return null;
  // An empty pattern matches every title, which would silently remove every Item.
  if (typeof pattern !== "string" || pattern === "") {
    return "exclude_title_pattern is empty or not a string";
  }
  try {
    new RegExp(pattern, "i");
  } catch (err) {
    return `exclude_title_pattern does not compile: ${err instanceof Error ? err.message : err}`;
  }
  return null;
}

/** Lowercased text with runs of whitespace collapsed to one space. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when the Item passes the Source's filters. Keywords match the plain text of the title and
 * summary as substrings, ignoring case: with include keywords, one must appear; no exclude
 * keyword may appear. The exclude title pattern is a regular expression tested against the title,
 * ignoring case. The filters must have no `filtersProblem`.
 */
export function passesFilters(
  filters: SourceFilters,
  item: { title: string; summary: string | null },
): boolean {
  const { include_keywords, exclude_keywords, exclude_title_pattern } = filters;
  if (exclude_title_pattern !== null && new RegExp(exclude_title_pattern, "i").test(item.title)) {
    return false;
  }
  if (include_keywords.length === 0 && exclude_keywords.length === 0) return true;
  // Each field is cleaned on its own, so an unclosed tag in the title can't swallow the summary.
  const text = normalize(`${plainText(item.title)} ${plainText(item.summary ?? "")}`);
  const has = (keyword: string) => text.includes(normalize(keyword));
  if (exclude_keywords.some(has)) return false;
  return include_keywords.length === 0 || include_keywords.some(has);
}
