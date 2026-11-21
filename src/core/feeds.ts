import { XMLParser, XMLValidator } from "fast-xml-parser";
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

const xmlOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  // Decodes numeric character references (`&#233;`, `&#38;`) as well as the XML entities,
  // once, so the same text has the same value however the feed escapes it.
  htmlEntities: true,
  // Repeatable elements are always arrays, so a one-entry feed parses like a long one.
  isArray: (_name: string, jpath: unknown) =>
    jpath === "rss.channel.item" || jpath === "feed.entry" || jpath === "feed.entry.link",
};

const xml = new XMLParser(xmlOptions);

type Node = Record<string, unknown>;

/** Parses well-formed XML. The parser alone accepts some malformed text, so validate first. */
function parseXml(text: string): Node {
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    const { msg, line } = valid.err;
    throw new Error(`Feed is not well-formed XML: ${msg} (line ${line})`);
  }
  return xml.parse(text) as Node;
}

function parseRss(text: string): RawItem[] {
  const doc = parseXml(text);
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
  let doc = parseXml(text);
  const strip = atomPrefixStripper(doc);
  if (strip) doc = new XMLParser({ ...xmlOptions, transformTagName: strip }).parse(text) as Node;
  const feed = doc.feed as Node | undefined;
  if (!feed) throw new Error("Not an Atom document: no feed element");
  const entries = (feed.entry as unknown[] | undefined) ?? [];
  let ordered: Node[][] | undefined;
  return entries.map((node, i) => {
    const entry = fields(node);
    /** Text of an Atom text construct: an XHTML one is read from the order-preserving parse. */
    const textField = (name: string): string => {
      if (fields(entry[name])["@_type"] !== "xhtml") return textOf(entry[name]);
      ordered ??= orderedEntries(text, strip);
      return textOf(orderedText(childNodes(ordered[i], name)));
    };
    return identified(i, {
      externalId: idOf(entry.id),
      url: alternateLink(entry.link as unknown[] | undefined),
      title: textField("title"),
      summary: optional(textField("summary")),
      content: optional(textField("content")),
      publishedAt: isoDate(textOf(entry.published)) ?? isoDate(textOf(entry.updated)),
    });
  });
}

const ATOM_NS = "http://www.w3.org/2005/Atom";

/**
 * Strips the prefixes the root element binds to the Atom namespace (`atom:entry` becomes
 * `entry`), or undefined when it binds none. Prefixes of other namespaces, such as
 * `media:title`, are kept, so extension elements never replace Atom fields.
 */
function atomPrefixStripper(doc: Node): ((tag: string) => string) | undefined {
  const rootKey = Object.keys(doc).find((key) => !key.startsWith("?"));
  const root = fields(rootKey === undefined ? undefined : doc[rootKey]);
  const prefixes = new Set(
    Object.entries(root)
      .filter(([key, value]) => key.startsWith("@_xmlns:") && idOf(value) === ATOM_NS)
      .map(([key]) => key.slice("@_xmlns:".length)),
  );
  if (prefixes.size === 0) return undefined;
  return (tag) => {
    const colon = tag.indexOf(":");
    return colon > 0 && prefixes.has(tag.slice(0, colon)) ? tag.slice(colon + 1) : tag;
  };
}

/**
 * Each entry's child nodes from an order-preserving parse, which keeps the text and elements of
 * mixed XHTML content in document order and untrimmed. Entries are in the same order as the
 * default parse.
 */
function orderedEntries(text: string, strip: ((tag: string) => string) | undefined): Node[][] {
  const ordered = new XMLParser({
    ...xmlOptions,
    isArray: undefined,
    preserveOrder: true,
    trimValues: false,
    transformTagName: strip ?? false,
  }).parse(text) as Node[];
  const feed = childNodes(ordered, "feed");
  return feed.filter((node) => "entry" in node).map((node) => nodeList(node.entry));
}

/** The child nodes of the first element named `name` among `nodes`. */
function childNodes(nodes: Node[] | undefined, name: string): Node[] {
  const node = (nodes ?? []).find((n) => name in n);
  return node ? nodeList(node[name]) : [];
}

function nodeList(value: unknown): Node[] {
  return Array.isArray(value) ? value.map(fields) : [];
}

/** Elements whose boundaries separate words in XHTML text. */
const XHTML_BLOCKS = new Set(
  "address article aside blockquote br dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li ol p pre section table td th tr ul".split(
    " ",
  ),
);

/**
 * The character data of ordered nodes in document order, with block elements as word breaks.
 * The parser rejects nesting deeper than 100 elements, which bounds the recursion.
 */
function orderedText(nodes: Node[]): string {
  let out = "";
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "#text") out += String(value);
      else if (key !== ":@" && !key.startsWith("?")) {
        const local = key.slice(key.indexOf(":") + 1);
        const brk = XHTML_BLOCKS.has(local) ? " " : "";
        out += brk + orderedText(nodeList(value)) + brk;
      }
    }
  }
  return out;
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
