import type { MigrationState } from "./state.js";

/**
 * Rewrite <img src> and <a href> that point at the old WP media URLs
 * to their new Strapi URLs based on the media map.
 *
 * Regex-based on purpose — avoids pulling a DOM/HTML parser dependency.
 * Good enough for the standard WP output (rendered content).
 */
export function rewriteMediaUrls(
  html: string,
  state: MigrationState,
  strapiBaseUrl: string,
): string {
  const bySourceUrl = new Map<string, string>();
  for (const media of Object.values(state.media)) {
    const absolute = media.url.startsWith("http")
      ? media.url
      : `${strapiBaseUrl}${media.url}`;
    bySourceUrl.set(media.sourceUrl, absolute);
  }
  if (bySourceUrl.size === 0) return html;

  // Replace any occurrence of a known WP source URL, regardless of attribute.
  // Sort by length desc to avoid prefix collisions.
  const sources = [...bySourceUrl.keys()].sort((a, b) => b.length - a.length);

  let out = html;
  for (const src of sources) {
    const dest = bySourceUrl.get(src);
    if (!dest) continue;
    // Escape regex special chars.
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), dest);
  }
  return out;
}

/** Decode common HTML entities from WP's rendered titles. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'");
}
