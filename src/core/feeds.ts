import { XMLParser } from "fast-xml-parser";
import type { FeedFormat, RawItem } from "./ports";

/** Parses a feed document into its entries, in feed order. Throws when the text is not a feed. */
export function parseFeed(format: FeedFormat, text: string): RawItem[] {
  switch (format) {
    case "rss2":
      return parseRss(text);
    case "atom":
      return parseAtom(text);
    case "hf_daily_papers":
      return parseHfDailyPapers(text);
    default:
      throw new Error(`Unsupported feed format: ${format}`);
  }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  // Repeatable elements are always arrays, so a one-entry feed parses like a long one.
  isArray: (_name, jpath) =>
    jpath === "rss.channel.item" || jpath === "feed.entry" || jpath === "feed.entry.link",
});

type Node = Record<string, unknown>;

function parseRss(text: string): RawItem[] {
  const doc = xml.parse(text) as Node;
  const channel = (doc.rss as Node | undefined)?.channel as Node | undefined;
  if (!channel) throw new Error("Not an RSS 2.0 document: no rss/channel element");
  const items = (channel.item as Node[] | undefined) ?? [];
  return items.map((item) => ({
    externalId: textOf(item.guid),
    url: textOf(item.link),
    title: textOf(item.title),
    summary: optional(textOf(item.description)),
    publishedAt: isoDate(textOf(item.pubDate)),
  }));
}

function parseAtom(text: string): RawItem[] {
  const feed = (xml.parse(text) as Node).feed as Node | undefined;
  if (!feed) throw new Error("Not an Atom document: no feed element");
  const entries = (feed.entry as Node[] | undefined) ?? [];
  return entries.map((entry) => ({
    externalId: textOf(entry.id),
    url: alternateLink(entry.link as Node[] | undefined),
    title: textOf(entry.title),
    summary: optional(textOf(entry.summary)),
    content: optional(textOf(entry.content)),
    publishedAt: isoDate(textOf(entry.published)) ?? isoDate(textOf(entry.updated)),
  }));
}

/** The Hugging Face Daily Papers API response: a JSON array, one element per paper. */
function parseHfDailyPapers(text: string): RawItem[] {
  const doc: unknown = JSON.parse(text);
  if (!Array.isArray(doc)) throw new Error("Not a Daily Papers document: expected a JSON array");
  return doc.map((entry: Node) => {
    const paper = (entry.paper ?? {}) as Node;
    const id = textOf(paper.id);
    return {
      externalId: id,
      url: id === "" ? "" : `https://huggingface.co/papers/${id}`,
      title: textOf(entry.title ?? paper.title),
      summary: optional(textOf(entry.summary ?? paper.summary)),
      publishedAt: isoDate(textOf(paper.publishedAt)) ?? isoDate(textOf(entry.publishedAt)),
    };
  });
}

/** The `alternate` link, or a link with no `rel` (which means alternate), else the first. */
function alternateLink(links: Node[] | undefined): string {
  if (!links || links.length === 0) return "";
  const alternate = links.find((l) => l["@_rel"] === undefined || l["@_rel"] === "alternate");
  return textOf((alternate ?? links[0])?.["@_href"]);
}

/** Text of an element, whether the parser gave a string or an object with attributes. */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return textOf((value as Node)["#text"]);
  return String(value).replace(/\s+/g, " ").trim();
}

function optional(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function isoDate(value: string): string | undefined {
  if (value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
