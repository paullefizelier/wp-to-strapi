import { NodeType, parse, type HTMLElement, type Node } from "node-html-parser";

export interface ExtractedContent {
  /** Sanitised HTML: text and images only, no layout, classes or scripts. */
  html: string;
  /** Length of the plain text kept — the signal for "did we actually find the content?". */
  textLength: number;
  /** Embeds (iframe/video/audio) dropped on the way. Reported so nothing vanishes silently. */
  droppedEmbeds: number;
}

/**
 * Containers themes put the post body in, most specific first. The first candidate holding
 * real text wins, so a page-builder wrapper is preferred over `<body>` and its chrome.
 */
const CONTENT_SELECTORS = [
  ".entry-content",
  ".post-content",
  ".page-content",
  ".article-content",
  ".elementor-location-single",
  ".elementor",
  ".et-l--post",
  ".et_builder_inner_content",
  ".fl-builder-content",
  "main article",
  "article",
  "main",
  "[role=main]",
  "#content",
  ".site-main",
  "body",
];

/** Chrome that is never post content. Matched on whole class/id tokens: `elementor-widget`
 * contains "widget", and blanket substring matching would delete the entire page body. */
const CHROME_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  "dialog",
  "button",
  "input",
  "select",
  "textarea",
  ".site-header",
  ".site-footer",
  ".main-navigation",
  ".nav-menu",
  ".breadcrumb",
  ".breadcrumbs",
  ".comments-area",
  ".comment-respond",
  ".screen-reader-text",
  ".skip-link",
  ".sr-only",
  ".social-share",
  ".share-buttons",
  ".cookie-notice",
  ".wp-block-post-comments",
  "#comments",
  "#respond",
  "#sidebar",
  "#secondary",
  "#masthead",
  "#colophon",
];

const EMBED_SELECTORS = ["iframe", "video", "audio", "embed", "object"];

/** Tags kept in the output. Everything else is unwrapped — its text and images survive. */
const KEEP_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code",
  "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "sub", "sup",
  "a", "img", "figure", "figcaption", "br", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
]);

const VOID_TAGS = new Set(["img", "br", "hr"]);

const KEEP_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  img: ["src", "srcset", "alt", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};

function absolutize(url: string, pageUrl: string): string {
  const trimmed = url.trim();
  if (!trimmed || /^(data:|#|mailto:|tel:|javascript:)/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, pageUrl).toString();
  } catch {
    return trimmed;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function renderAttrs(el: HTMLElement, tag: string, pageUrl: string): string {
  const allowed = KEEP_ATTRS[tag];
  if (!allowed) return "";
  let out = "";
  for (const name of allowed) {
    const raw = el.getAttribute(name);
    if (raw === undefined || raw === null || raw === "") continue;
    let value = raw;
    if (name === "src" || name === "href") value = absolutize(raw, pageUrl);
    else if (name === "srcset") {
      value = raw
        .split(",")
        .map((candidate) => {
          const [url, ...rest] = candidate.trim().split(/\s+/);
          return url ? [absolutize(url, pageUrl), ...rest].join(" ") : "";
        })
        .filter(Boolean)
        .join(", ");
    }
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
}

function render(node: Node, pageUrl: string): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.rawText;
  if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = (el.rawTagName ?? "").toLowerCase();
  const children = el.childNodes.map((child) => render(child, pageUrl)).join("");
  if (!KEEP_TAGS.has(tag)) return children; // unwrap: keep what it contained
  if (VOID_TAGS.has(tag)) {
    // A lazy-loaded image with no resolvable src is noise, not content.
    if (tag === "img" && !el.getAttribute("src")) return "";
    return `<${tag}${renderAttrs(el, tag, pageUrl)}>`;
  }
  const attrs = renderAttrs(el, tag, pageUrl);
  return `<${tag}${attrs}>${children}</${tag}>`;
}

/** Drop elements left empty by the sanitising pass, innermost first. */
function pruneEmpty(html: string): string {
  const emptyish = /<(p|li|ul|ol|h[1-6]|blockquote|figure|figcaption|td|th|tr|table|dl)(\s[^>]*)?>\s*(?:<br\s*\/?>\s*)*<\/\1>/gi;
  let out = html;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = out.replace(emptyish, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function tidy(html: string): string {
  return pruneEmpty(html)
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>")
    .trim();
}

/**
 * Pull the readable body out of a rendered WordPress page: text and images, nothing else.
 *
 * This is the fallback for content the REST API cannot hand over — Elementor, Divi, WPBakery
 * and FSE keep their layout in post meta or in templates, and `content.rendered` comes back
 * empty or flattened. The public page is what the visitor actually sees, so it is scraped and
 * stripped down to structure that survives a move to Strapi: headings, paragraphs, lists,
 * links, tables and images. Builder layout, classes, styles and scripts are all discarded.
 */
export function extractReadableContent(pageHtml: string, pageUrl: string): ExtractedContent {
  if (!pageHtml.trim()) return { html: "", textLength: 0, droppedEmbeds: 0 };
  const root = parse(pageHtml, { comment: false });

  for (const selector of CHROME_SELECTORS) {
    for (const el of root.querySelectorAll(selector)) el.remove();
  }
  let droppedEmbeds = 0;
  for (const selector of EMBED_SELECTORS) {
    for (const el of root.querySelectorAll(selector)) {
      droppedEmbeds += 1;
      el.remove();
    }
  }

  let container: HTMLElement | null = null;
  for (const selector of CONTENT_SELECTORS) {
    const candidate = root.querySelector(selector);
    if (candidate && candidate.text.trim().length >= 200) {
      container = candidate;
      break;
    }
    if (candidate && !container) container = candidate; // keep the best specific match so far
  }
  if (!container) return { html: "", textLength: 0, droppedEmbeds };

  const html = tidy(render(container, pageUrl));
  const textLength = html.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim().length;
  return { html, textLength, droppedEmbeds };
}
