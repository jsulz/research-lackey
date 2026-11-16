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
  const items = (channel.item as unknown[] | undefined) ?? [];
  return items.map((node, i) => {
    const item = fields(node);
    return identified(i, {
      externalId: idOf(item.guid),
      url: idOf(item.link),
      title: textOf(item.title),
      summary: optional(textOf(item.description)),
      publishedAt: isoDate(textOf(item.pubDate)),
    });
  });
}

function parseAtom(text: string): RawItem[] {
  const feed = (xml.parse(text) as Node).feed as Node | undefined;
  if (!feed) throw new Error("Not an Atom document: no feed element");
  const entries = (feed.entry as unknown[] | undefined) ?? [];
  return entries.map((node, i) => {
    const entry = fields(node);
    return identified(i, {
      externalId: idOf(entry.id),
      url: alternateLink(entry.link as unknown[] | undefined),
      title: textOf(entry.title),
      summary: optional(textOf(entry.summary)),
      content: optional(textOf(entry.content)),
      publishedAt: isoDate(textOf(entry.published)) ?? isoDate(textOf(entry.updated)),
    });
  });
}

/** The Hugging Face Daily Papers API response: a JSON array, one element per paper. */
function parseHfDailyPapers(text: string): RawItem[] {
  const doc: unknown = JSON.parse(text);
  if (!Array.isArray(doc)) throw new Error("Not a Daily Papers document: expected a JSON array");
  return doc.map((node: unknown, i) => {
    const entry = fields(node);
    const paper = fields(entry.paper);
    const id = idOf(paper.id);
    if (id === "") throw new Error(`Daily Papers entry ${i + 1} has no paper ID`);
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
function alternateLink(nodes: unknown[] | undefined): string {
  const links = (nodes ?? []).map(fields);
  const alternate = links.find((l) => l["@_rel"] === undefined || l["@_rel"] === "alternate");
  return idOf((alternate ?? links[0])?.["@_href"]);
}

/**
 * An element's own child fields. A non-object node (`<item/>` parses as "") has none, so
 * inherited properties such as `String.prototype.link` are never read as fields.
 */
function fields(node: unknown): Node {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return {};
  return Object.fromEntries(Object.entries(node));
}

/** Rejects an entry with nothing to identify it by: no id, no link and no title. */
function identified(index: number, item: RawItem): RawItem {
  if (item.externalId === "" && item.url === "" && item.title === "") {
    throw new Error(`Feed entry ${index + 1} has no id, link or title`);
  }
  return item;
}

/** An identifier or URL: opaque, so only the ends are trimmed. */
function idOf(value: unknown): string {
  if (typeof value === "object" && value !== null) return idOf((value as Node)["#text"]);
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim();
}

/** Display text of an element, whether the parser gave a string or an object with attributes. Whitespace runs collapse to one space. */
function textOf(value: unknown): string {
  if (typeof value === "object" && value !== null) return textOf((value as Node)["#text"]);
  if (typeof value !== "string" && typeof value !== "number") return "";
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
