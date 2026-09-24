// `he` is CommonJS: a named import of `decode` fails under Node's ESM loader, even though
// bundlers paper over it. The default import is the interop-safe form.
import he from "he";

import type { MigrationState } from "./state.js";

/** A migrated file as it should appear in the rewritten HTML. */
export interface MediaTarget {
  /** Absolute URL of the file in Strapi. */
  url: string;
  /** Responsive variants Strapi generated, narrowest first. Empty when Strapi made none. */
  formats: ReadonlyArray<{ url: string; width: number }>;
}

export interface MediaIndex {
  /** Number of indexed attachments. */
  readonly size: number;
  /** Resolve any URL found in WP content to its migrated counterpart, or null. */
  lookup(rawUrl: string): MediaTarget | null;
}

/**
 * WP rarely embeds the attachment's own `source_url`: it inserts a generated variant
 * (`photo-1024x768.jpg`), the downscaled original (`photo-scaled.jpg`), or a CDN rewrite
 * (`i0.wp.com/site.com/wp-content/uploads/...?resize=…`). Normalising both sides down to
 * `directory + base filename` is what lets a single attachment match all of them.
 */
function normalizeFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return fileName.toLowerCase();
  const stem = fileName
    .slice(0, dot)
    .replace(/-\d+x\d+$/, "")
    .replace(/-scaled$/, "");
  return `${stem}${fileName.slice(dot)}`.toLowerCase();
}

function pathKey(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  const dir = pathname.slice(0, slash + 1).toLowerCase();
  return `${dir}${normalizeFileName(pathname.slice(slash + 1))}`;
}

