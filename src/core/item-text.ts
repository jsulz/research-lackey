// Text helpers shared by Triage and Synthesis: caps, the content section of an Item's stored
// Markdown, feed HTML as plain text, and escaping that keeps feed text inside its item block.

/** Cuts text longer than `cap` characters and marks the cut, so one Item can't dominate a prompt. */
export function capText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[truncated]`;
}

/** The heading `itemMarkdown` puts before an Item's content. */
const CONTENT_HEADING = "\n## Content\n\n";

/**
 * The content section of an Item's R2 Markdown (see `itemMarkdown`), without the title, URL,
 * date and heading before it. Used only for Items with no summary, so the first content heading
 * is the real one. Empty when there is none.
 */
export function contentBody(markdown: string): string {
  const at = markdown.indexOf(CONTENT_HEADING);
  return at === -1 ? "" : markdown.slice(at + CONTENT_HEADING.length).trim();
}

/** Named entities decoded by `plainText`: XML's five, plus the typographic ones common in feeds. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  le: "\u2264",
  ge: "\u2265",
  times: "\u00d7",
  middot: "\u00b7",
  bull: "\u2022",
  rarr: "\u2192",
  larr: "\u2190",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
};

/** Elements whose content is not text: skipped from the opening tag to the next closing tag. */
const SKIPPED_ELEMENTS = new Set(["svg", "script", "style"]);

/**
 * Feed HTML as plain text, in one linear pass. Tags and comments become spaces; quoted attribute
 * values may contain `>`. The content of `svg`, `script` and `style` elements is dropped up to
 * the first closing tag of the same name (nesting is not tracked): an unclosed `script` or
 * `style` runs to the end, while a self-closing or unclosed `svg` drops only its own tag (its
 * drawing is in attributes). A `<` that doesn't
 * start a tag (`batches < 32`) is kept. Then entities are decoded once (unknown ones stay as
 * written) and whitespace collapses. GitHub release notes, for example, spend about half of
 * their first characters on markup.
 */
export function plainText(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  const out: string[] = [];
  /** Skipped elements found to have no closing tag after some position: not searched again. */
  const unclosed = new Set<string>();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      out.push(" ");
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? "")) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + 1);
    const tag = html.slice(lt + 1, end);
    i = end + 1;
    out.push(" ");
    const name = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name || !SKIPPED_ELEMENTS.has(name)) continue;
    // Only svg can self-close; in HTML, `<script/>` and `<style/>` still open the element.
    if (name === "svg" && /\/\s*$/.test(tag)) continue;
    if (unclosed.has(name)) {
      if (name !== "svg") i = html.length;
      continue;
    }
    const closing = new RegExp(`</${name}[\\s>]`, "gi");
    closing.lastIndex = i;
    const found = closing.exec(html);
    if (found) {
      i = tagEnd(html, found.index + 1) + 1;
    } else {
      unclosed.add(name);
      if (name !== "svg") i = html.length;
    }
  }
  return out.join("");
}

/** The index of the `>` that ends the tag whose name starts at `from`, skipping quoted values. */
function tagEnd(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const ch = html[i];
    if (ch === ">") return i;
    if (ch === '"' || ch === "'") {
      const close = html.indexOf(ch, i + 1);
      if (close === -1) return html.length;
      i = close + 1;
    } else {
      i++;
    }
  }
  return html.length;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const key = name.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? (NAMED_ENTITIES[key] as string) : match;
  });
}

/** Escapes anything in feed text that would open or close an item block (`</item>`, `<ITEM`). */
export function inertItemTags(text: string): string {
  return text.replace(/<(?=\s*\/?\s*item\b)/gi, "&lt;");
}
