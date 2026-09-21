/**
 * Machine-readable notices.
 *
 * The engine serves three front-ends in two languages, so it emits a code plus its parameters
 * rather than a sentence. `message` carries the English rendering as a fallback, which is what
 * the CLI and the Strapi plugin print; a localised front-end keys off `code` instead.
 */

export type NoticeLevel = "info" | "warn" | "error";

/** Every notice the engine can raise. Adding one is a typed change in every front-end. */
export const NOTICE_CODES = [
  "content.empty",
  "content.builder",
  "content.shortcodes",
  "content.unresolvedMedia",
  "content.recovered",
  "content.embedsDropped",
  "content.fallbackFailed",
  "terms.missing",
  "media.none",
  "statuses.needCredentials",
  "mapping.unknownTransform",
  "retry.pending",
  "retry.nothing",
  "http.retry",
  "customType.failed",
  "failures.header",
  "failures.group",
  "failures.hint",
] as const;

export type NoticeCode = (typeof NOTICE_CODES)[number];

/** Parameters carried by each code — what a translation interpolates. */
export interface NoticeParamsByCode {
  "content.empty": { entry: string };
  "content.builder": { entry: string; builder: string };
  "content.shortcodes": { entry: string; count: number; tags: string };
  "content.unresolvedMedia": { entry: string; count: number; examples: string };
  "content.recovered": { entry: string; reason: string; chars: number; url: string };
  "content.embedsDropped": { entry: string; count: number };
  "content.fallbackFailed": { entry: string; url: string; error: string };
  "terms.missing": { entry: string; count: number };
  "media.none": Record<string, never>;
  "statuses.needCredentials": { statuses: string };
  "mapping.unknownTransform": { transform: string; field: string };
  "retry.pending": { count: number };
  "retry.nothing": Record<string, never>;
  "http.retry": { side: string; reason: string; attempt: number; delayMs: number };
  "customType.failed": { restBase: string; error: string };
  "failures.header": { count: number };
  "failures.group": { count: number; kinds: string; cause: string; ids: string; more: boolean };
  "failures.hint": Record<string, never>;
}

export type NoticeParams<C extends NoticeCode = NoticeCode> = NoticeParamsByCode[C];

export interface Notice<C extends NoticeCode = NoticeCode> {
  code: C;
  level: NoticeLevel;
  params: NoticeParamsByCode[C];
  /** English rendering, for front-ends that do not localise. */
  message: string;
}

/** English text for every code. A localised front-end keeps its own table, keyed the same way. */
const EN: { [C in NoticeCode]: (p: NoticeParamsByCode[C]) => string } = {
  "content.empty": (p) => `${p.entry}: WordPress returned empty rendered content — nothing to import`,
  "content.builder": (p) =>
    `${p.entry}: built with ${p.builder} — the layout lives in post meta, so only the flattened ` +
    `REST output is migrated. Expect to rebuild this page.`,
  "content.shortcodes": (p) =>
    `${p.entry}: ${p.count} unexpanded shortcode(s) kept as literal text: ${p.tags}`,
  "content.unresolvedMedia": (p) =>
    `${p.entry}: ${p.count} media URL(s) still point at WordPress (missing from the media map): ` +
    `${p.examples}`,
  "content.recovered": (p) =>
    `${p.entry}: ${p.reason} — recovered ${p.chars} chars of text and images from ${p.url}. ` +
    `Layout and styling are not migrated.`,
  "content.embedsDropped": (p) =>
    `${p.entry}: ${p.count} embed(s) (iframe/video/audio) dropped from the recovered content — ` +
    `re-add them by hand if they matter.`,
  "content.fallbackFailed": (p) =>
    `${p.entry}: could not fetch ${p.url} for fallback: ${p.error}`,
  "terms.missing": (p) =>
    `${p.entry}: ${p.count} term(s) not in the state file — run the categories and tags steps ` +
    `before posts, or the relations stay empty.`,
  "media.none": () =>
    "No media in the state file: every media URL in the imported content will keep pointing at " +
    "WordPress. Run the media step first (or with this one).",
  "statuses.needCredentials": (p) =>
    `Statuses ${p.statuses} need WordPress credentials — without them the REST API only returns ` +
    `published content.`,
  "mapping.unknownTransform": (p) =>
    `unknown transform "${p.transform}" on field "${p.field}" — skipped`,
  "retry.pending": (p) => `Retrying ${p.count} entr${p.count === 1 ? "y" : "ies"} that failed previously.`,
  "retry.nothing": () => "Nothing to retry — the state file records no failures.",
  "http.retry": (p) => `${p.side}: ${p.reason} — retry ${p.attempt} in ${p.delayMs}ms`,
  "customType.failed": (p) => `custom type "${p.restBase}": ${p.error}`,
  "failures.header": (p) =>
    `${p.count} entr${p.count === 1 ? "y" : "ies"} failed, grouped by cause:`,
  "failures.group": (p) =>
    `  ${p.count}× [${p.kinds}] ${p.cause} (ids ${p.ids}${p.more ? ", …" : ""})`,
  "failures.hint": () => "Re-run with retryFailed (CLI: --retry-failed) to retry just these.",
};

/** Render a notice in English. */
export function describeNotice<C extends NoticeCode>(
  code: C,
  params: NoticeParamsByCode[C],
): string {
  return EN[code](params);
}

/** Build a notice with its English rendering attached. */
export function notice<C extends NoticeCode>(
  code: C,
  params: NoticeParamsByCode[C],
  level: NoticeLevel = "warn",
): Notice<C> {
  return { code, level, params, message: describeNotice(code, params) };
}
