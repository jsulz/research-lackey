import type { FeedFormat, RawItem } from "./ports";

/** An arXiv abstract URL, with an optional version suffix. New-style (`2611.17097`) or old-style (`cs/0101001`). */
const ARXIV_ABS =
  /^https?:\/\/(?:export\.)?arxiv\.org\/abs\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$/;

/** A bare arXiv ID, as the Hugging Face Daily Papers API gives it. */
const ARXIV_ID = /^(\d{4}\.\d{4,5})(?:v\d+)?$/;

/**
 * The normalized identity of a feed entry, unique within its Source. Never uses the date,
 * because some feeds rewrite dates.
 *
 * arXiv papers become `arxiv:<id>` without the version suffix, from arXiv Atom ids and from
 * Daily Papers IDs alike, so the same paper has one identity across Sources. Every other
 * entry uses its GUID or Atom id as an opaque string, else its link, else a hash of title and link.
 */
export function itemKey(format: FeedFormat, raw: RawItem): string {
  const id = raw.externalId.trim();
  const abs = ARXIV_ABS.exec(id);
  if (abs) return `arxiv:${abs[1]}`;
  if (format === "hf_daily_papers") {
    const bare = ARXIV_ID.exec(id);
    if (bare) return `arxiv:${bare[1]}`;
  }
  if (id !== "") return id;
  const url = raw.url.trim();
  if (url !== "") return url;
  return `hash:${cyrb53(`${raw.title}\n${raw.url}`)}`;
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