/** Extract the pathname of any URL shape found in HTML (absolute, relative, entity-escaped). */
function parseUrl(raw: string): { path: string; name: string } | null {
  const cleaned = raw.trim().replace(/&amp;/gi, "&").replace(/&#0*38;/g, "&");
  if (!cleaned || /^(data:|#|mailto:|tel:|javascript:)/i.test(cleaned)) return null;
  let pathname: string;
  try {
    pathname = new URL(cleaned, "https://wp-to-strapi.invalid").pathname;
  } catch {
    return null;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* keep the raw pathname when it carries invalid escapes */
  }
  const name = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (!name) return null;
  return { path: pathname, name };
}

function absolute(url: string, strapiBaseUrl: string): string {
  return url.startsWith("http") ? url : `${strapiBaseUrl.replace(/\/+$/, "")}${url}`;
}

/** Build the WP-URL → Strapi-URL index from the persisted migration state. */
export function buildMediaIndex(
  state: MigrationState,
  strapiBaseUrl: string,
): MediaIndex {
  const byPath = new Map<string, MediaTarget>();
  // `null` marks a file name used by several attachments — too ambiguous to match on name alone.
  const byName = new Map<string, MediaTarget | null>();

  for (const media of Object.values(state.media)) {
    const parsed = parseUrl(media.sourceUrl);
    if (!parsed) continue;
    const target: MediaTarget = {
      url: absolute(media.url, strapiBaseUrl),
      formats: (media.formats ?? [])
        .map((f) => ({ url: absolute(f.url, strapiBaseUrl), width: f.width }))
        .sort((a, b) => a.width - b.width),
    };
    byPath.set(pathKey(parsed.path), target);
    const nameKey = normalizeFileName(parsed.name);
    const seen = byName.get(nameKey);
    if (seen === undefined) byName.set(nameKey, target);
    else if (seen && seen.url !== target.url) byName.set(nameKey, null);
  }

  return {
    size: byPath.size,
    lookup(rawUrl: string): MediaTarget | null {
      const parsed = parseUrl(rawUrl);
      if (!parsed) return null;
      // Walk the path right-to-left so CDN prefixes (i0.wp.com/<host>/<path>) still match.
      let path = parsed.path;
      for (;;) {
        const hit = byPath.get(pathKey(path));
        if (hit) return hit;
        const next = path.indexOf("/", 1);
        if (next < 0) break;
        path = path.slice(next);
      }
      return byName.get(normalizeFileName(parsed.name)) ?? null;
    },
  };
}

// Attributes that carry a single URL. `content` covers og:image-style meta tags.
const URL_ATTR =
  /\b(src|href|poster|content|data-src|data-url|data-orig-file|data-large-file|data-medium-file|data-small-file|data-full-url|data-thumb)\s*=\s*(["'])([^"']*)\2/gi;
const SRCSET_ATTR = /\b(srcset|data-srcset|imagesrcset)\s*=\s*(["'])([^"']*)\2/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/**
 * Rewrite every WordPress media URL in `html` to its migrated Strapi URL.
 *
 * Handles plain `src`/`href`, `srcset` (rebuilt from Strapi's own image formats, or dropped
 * when Strapi generated none), CSS `url(...)` in style attributes, and bare occurrences in
 * text. Size variants, `-scaled` originals and image-CDN rewrites all resolve back to the
 * attachment they came from. Regex-based on purpose — no DOM dependency.
 */
export function rewriteMediaUrls(
  html: string,
  state: MigrationState,
  strapiBaseUrl: string,
): string {
  const index = buildMediaIndex(state, strapiBaseUrl);
  if (index.size === 0 || !html) return html;

  let out = html.replace(SRCSET_ATTR, (whole, attr: string, quote: string, value: string) => {
    const target = value
      .split(",")
      .map((candidate) => index.lookup(candidate.trim().split(/\s+/)[0] ?? ""))
      .find((hit): hit is MediaTarget => hit !== null);
    if (!target) return whole;
    if (target.formats.length === 0) return ""; // a lone `sizes` attribute is ignored by browsers
    const rebuilt = target.formats.map((f) => `${f.url} ${f.width}w`).join(", ");
    return `${attr}=${quote}${rebuilt}${quote}`;
  });

  out = out.replace(URL_ATTR, (whole, attr: string, quote: string, value: string) => {
    const target = index.lookup(value);
    return target ? `${attr}=${quote}${target.url}${quote}` : whole;
  });

  out = out.replace(CSS_URL, (whole, quote: string, value: string) => {
    const target = index.lookup(value);
    return target ? `url(${quote}${target.url}${quote})` : whole;
  });

  // Catch-all for URLs outside attributes (JSON-LD, plain text). Longest first to avoid
  // rewriting a prefix of another URL.
  const sources = Object.values(state.media)
    .map((m) => m.sourceUrl)
    .filter((src) => src && out.includes(src))
    .sort((a, b) => b.length - a.length);
  for (const src of sources) {
    const target = index.lookup(src);
    if (!target) continue;
    out = out.split(src).join(target.url);
  }
  return out;
}

const MEDIA_EXT =
  /\.(jpe?g|png|gif|webp|avif|svgz?|bmp|ico|pdf|mp4|m4v|mov|webm|mp3|wav|ogg|zip|docx?|xlsx?|pptx?|csv)$/i;

/**
 * Media URLs still pointing at WordPress after a rewrite pass — i.e. files the migration
 * did not carry over. They break the day the WP install is switched off, so surface them.
 */
export function findUnresolvedMediaUrls(html: string, wpBaseUrl: string): string[] {
  if (!html) return [];
  let wpHost = "";
  try {
    wpHost = new URL(wpBaseUrl).host.toLowerCase();
  } catch {
    /* an unparseable base URL just disables host matching */
  }

  const found = new Set<string>();
  const consider = (raw: string): void => {
    const parsed = parseUrl(raw);
    if (!parsed || !MEDIA_EXT.test(parsed.path)) return;
    const isUploadPath = /\/(wp-content\/uploads|wp-content\/blogs\.dir|files)\//i.test(parsed.path);
    let host = "";
    try {
      host = new URL(raw.trim(), `https://${wpHost || "wp-to-strapi.invalid"}`).host.toLowerCase();
    } catch {
      return;
    }
    const isWpHost = wpHost !== "" && (host === wpHost || parsed.path.toLowerCase().includes(`/${wpHost}/`));
    if (isUploadPath || isWpHost) found.add(raw.trim());
  };

  for (const m of html.matchAll(URL_ATTR)) consider(m[3] ?? "");
  for (const m of html.matchAll(CSS_URL)) consider(m[2] ?? "");
  for (const m of html.matchAll(SRCSET_ATTR)) {
    for (const candidate of (m[3] ?? "").split(",")) consider(candidate.trim().split(/\s+/)[0] ?? "");
  }
  return [...found];
}

/**
 * Every attachment an entry's HTML points at: ids WordPress wrote into the markup (Gutenberg's
 * `wp-image-123`, gallery `data-id`, block comments in raw content) and every URL, to be matched
 * against the media library with {@link buildSourceMatcher}.
 */
export function findMediaReferences(html: string): { ids: number[]; urls: string[] } {
  if (!html) return { ids: [], urls: [] };
  const ids = new Set<number>();
  for (const m of html.matchAll(/\bwp-image-(\d+)\b/g)) ids.add(Number(m[1]));
  for (const m of html.matchAll(/\bdata-(?:id|attachment-id)\s*=\s*["'](\d+)["']/g)) ids.add(Number(m[1]));
  for (const m of html.matchAll(/<!--\s*wp:[\w/-]+\s+(\{[^]*?\})\s*\/?-->/g)) {
    for (const id of (m[1] ?? "").matchAll(/"(?:id|mediaId)"\s*:\s*(\d+)/g)) ids.add(Number(id[1]));
    for (const list of (m[1] ?? "").matchAll(/"ids"\s*:\s*\[([\d,\s]*)\]/g)) {
      for (const id of (list[1] ?? "").split(",")) if (id.trim()) ids.add(Number(id));
    }
  }

  const urls = new Set<string>();
  for (const m of html.matchAll(URL_ATTR)) if (m[3]) urls.add(m[3].trim());
  for (const m of html.matchAll(CSS_URL)) if (m[2]) urls.add(m[2].trim());
  for (const m of html.matchAll(SRCSET_ATTR)) {
    for (const candidate of (m[3] ?? "").split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) urls.add(url);
    }
  }
  return { ids: [...ids], urls: [...urls] };
}

/**
 * Resolve any URL found in content to the attachment it came from, by the same rules as the
 * rewrite: size variants, `-scaled` originals and CDN prefixes all lead back to the original.
 */
export function buildSourceMatcher(
  media: ReadonlyArray<{ id: number; source_url: string }>,
): (rawUrl: string) => number | null {
  const byPath = new Map<string, number>();
  const byName = new Map<string, number | null>();
  for (const m of media) {
    const parsed = m.source_url ? parseUrl(m.source_url) : null;
    if (!parsed) continue;
    byPath.set(pathKey(parsed.path), m.id);
    const nameKey = normalizeFileName(parsed.name);
    const seen = byName.get(nameKey);
    if (seen === undefined) byName.set(nameKey, m.id);
    else if (seen !== m.id) byName.set(nameKey, null);
  }
  return (rawUrl) => {
    const parsed = parseUrl(rawUrl);
    if (!parsed) return null;
    let path = parsed.path;
    for (;;) {
      const hit = byPath.get(pathKey(path));
      if (hit !== undefined) return hit;
      const next = path.indexOf("/", 1);
      if (next < 0) break;
      path = path.slice(next);
    }
    return byName.get(normalizeFileName(parsed.name)) ?? null;
  };
}

/** Which editor produced the HTML WordPress handed us. */
export type ContentFlavour =
  | "empty"
  | "elementor"
  | "divi"
  | "wpbakery"
  | "gutenberg"
  | "classic";

/**
 * Page builders keep their layout in post meta and render it through their own frontend
 * hooks, so `content.rendered` arrives empty or flattened. Detecting that lets the run
 * report it instead of silently importing a blank page.
 */
export function detectFlavour(html: string): ContentFlavour {
  // Builder markers come first: a builder page whose body renders blank is still a builder
  // page, and naming it is what tells you the layout lives somewhere the REST API cannot see.
  if (/\belementor-(element|widget|section|column|container)\b|data-elementor-type/i.test(html)) {
    return "elementor";
  }
  if (/\bet_pb_(section|row|column|module)\b|\[et_pb_/i.test(html)) return "divi";
  if (/\bvc_(row|column|section)\b|\[vc_/i.test(html)) return "wpbakery";

  const text = (html ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
  const hasMedia = /<(img|video|audio|iframe|figure)\b/i.test(html ?? "");
  if (text === "" && !hasMedia) return "empty";

  if (/\bwp-block-[a-z]/i.test(html) || html.includes("<!-- wp:")) return "gutenberg";
  return "classic";
}

/** Shortcodes WordPress did not expand — they arrive in Strapi as literal `[tag …]` text. */
export function findShortcodes(html: string): string[] {
  const tags = new Set<string>();
  for (const m of (html ?? "").matchAll(/\[\/?([a-z][a-z0-9_-]{2,40})(?=[\s\]/])/gi)) {
    const tag = m[1]?.toLowerCase();
    if (tag && tag !== "caption") tags.add(tag);
  }
  return [...tags];
}

/**
 * Decode HTML entities from WP's rendered titles and captions.
 *
 * WP hands back `Caf&#233;s &amp; co`; Strapi wants `Cafés & co`. The full entity table
 * matters here — accented content is exactly what a hand-picked list of smart quotes misses.
 */
export function decodeEntities(s: string): string {
  return he.decode(s ?? "");
}
