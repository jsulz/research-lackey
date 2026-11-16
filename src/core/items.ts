import type { FeedFormat, RawItem } from "./ports";

/** An arXiv paper ID without its version: new-style (`2611.17097`) or old-style (`hep-th/9901001`). */
const PAPER = String.raw`(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?`;

/** An arXiv abstract URL, with an optional version suffix. */
const ARXIV_ABS = new RegExp(String.raw`^https?:\/\/(?:export\.)?arxiv\.org\/abs\/${PAPER}$`);

/** A bare arXiv ID, as the Hugging Face Daily Papers API gives it. */
const ARXIV_BARE = new RegExp(`^${PAPER}$`);

/**
 * The normalized identity of a feed entry, unique within its Source. Never uses the date,
 * because some feeds rewrite dates.
 *
 * The identity comes from the GUID or Atom id, else the link, else a hash of title and link.
 * An arXiv paper in either position becomes `arxiv:<id>` without the version suffix, so the
 * same paper has one identity across versions and across Sources (arXiv and Daily Papers).
 * Anything else is kept as an opaque string, trimmed.
 */
export function itemKey(format: FeedFormat, raw: RawItem): string {
  const id = raw.externalId.trim();
  if (id !== "") return arxivKey(id, format === "hf_daily_papers") ?? id;
  const url = raw.url.trim();
  if (url !== "") return arxivKey(url, false) ?? url;
  return `hash:${cyrb53(`${raw.title}\n${raw.url}`)}`;
}

/** `arxiv:<id>` when the candidate is an arXiv abstract URL, or a bare ID where bare IDs are allowed. */
function arxivKey(candidate: string, allowBare: boolean): string | null {
  const match = ARXIV_ABS.exec(candidate) ?? (allowBare ? ARXIV_BARE.exec(candidate) : null);
  return match ? `arxiv:${match[1]}` : null;
}

/** cyrb53: a fast, well-distributed 53-bit string hash, as hex. Not cryptographic. */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** The Markdown stored in R2 for an Item: title, link, time, then summary and content as given. */
export function itemMarkdown(raw: RawItem): string {
  const parts = [`# ${raw.title || "(untitled)"}`, "", raw.url];
  if (raw.publishedAt) parts.push("", `Published: ${raw.publishedAt}`);
  if (raw.summary) parts.push("", "## Summary", "", raw.summary);
  if (raw.content) parts.push("", "## Content", "", raw.content);
  return `${parts.join("\n")}\n`;
}

/**
 * Items newest first by `published_at`, for the first-poll cap. Equal dates keep feed order and
 * undated Items go last. Dates order Items only; they never decide identity. Returns a new array.
 */
export function newestFirst<T extends { published_at: string | null }>(items: readonly T[]): T[] {
  const time = (item: T) =>
    item.published_at === null ? Number.NEGATIVE_INFINITY : Date.parse(item.published_at);
  // Array.prototype.sort is stable, so ties keep their feed order.
  return [...items].sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    return ta === tb ? 0 : tb > ta ? 1 : -1;
  });
}
