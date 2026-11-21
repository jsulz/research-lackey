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
  const prefixed = atomNames(doc);
  if (prefixed)
    doc = new XMLParser({ ...xmlOptions, isArray: atomIsArray(prefixed) }).parse(text) as Node;
  const names = prefixed ?? ((tag: string) => tag);
  const [, feedNode] = atomChild(doc, names, "feed") ?? [];
  if (!feedNode) throw new Error("Not an Atom document: no feed element");
  const [entryKey, entryNodes] = atomChild(fields(feedNode), names, "entry") ?? [];
  const entries = Array.isArray(entryNodes) ? entryNodes : [];
  let ordered: Node[][] | undefined;
  return entries.map((node, i) => {
    const entry = fields(node);
    const field = (name: string) => atomChild(entry, names, name);
    /** Text of an Atom text construct: an XHTML one is read from the order-preserving parse. */
    const textField = (name: string): string => {
      const [key, value] = field(name) ?? [];
      if (key === undefined || fields(value)["@_type"] !== "xhtml") return textOf(value);
      ordered ??= orderedEntries(text, names, entryKey ?? "entry");
      return textOf(orderedText(childNodes(ordered[i], key)));
    };
    return identified(i, {
      externalId: idOf(field("id")?.[1]),
      url: alternateLink(field("link")?.[1] as unknown[] | undefined),
      title: textField("title"),
      summary: optional(textField("summary")),
      content: optional(textField("content")),
      publishedAt:
        isoDate(textOf(field("published")?.[1])) ?? isoDate(textOf(field("updated")?.[1])),
    });
  });
}

const ATOM_NS = "http://www.w3.org/2005/Atom";

/** An element's Atom local name, or undefined when the element is not in the Atom namespace. */
type AtomNames = (tag: string) => string | undefined;

/**
 * Atom local names for a document whose root element binds one or more prefixes to the Atom
 * namespace (`atom:entry` is `entry`), or undefined when it binds none. Elements with another
 * prefix (`media:title`) are not Atom, and unprefixed elements are Atom only when the default
 * namespace is Atom too, so extension elements never replace Atom fields.
 */
function atomNames(doc: Node): AtomNames | undefined {
  const rootKey = Object.keys(doc).find((key) => !key.startsWith("?"));
  const root = fields(rootKey === undefined ? undefined : doc[rootKey]);
  const prefixes = new Set(
    Object.entries(root)
      .filter(([key, value]) => key.startsWith("@_xmlns:") && idOf(value) === ATOM_NS)
      .map(([key]) => key.slice("@_xmlns:".length)),
  );
  if (prefixes.size === 0) return undefined;
  const unprefixedIsAtom = idOf(root["@_xmlns"]) === ATOM_NS;
  return (tag) => {
    const colon = tag.indexOf(":");
    if (colon === -1) return unprefixedIsAtom ? tag : undefined;
    return prefixes.has(tag.slice(0, colon)) ? tag.slice(colon + 1) : undefined;
  };
}

/** The default parser's array rule, applied to Atom local names. */
function atomIsArray(names: AtomNames): (name: string, jpath: unknown) => boolean {
  return (_name, jpath) => {
    const local = String(jpath)
      .split(".")
      .map((segment) => names(segment) ?? "")
      .join(".");
    return local === "feed.entry" || local === "feed.entry.link";
  };
}

/** The first child element of `node` whose Atom local name is `name`, as `[key, value]`. */
function atomChild(node: Node, names: AtomNames, name: string): [string, unknown] | undefined {
  return Object.entries(node).find(([key]) => !key.startsWith("@_") && names(key) === name);
}

/**
 * Each entry's child nodes from an order-preserving parse, which keeps the text and elements of
 * mixed XHTML content in document order and untrimmed. Entries are the `entryKey` elements of the
 * feed, the same ones and in the same order as the default parse reads.
 */
function orderedEntries(text: string, names: AtomNames, entryKey: string): Node[][] {
  const ordered = new XMLParser({
    ...xmlOptions,
    isArray: undefined,
    preserveOrder: true,
    trimValues: false,
  }).parse(text) as Node[];
  const feedKey = ordered.flatMap(Object.keys).find((key) => names(key) === "feed") ?? "feed";
  const feed = childNodes(ordered, feedKey);
  return feed.filter((node) => entryKey in node).map((node) => nodeList(node[entryKey]));
}

/** The child nodes of the first element named `key` among `nodes`. */
function childNodes(nodes: Node[] | undefined, key: string): Node[] {
  const node = (nodes ?? []).find((n) => key in n);
  return node ? nodeList(node[key]) : [];
}

function nodeList(value: unknown): Node[] {
  return Array.isArray(value) ? value.map(fields) : [];
}

/** Elements whose boundaries separate words in XHTML text. */
const XHTML_BLOCKS = new Set(
  "address article aside blockquote br caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr legend li main menu nav ol p pre section summary table tbody td tfoot th thead tr ul".split(
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
