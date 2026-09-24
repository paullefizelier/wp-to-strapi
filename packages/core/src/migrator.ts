import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import pLimit from "p-limit";
import type { AppConfig, CustomTypeConfig, RouteConfig } from "./config.js";
import { extractReadableContent } from "./content-extract.js";
import {
  decodeEntities,
  detectFlavour,
  findShortcodes,
  findUnresolvedMediaUrls,
  rewriteMediaUrls,
} from "./html-transform.js";
import {
  applyMapping,
  defaultAuthorMapping,
  defaultCommentMapping,
  defaultEntryMapping,
  defaultMenuMapping,
  defaultTermMapping,
  mergeMappings,
  validateMapping,
  type FieldMapping,
} from "./mapping.js";
import { notice, type Notice, type NoticeCode, type NoticeParamsByCode } from "./notices.js";
import { StateStore, type MediaFormat } from "./state.js";
import type { StrapiAdapter, WriteOptions } from "./strapi-adapter.js";
import { StrapiClient } from "./strapi-client.js";
import type {
  StrapiUploadFile,
  WpComment,
  WpMedia,
  WpMenu,
  WpMenuItem,
  WpPage,
  WpPost,
  WpTerm,
  WpUser,
} from "./types.js";
import { WordPressClient } from "./wordpress-client.js";

/**
 * Compare category names the way people type them: "Communiqués de presse", "communiques de
 * presse" and the slug "communiques-de-presse" are the same category.
 */
function normaliseTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The path part of a WordPress permalink — what a redirect rule matches on. */
function pathOf(link: string | undefined): string {
  if (!link) return "";
  try {
    return new URL(link).pathname;
  } catch {
    return link.startsWith("/") ? link : "";
  }
}

/**
 * The name the file gets in Strapi: WordPress URLs percent-encode accents (`actualite%CC%81s`),
 * and a few attachments (oEmbed captures, some plugins) have no extension at all.
 */
export function mediaFileName(m: Pick<WpMedia, "source_url" | "mime_type">): string {
  const raw = basename(new URL(m.source_url).pathname);
  let name: string;
  try {
    name = decodeURIComponent(raw).normalize("NFC");
  } catch {
    name = raw;
  }
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const subtype = m.mime_type?.split("/")[1]?.split(/[+;]/)[0];
    const ext = subtype === "jpeg" ? "jpg" : subtype;
    if (ext && /^[a-z0-9]{2,5}$/i.test(ext)) name = `${name}.${ext}`;
  }
  return name;
}

/** What any post-like entry says about itself, before anything is written. */
function entryInfo(p: WpPost | WpPage, uid?: string, route?: string): ItemDetails {
  return {
    title: decodeEntities(p.title?.rendered ?? "") || p.slug,
    slug: p.slug,
    source: p.link,
    wpStatus: p.status,
    ...(uid ? { target: uid } : {}),
    ...(route ? { route } : {}),
  };
}

/** Keep the responsive variants Strapi generated so `srcset` can be rebuilt on the way out. */
function toMediaFormats(file: StrapiUploadFile): MediaFormat[] {
  return Object.values(file.formats ?? {})
    .flatMap((f) => (f?.url && f.width ? [{ url: f.url, width: f.width }] : []))
    .sort((a, b) => a.width - b.width);
}

export type Kind =
  | "media"
  | "categories"
  | "tags"
  | "taxonomies"
  | "authors"
  | "posts"
  | "pages"
  | "custom"
  | "comments"
  | "menus";

/**
 * What happened to one entry, for a front-end to show in detail. Everything is optional:
 * each kind fills what it knows, and `detail`/`message` stay the one-line summary.
 */
export interface ItemDetails {
  /** Human label: the post title, the file name, the term name. */
  title?: string;
  slug?: string;
  /** Where the entry lives in WordPress (permalink, file URL). */
  source?: string;
  /** WordPress status (publish, draft, future…). */
  wpStatus?: string;
  /** Strapi content-type written to, or "upload" for media. */
  target?: string;
  /** The route that took the entry, when routing is configured. */
  route?: string;
  /** "dry-run" when nothing was written. */
  action?: "created" | "updated" | "uploaded" | "dry-run";
  /** Publication state in Strapi. */
  status?: "published" | "draft";
  documentId?: string;
  /** Media: numeric Strapi file id, its URL, size in bytes, MIME type. */
  mediaId?: number;
  url?: string;
  size?: number;
  mime?: string;
  /** Written fields, each value shortened to a readable one-liner. */
  values?: Record<string, string>;
  /** Warnings raised for this entry (also emitted as log events). */
  notices?: Notice[];
}

/** One-line rendering of each payload field: HTML flattened to text, structures as JSON. */
export function summarizeValues(data: Record<string, unknown>, max = 160): Record<string, string> {
  const cut = (t: string) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) out[key] = "";
    else if (typeof value === "string") {
      const text = decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
      out[key] = cut(text || (value.trim() ? "(HTML)" : ""));
    } else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else {
      let json: string;
      try {
        json = JSON.stringify(value);
      } catch {
        json = String(value);
      }
      out[key] = cut(json);
    }
  }
  return out;
}

type WriteAction = "created" | "updated" | "dry-run";

export interface MigrateOptions {
  only?: ReadonlyArray<Kind>;
  /** Re-run only the entries the previous run recorded as failed. */
  retryFailed?: boolean;
}

export type MigratorEvent =
  | { type: "run-start"; at: string; kinds: Kind[] }
  | { type: "section-start"; kind: Kind; expected?: number }
  | { type: "section-end"; kind: Kind; total: number }
  | { type: "item-skip"; kind: Kind; wpId: number; reason: string; item?: ItemDetails }
  | { type: "item-ok"; kind: Kind; wpId: number; detail: string; item?: ItemDetails }
  | { type: "item-error"; kind: Kind; wpId: number; message: string; item?: ItemDetails }
  | {
      type: "log";
      level: "info" | "warn" | "error";
      /** English rendering — front-ends that localise use `code` and `params` instead. */
      message: string;
      code?: NoticeCode;
      params?: NoticeParamsByCode[NoticeCode];
    }
  | {
      type: "run-end";
      at: string;
      summary: {
        media: number;
        posts: number;
        pages: number;
        categories: number;
        tags: number;
        custom: number;
      };
      /** Entries still failing after this run, so a caller can act on them. */
      failures: Array<{ kind: string; wpId: number; message: string }>;
    };

export declare interface Migrator {
  on(event: "event", listener: (e: MigratorEvent) => void): this;
  off(event: "event", listener: (e: MigratorEvent) => void): this;
  emit(event: "event", e: MigratorEvent): boolean;
}

/** One entry as it would be written, produced without touching Strapi. */
export interface PreviewItem {
  kind: Kind;
  wpId: number;
  slug: string;
  /** Strapi content-type the payload would go to. */
  uid: string;
  /** The route that took the entry, when routing sent it somewhere specific. */
  route?: string;
  data: Record<string, unknown>;
  notices: Notice[];
  /** Routing would leave this entry out (only reported when previewing chosen ids). */
  skipped?: boolean;
}

export interface PreviewOptions {
  /** Which kind to sample. Defaults to posts. */
  kind?: "posts" | "pages" | "categories" | "tags" | "custom";
  /** REST base when previewing a custom type. */
  restBase?: string;
  /** How many entries to render. */
  limit?: number;
  /** Render exactly these WordPress ids instead of the first few. */
  ids?: number[];
}

/** One entry of a listing to pick from: what it is and where it would land. */
export interface CatalogueEntry {
  wpId: number;
  title: string;
  slug: string;
  status: string;
  date: string;
  link?: string;
  /** Category names, to filter on. */
  categories: string[];
  /** Content-type it would be written to; null when routing skips it. */
  uid: string | null;
  route?: string;
}

export interface CatalogueOptions {
  kind: "posts" | "pages" | "custom";
  /** REST base of the custom type, when `kind` is custom. */
  restBase?: string;
}

export interface MigratorDeps {
  /**
   * Optional override for the Strapi side. When omitted, the Migrator spins up an HTTP
   * StrapiClient using cfg.strapi.baseUrl + token. The Strapi plugin passes its own
   * NativeStrapiAdapter instead, which talks to strapi.documents() directly.
   */
  strapi?: StrapiAdapter;
  wp?: WordPressClient;
}

export class Migrator extends EventEmitter {
  private readonly wp: WordPressClient;
  private readonly strapi: StrapiAdapter;
  private readonly state: StateStore;
  private readonly limit: ReturnType<typeof pLimit>;
  private retryFailed = false;
  /** Whether this run has a media map to rewrite against. */
  private mediaMigrated = false;
  /** Each route with its categories and tags resolved to WordPress ids. */
  private resolvedRoutes: Array<{ route: RouteConfig; categories: Set<number>; tags: Set<number> }> = [];
  /** How many entries each route took this run, for the summary. */
  private routeCounts = new Map<string, number>();

  constructor(private readonly cfg: AppConfig, deps: MigratorDeps = {}) {
    super();
    this.wp =
      deps.wp ??
      new WordPressClient({
        baseUrl: cfg.wp.baseUrl,
        username: cfg.wp.username,
        appPassword: cfg.wp.appPassword,
        pageSize: cfg.pageSize,
        retries: cfg.retries,
        onRetry: (attempt, delayMs, reason) => this.reportRetry("WordPress", attempt, delayMs, reason),
      });
    this.strapi =
      deps.strapi ??
      new StrapiClient({
        baseUrl: cfg.strapi.baseUrl,
        token: cfg.strapi.token,
        retries: cfg.retries,
        onRetry: (attempt, delayMs, reason) => this.reportRetry("Strapi", attempt, delayMs, reason),
      });
    this.state = new StateStore(cfg.stateFile, { readOnly: cfg.dryRun });
    this.limit = pLimit(cfg.concurrency);
  }

  private fire(e: MigratorEvent): void {
    this.emit("event", e);
  }

  /** Emit a notice as a log event, keeping the code and its parameters alongside the text. */
  private say(n: Notice): void {
    this.fire({
      type: "log",
      level: n.level,
      message: n.message,
      code: n.code,
      params: n.params,
    });
  }

  /** Surface waiting as progress, so a throttled run does not look frozen. */
  private reportRetry(side: string, attempt: number, delayMs: number, reason: string): void {
    this.say(notice("http.retry", { side, reason, attempt, delayMs }));
  }

  /**
   * Rows for one kind: the configured mapping if there is one, the built-in otherwise, with
   * the `common` rows merged underneath so a shared field lands on every entry.
   */
  private mappingFor(
    kind: "post" | "page" | "category" | "tag",
    restBase?: string,
    routeName?: string,
  ): FieldMapping[] {
    const set = this.cfg.mapping ?? {};
    const isTerm = kind === "category" || kind === "tag";
    const configured = routeName
      ? (set.route?.[routeName] ?? set[kind])
      : restBase
        ? (set.custom?.[restBase] ?? set.post)
        : set[kind];
    return mergeMappings(set.common, configured ?? (isTerm ? defaultTermMapping() : defaultEntryMapping()));
  }

  /**
   * Resolve every route's categories and tags to WordPress ids, once, before anything is
   * written. A name that matches nothing stops the run: an article silently sent to the wrong
   * content-type is far harder to undo than a run that did not start.
   */
  private async resolveRoutes(): Promise<void> {
    const routes = this.cfg.routing.routes;
    this.resolvedRoutes = [];
    if (routes.length === 0) return;

    const needs = (key: "categories" | "tags") => routes.some((r) => (r[key] ?? []).length > 0);
    const lookup = async (taxonomy: "categories" | "tags") => {
      const byKey = new Map<string, number>();
      const labels: string[] = [];
      for await (const term of this.wp.terms(taxonomy)) {
        byKey.set(String(term.id), term.id);
        byKey.set(normaliseTerm(term.slug), term.id);
        byKey.set(normaliseTerm(decodeEntities(term.name ?? "")), term.id);
        labels.push(decodeEntities(term.name ?? term.slug));
      }
      return { byKey, labels };
    };
    const categories = needs("categories") ? await lookup("categories") : undefined;
    const tags = needs("tags") ? await lookup("tags") : undefined;

    const problems: string[] = [];
    const resolve = (route: RouteConfig, taxonomy: "categories" | "tags") => {
      const table = taxonomy === "categories" ? categories : tags;
      const ids = new Set<number>();
      for (const wanted of route[taxonomy] ?? []) {
        const id = table?.byKey.get(normaliseTerm(String(wanted)));
        if (id === undefined) {
          const n = notice(
            "routing.unknownTerm",
            {
              route: route.name,
              taxonomy,
              term: String(wanted),
              available: (table?.labels ?? []).slice(0, 12).join(", ") || "—",
            },
            "error",
          );
          this.say(n);
          problems.push(n.message);
        } else ids.add(id);
      }
      return ids;
    };

    for (const route of routes) {
      this.resolvedRoutes.push({
        route,
        categories: resolve(route, "categories"),
        tags: resolve(route, "tags"),
      });
    }
    if (problems.length > 0) throw new Error(`Invalid routing: ${problems.join("; ")}`);
  }

  /** The first route that takes this entry, if any. */
  private routeFor(entry: WpPost | WpPage, from: "posts" | "pages"): RouteConfig | undefined {
    for (const { route, categories, tags } of this.resolvedRoutes) {
      if ((route.from ?? "posts") !== from) continue;
      if ((entry.categories ?? []).some((id) => categories.has(id))) return route;
      if ((entry.tags ?? []).some((id) => tags.has(id))) return route;
    }
    return undefined;
  }

  private countRoute(name: string): void {
    this.routeCounts.set(name, (this.routeCounts.get(name) ?? 0) + 1);
  }

  /** Fail on a broken mapping before writing anything, not entry by entry. */
  private assertMappingValid(): void {
    const sets: Array<[string, FieldMapping[] | undefined]> = [
      ["common", this.cfg.mapping?.common],
      ["post", this.cfg.mapping?.post],
      ["page", this.cfg.mapping?.page],
      ["category", this.cfg.mapping?.category],
      ["tag", this.cfg.mapping?.tag],
      ...Object.entries(this.cfg.mapping?.custom ?? {}).map(
        ([restBase, rows]) => [`custom.${restBase}`, rows] as [string, FieldMapping[]],
      ),
    ];
    const problems = sets.flatMap(([name, rows]) =>
      rows ? validateMapping(rows).map((i) => `${name}.${i.target || "?"}: ${i.message}`) : [],
    );
    // A mapping that drops the correlation field turns every re-run into a duplicate import.
    const key = this.cfg.strapi.correlationField;
    const kinds: Array<["post" | "page" | "category" | "tag", string | undefined]> = [
      ["post", undefined],
      ["page", undefined],
      ["category", undefined],
      ["tag", undefined],
      ...this.cfg.customTypes.map(
        (t) => ["post", t.restBase] as ["post", string],
      ),
    ];
    for (const route of this.cfg.routing.routes) {
      if (!route.uid) problems.push(`route "${route.name}": no Strapi content-type`);
      if (!route.name) problems.push("a route has no name");
      const rows = this.mappingFor(route.from === "pages" ? "page" : "post", undefined, route.name);
      if (!rows.some((row) => row.target === this.cfg.strapi.correlationField)) {
        problems.push(
          `route "${route.name}": the mapping never writes "${this.cfg.strapi.correlationField}", ` +
            `so re-running would create duplicates instead of updating.`,
        );
      }
    }
    for (const [name, rows] of Object.entries(this.cfg.mapping?.route ?? {})) {
      for (const issue of validateMapping(rows)) {
        problems.push(`route.${name}.${issue.target || "?"}: ${issue.message}`);
      }
    }
    for (const [kind, restBase] of kinds) {
      if (kind === "category" && !this.cfg.strapi.categoryUid) continue;
      if (kind === "tag" && !this.cfg.strapi.tagUid) continue;
      const rows = this.mappingFor(kind, restBase);
      if (!rows.some((row) => row.target === key)) {
        problems.push(
          `${restBase ?? kind}: the mapping never writes "${key}", so re-running would create ` +
            `duplicates instead of updating. Add it, or change strapi.correlationField.`,
        );
      }
    }

    if (problems.length > 0) {
      for (const message of problems) this.fire({ type: "log", level: "error", message });
      throw new Error(`Invalid field mapping: ${problems.join("; ")}`);
    }
  }

  /** Everything this configuration can migrate, in dependency order. */
  private configuredKinds(): Kind[] {
    const kinds: Kind[] = ["media"];
    if (this.cfg.strapi.categoryUid) kinds.push("categories");
    if (this.cfg.strapi.tagUid) kinds.push("tags");
    if (this.cfg.taxonomies.length > 0) kinds.push("taxonomies");
    if (this.cfg.strapi.authorUid) kinds.push("authors");
    kinds.push("posts", "pages");
    if (this.cfg.customTypes.length > 0) kinds.push("custom");
    if (this.cfg.strapi.commentUid) kinds.push("comments");
    if (this.cfg.strapi.menuUid) kinds.push("menus");
    return kinds;
  }

  async run(opts: MigrateOptions = {}): Promise<void> {
    this.assertMappingValid();
    await this.state.load();
    await this.state.assertWritable();
    await this.resolveRoutes();
    this.routeCounts = new Map();
    this.retryFailed = opts.retryFailed === true;
    if (this.retryFailed) {
      const pending = this.state.allFailures().length;
      this.say(
        pending > 0
          ? notice("retry.pending", { count: pending }, "info")
          : notice("retry.nothing", {}, "info"),
      );
      if (pending === 0) {
        this.fire({
          type: "run-end",
          at: new Date().toISOString(),
          summary: this.summary(),
          failures: [],
        });
        return;
      }
    }
    const configured = this.configuredKinds();
    const kinds = opts.only ? configured.filter((k) => opts.only?.includes(k)) : configured;
    this.fire({ type: "run-start", at: new Date().toISOString(), kinds });

    const extraStatuses = this.cfg.statuses.filter((st) => st !== "publish");
    if (extraStatuses.length > 0 && !this.wp.authenticated) {
      this.say(notice("statuses.needCredentials", { statuses: extraStatuses.join(", ") }));
    }

    // Media and taxonomies first: posts reference both.
    if (kinds.includes("media")) await this.migrateMedia();
    this.mediaMigrated = Object.keys(this.state.get().media).length > 0;
    if (!this.mediaMigrated && (kinds.includes("posts") || kinds.includes("pages"))) {
      this.say(notice("media.none", {}));
    }
    if (kinds.includes("categories")) {
      await this.migrateTerms("categories", this.cfg.strapi.categoryUid, this.cfg.strapi.categoryPluralPath);
    }
    if (kinds.includes("tags")) {
      await this.migrateTerms("tags", this.cfg.strapi.tagUid, this.cfg.strapi.tagPluralPath);
    }
    if (kinds.includes("taxonomies")) {
      for (const taxonomy of this.cfg.taxonomies) {
        await this.migrateTerms(taxonomy.restBase, taxonomy.uid, taxonomy.pluralPath, "taxonomies");
      }
    }
    if (kinds.includes("authors")) await this.migrateAuthors();
    if (kinds.includes("posts")) await this.migratePosts();
    if (kinds.includes("pages")) await this.migratePages();
    if (kinds.includes("custom")) await this.migrateCustomTypes();
    // Hierarchies need every document to exist first.
    if (kinds.includes("pages") && this.cfg.strapi.parentField) await this.linkPageHierarchy();
    if (kinds.includes("categories") && this.cfg.strapi.termParentField) {
      await this.linkTermHierarchy();
    }
    if (kinds.includes("comments")) await this.migrateComments();
    if (kinds.includes("menus")) await this.migrateMenus();
    await this.writeRedirects();
    if (this.routeCounts.size > 0) {
      const counts = [...this.routeCounts.entries()].map(([name, n]) => `${n} → ${name}`).join(", ");
      this.say(notice("routing.summary", { counts }, "info"));
    }

    await this.state.persist();
    if (this.wp.redirected) {
      this.say(
        notice("wp.redirected", { from: this.cfg.wp.baseUrl, to: this.wp.resolvedBaseUrl }, "info"),
      );
    }
    const failures = this.state.allFailures();
    this.reportFailures(failures);
    this.fire({
      type: "run-end",
      at: new Date().toISOString(),
      summary: this.summary(),
      failures,
    });
  }

  /**
   * How many entries a section will walk, honouring the configured statuses, the selection
   * and any retry. A narrowed scope counts ids asked for, which may include some WordPress
   * no longer has — close enough for a progress bar.
   */
  private async expectedCount(restBase: string): Promise<number> {
    const scope = this.scope(restBase === "posts" || restBase === "pages" ? restBase : `custom:${restBase}`);
    if (scope) return scope.length;
    return this.wp.count(restBase, { status: this.cfg.statuses.join(",") });
  }

  /** The ids the user picked for a kind (`posts`, `pages`, `custom:<restBase>`); undefined = all. */
  private selectedIds(kind: string): number[] | undefined {
    const sel = this.cfg.selection ?? {};
    if (kind === "posts") return sel.posts;
    if (kind === "pages") return sel.pages;
    if (kind.startsWith("custom:")) return sel.custom?.[kind.slice("custom:".length)];
    return undefined;
  }

  /**
   * Narrow a listing to the selected ids and, on a retry run, to those that failed.
   * Undefined means take everything.
   */
  private scope(kind: string): number[] | undefined {
    const selected = this.selectedIds(kind);
    let ids: number[] | undefined = selected;
    if (this.retryFailed) {
      const failed = this.state.failedIds(kind);
      ids = selected ? failed.filter((id) => selected.includes(id)) : failed;
    }
    // An empty list means nothing: the listing is not even requested (see WordPressClient).
    return ids;
  }

  private summary() {
    const s = this.state.get();
    return {
      media: Object.keys(s.media).length,
      posts: Object.keys(s.posts).length,
      pages: Object.keys(s.pages).length,
      categories: Object.keys(s.categories).length,
      tags: Object.keys(s.tags).length,
      custom: Object.values(s.custom).reduce((n, bucket) => n + Object.keys(bucket).length, 0),
    };
  }

  /**
   * Group what failed by cause. Three hundred identical "403 Forbidden" lines scrolled past in
   * the log are one problem, and reading them one by one is nobody's idea of a report.
   */
  private reportFailures(failures: Array<{ kind: string; wpId: number; message: string }>): void {
    if (failures.length === 0) return;
    const groups = new Map<string, { count: number; kinds: Set<string>; ids: number[] }>();
    for (const f of failures) {
      // Collapse the parts that differ per entry so identical causes land together.
      const cause = f.message
        .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<date>")
        .replace(/\/\d+\b/g, "/<id>")
        .replace(/\b\d{3,}\b/g, "<n>")
        .slice(0, 160);
      const group = groups.get(cause) ?? { count: 0, kinds: new Set<string>(), ids: [] };
      group.count += 1;
      group.kinds.add(f.kind);
      if (group.ids.length < 5) group.ids.push(f.wpId);
      groups.set(cause, group);
    }

    this.say(notice("failures.header", { count: failures.length }, "error"));
    for (const [cause, g] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
      this.say(
        notice(
          "failures.group",
          {
            count: g.count,
            kinds: [...g.kinds].join(", "),
            cause,
            ids: g.ids.join(", "),
            more: g.count > g.ids.length,
          },
          "error",
        ),
      );
    }
    this.say(notice("failures.hint", {}, "info"));
  }

  // ----- Taxonomies -----

  private async migrateTerms(
    taxonomy: string,
    uid: string | undefined,
    pluralOverride: string | undefined,
    reportAs: Kind = taxonomy === "tags" ? "tags" : "categories",
  ): Promise<void> {
    if (!uid) return;
    this.fire({ type: "section-start", kind: reportAs, expected: await this.wp.count(taxonomy) });
    const tasks: Promise<void>[] = [];
    let count = 0;
    for await (const term of this.wp.terms(taxonomy)) {
      count += 1;
      tasks.push(
        this.limit(() => this.migrateOneTerm(taxonomy, term, uid, pluralOverride, reportAs)),
      );
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind: reportAs, total: count });
  }

  private async migrateOneTerm(
    taxonomy: string,
    term: WpTerm,
    uid: string,
    pluralOverride?: string,
    kind: Kind = "categories",
  ): Promise<void> {
    if (this.retryFailed && !this.state.failedIds(taxonomy).includes(term.id)) return;
    const info: ItemDetails = {
      title: decodeEntities(term.name),
      slug: term.slug,
      source: term.link,
      target: uid,
    };
    try {
      const mapped = applyMapping(term, this.termMapping(taxonomy), {
        state: this.state.get(),
        strapiBaseUrl: this.cfg.strapi.baseUrl,
      });
      for (const n of mapped.notices) this.say(n);
      const data = mapped.data;
      const item: ItemDetails = {
        ...info,
        values: summarizeValues(data),
        ...(mapped.notices.length > 0 ? { notices: mapped.notices } : {}),
      };
      if (this.cfg.dryRun) {
        this.fire({
          type: "item-ok",
          kind,
          wpId: term.id,
          detail: `[dry-run] ${term.slug}`,
          item: { ...item, action: "dry-run" },
        });
        return;
      }
      const saved = await this.upsertRecord(uid, pluralOverride, term.id, data);
      this.state.setTerm(taxonomy, term.id, saved.documentId);
      this.state.clearFailure(taxonomy, term.id);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind,
        wpId: term.id,
        detail: `${term.slug} → ${saved.documentId}`,
        item: { ...item, action: saved.action, status: "published", documentId: saved.documentId },
      });
    } catch (err) {
      this.state.recordFailure(taxonomy, term.id, (err as Error).message);
      await this.state.persist();
      this.fire({ type: "item-error", kind, wpId: term.id, message: (err as Error).message, item: info });
    }
  }

  // ----- Custom post types -----

  private async migrateCustomTypes(): Promise<void> {
    const expected = (
      await Promise.all(this.cfg.customTypes.map((t) => this.expectedCount(t.restBase)))
    ).reduce((a, b) => a + b, 0);
    this.fire({ type: "section-start", kind: "custom", expected });
    let count = 0;
    for (const type of this.cfg.customTypes) {
      const tasks: Promise<void>[] = [];
      try {
        for await (const entry of this.wp.customType(
          type.restBase,
          this.cfg.statuses,
          this.scope(`custom:${type.restBase}`),
        )) {
          // A single type only wants one WordPress entry — the one named, or the first.
          if (type.single) {
            const wanted =
              (type.wpId !== undefined && entry.id !== type.wpId) ||
              (type.slug !== undefined && entry.slug !== type.slug);
            if (wanted) continue;
            count += 1;
            tasks.push(this.limit(() => this.migrateOneCustom(entry, type)));
            break;
          }
          count += 1;
          tasks.push(this.limit(() => this.migrateOneCustom(entry, type)));
        }
      } catch (err) {
        this.say(
          notice(
            "customType.failed",
            { restBase: type.restBase, error: (err as Error).message },
            "error",
          ),
        );
      }
      await Promise.all(tasks);
    }
    this.fire({ type: "section-end", kind: "custom", total: count });
  }

  private async migrateOneCustom(p: WpPost, type: CustomTypeConfig): Promise<void> {
    try {
      const { documentId, item } = await this.upsertEntry(type.uid, p, type.pluralPath, {
        restBase: type.restBase,
        single: type.single === true,
      });
      this.state.setCustom(type.restBase, p.id, documentId);
      this.state.addRedirect(pathOf(p.link), p.slug, type.restBase, documentId);
      this.state.clearFailure(`custom:${type.restBase}`, p.id);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind: "custom",
        wpId: p.id,
        detail: `${type.restBase}/${p.slug} → ${documentId}`,
        item,
      });
    } catch (err) {
      this.state.recordFailure(`custom:${type.restBase}`, p.id, (err as Error).message);
      await this.state.persist();
      this.fire({
        type: "item-error",
        kind: "custom",
        wpId: p.id,
        message: (err as Error).message,
        item: entryInfo(p, type.uid),
      });
    }
  }

  /**
   * Render what a run would write, without writing it.
   *
   * A mapping is only trustworthy if you can see its output before pointing it at three
   * thousand posts. This runs the real pipeline — fallback, media rewriting, relations,
   * transforms — and hands back the payloads and the warnings, touching nothing.
   */
  async preview(opts: PreviewOptions = {}): Promise<PreviewItem[]> {
    this.assertMappingValid();
    await this.state.load();
    await this.resolveRoutes();
    const ids = opts.ids && opts.ids.length > 0 ? opts.ids : undefined;
    const limit = Math.max(1, ids?.length ?? opts.limit ?? 3);
    const kind = opts.kind ?? "posts";
    const items: PreviewItem[] = [];

    if (kind === "categories" || kind === "tags") {
      const uid = kind === "categories" ? this.cfg.strapi.categoryUid : this.cfg.strapi.tagUid;
      if (!uid) throw new Error(`No Strapi UID configured for ${kind}`);
      for await (const term of this.wp.terms(kind)) {
        const mapped = applyMapping(term, this.termMapping(kind), {
          state: this.state.get(),
          strapiBaseUrl: this.cfg.strapi.baseUrl,
        });
        items.push({
          kind,
          uid,
          wpId: term.id,
          slug: term.slug,
          data: mapped.data,
          notices: mapped.notices,
        });
        if (items.length >= limit) break;
      }
      return items;
    }

    const custom = kind === "custom" ? this.cfg.customTypes.find(
      (t) => !opts.restBase || t.restBase === opts.restBase,
    ) : undefined;
    if (kind === "custom" && !custom) throw new Error("No custom type configured to preview");

    const source =
      kind === "pages"
        ? this.wp.pages(this.cfg.statuses, ids)
        : custom
          ? this.wp.customType(custom.restBase, this.cfg.statuses, ids)
          : this.wp.posts(this.cfg.statuses, ids);
    const defaultUid = kind === "pages"
      ? this.cfg.strapi.pageUid
      : (custom?.uid ?? this.cfg.strapi.postUid);

    for await (const entry of source) {
      // Show where each entry would land, so a routing mistake is visible before any write.
      const route = custom ? undefined : this.routeFor(entry, kind === "pages" ? "pages" : "posts");
      const skipped =
        !custom && !route && this.resolvedRoutes.length > 0 && this.cfg.routing.unmatched === "skip";
      // Asked for by id, a skipped entry is still shown — saying why beats showing nothing.
      if (skipped && !ids) continue;
      const built = await this.buildEntryData(
        entry,
        kind === "pages" ? "page" : "post",
        custom?.restBase,
        route?.name,
      );
      items.push({
        kind: kind === "custom" ? "custom" : kind,
        uid: route?.uid ?? defaultUid,
        route: route?.name,
        wpId: entry.id,
        slug: entry.slug,
        data: built.data,
        notices: built.notices,
        ...(skipped ? { skipped: true } : {}),
      });
      if (items.length >= limit) break;
    }

    if (Object.keys(this.state.get().media).length === 0) {
      for (const item of items) item.notices.push(notice("media.none", {}));
    }
    return items;
  }


  /**
   * Everything a run would walk for a kind, light enough to list a whole site: no content,
   * just what identifies each entry and where routing would send it.
   */
  async catalogue(opts: CatalogueOptions): Promise<CatalogueEntry[]> {
    await this.resolveRoutes();
    const custom =
      opts.kind === "custom"
        ? this.cfg.customTypes.find((t) => !opts.restBase || t.restBase === opts.restBase)
        : undefined;
    if (opts.kind === "custom" && !custom) throw new Error("No custom type configured to list");

    // Category names make the list filterable; a site that hides them just lists ids-less.
    const names = new Map<number, string>();
    if (opts.kind !== "pages") {
      try {
        for await (const t of this.wp.terms("categories")) names.set(t.id, decodeEntities(t.name));
      } catch {
        /* names are a convenience */
      }
    }

    const fields = ["id", "title", "slug", "status", "date", "link", "categories", "tags", "type"];
    const source =
      opts.kind === "pages"
        ? this.wp.pages(this.cfg.statuses, undefined, fields)
        : custom
          ? this.wp.customType(custom.restBase, this.cfg.statuses, undefined, fields)
          : this.wp.posts(this.cfg.statuses, undefined, fields);
    const defaultUid =
      opts.kind === "pages" ? this.cfg.strapi.pageUid : (custom?.uid ?? this.cfg.strapi.postUid);

    const out: CatalogueEntry[] = [];
    for await (const entry of source) {
      const route = custom ? undefined : this.routeFor(entry, opts.kind === "pages" ? "pages" : "posts");
      const skipped =
        !custom && !route && this.resolvedRoutes.length > 0 && this.cfg.routing.unmatched === "skip";
      out.push({
        wpId: entry.id,
        title: decodeEntities(entry.title?.rendered ?? "") || entry.slug,
        slug: entry.slug,
        status: entry.status,
        date: entry.date,
        link: entry.link,
        categories: (entry.categories ?? []).map((id) => names.get(id) ?? `#${id}`),
        uid: skipped ? null : (route?.uid ?? defaultUid),
        ...(route ? { route: route.name } : {}),
      });
    }
    return out;
  }

  /** Rows for a taxonomy: its own mapping if configured, the term default otherwise. */
  private termMapping(taxonomy: string): FieldMapping[] {
    const set = this.cfg.mapping ?? {};
    const own =
      taxonomy === "categories"
        ? set.category
        : taxonomy === "tags"
          ? set.tag
          : set.taxonomy?.[taxonomy];
    return mergeMappings(set.common, own ?? defaultTermMapping());
  }

  // ----- Authors -----

  /** WordPress users become entries, relatable from a post with `terms:authors`. */
  private async migrateAuthors(): Promise<void> {
    const uid = this.cfg.strapi.authorUid;
    if (!uid) return;
    this.fire({ type: "section-start", kind: "authors", expected: await this.wp.count("users") });
    let count = 0;
    const tasks: Promise<void>[] = [];
    for await (const user of this.wp.users()) {
      count += 1;
      tasks.push(this.limit(() => this.migrateOneAuthor(user, uid)));
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind: "authors", total: count });
  }

  private async migrateOneAuthor(user: WpUser, uid: string): Promise<void> {
    if (this.retryFailed && !this.state.failedIds("authors").includes(user.id)) return;
    const info: ItemDetails = { title: user.name, slug: user.slug, source: user.link, target: uid };
    try {
      const set = this.cfg.mapping ?? {};
      const mapped = applyMapping(user, mergeMappings(set.common, set.author ?? defaultAuthorMapping()), {
        state: this.state.get(),
        strapiBaseUrl: this.cfg.strapi.baseUrl,
      });
      for (const n of mapped.notices) this.say(n);
      const item: ItemDetails = {
        ...info,
        values: summarizeValues(mapped.data),
        ...(mapped.notices.length > 0 ? { notices: mapped.notices } : {}),
      };
      if (this.cfg.dryRun) {
        this.fire({
          type: "item-ok",
          kind: "authors",
          wpId: user.id,
          detail: `[dry-run] ${user.slug}`,
          item: { ...item, action: "dry-run" },
        });
        return;
      }
      const { documentId, action } = await this.upsertRecord(
        uid,
        this.cfg.strapi.authorPluralPath,
        user.id,
        mapped.data,
      );
      this.state.setTerm("authors", user.id, documentId);
      this.state.clearFailure("authors", user.id);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind: "authors",
        wpId: user.id,
        detail: `${user.slug} → ${documentId}`,
        item: { ...item, action, status: "published", documentId },
      });
    } catch (err) {
      this.state.recordFailure("authors", user.id, (err as Error).message);
      await this.state.persist();
      this.fire({
        type: "item-error",
        kind: "authors",
        wpId: user.id,
        message: (err as Error).message,
        item: info,
      });
    }
  }

  // ----- Comments -----

  private async migrateComments(): Promise<void> {
    const uid = this.cfg.strapi.commentUid;
    if (!uid) return;
    this.fire({
      type: "section-start",
      kind: "comments",
      expected: await this.wp.count("comments", { status: "approve" }),
    });
    let count = 0;
    const tasks: Promise<void>[] = [];
    for await (const comment of this.wp.comments()) {
      count += 1;
      tasks.push(this.limit(() => this.migrateOneComment(comment, uid)));
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind: "comments", total: count });
  }

  private async migrateOneComment(comment: WpComment, uid: string): Promise<void> {
    if (this.retryFailed && !this.state.failedIds("comments").includes(comment.id)) return;
    const excerpt = summarizeValues({ c: comment.content?.rendered ?? "" }, 60).c;
    const info: ItemDetails = {
      title: excerpt ? `${comment.author_name} : ${excerpt}` : comment.author_name,
      source: comment.link,
      target: uid,
    };
    try {
      const set = this.cfg.mapping ?? {};
      const mapped = applyMapping(
        comment,
        mergeMappings(set.common, set.comment ?? defaultCommentMapping()),
        { state: this.state.get(), strapiBaseUrl: this.cfg.strapi.baseUrl },
      );
      for (const n of mapped.notices) this.say(n);

      // Relate to the entry it belongs to, if that entry was migrated.
      const entry = this.state.get().posts[comment.post] ?? this.state.get().pages[comment.post];
      if (entry) mapped.data[this.cfg.strapi.commentEntryField] = entry.documentId;
      else {
        this.fire({
          type: "item-skip",
          kind: "comments",
          wpId: comment.id,
          reason: `entry ${comment.post} not migrated`,
          item: info,
        });
        return;
      }

      const item: ItemDetails = { ...info, values: summarizeValues(mapped.data) };
      if (this.cfg.dryRun) {
        this.fire({
          type: "item-ok",
          kind: "comments",
          wpId: comment.id,
          detail: "[dry-run]",
          item: { ...item, action: "dry-run" },
        });
        return;
      }
      const { documentId, action } = await this.upsertRecord(
        uid,
        this.cfg.strapi.commentPluralPath,
        comment.id,
        mapped.data,
      );
      this.state.clearFailure("comments", comment.id);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind: "comments",
        wpId: comment.id,
        detail: documentId,
        item: { ...item, action, status: "published", documentId },
      });
    } catch (err) {
      this.state.recordFailure("comments", comment.id, (err as Error).message);
      await this.state.persist();
      this.fire({
        type: "item-error",
        kind: "comments",
        wpId: comment.id,
        message: (err as Error).message,
        item: info,
      });
    }
  }

  // ----- Navigation menus -----

  /**
   * A menu and its items land as one entry: the items are a tree, and modelling every item as
   * its own content-type would force a shape on the destination that few projects want.
   */
  private async migrateMenus(): Promise<void> {
    const uid = this.cfg.strapi.menuUid;
    if (!uid) return;
    this.fire({ type: "section-start", kind: "menus", expected: await this.wp.count("menus") });
    let count = 0;
    for await (const menu of this.wp.menus()) {
      count += 1;
      await this.migrateOneMenu(menu, uid);
    }
    await Promise.all([]);
    this.fire({ type: "section-end", kind: "menus", total: count });
  }

  private async migrateOneMenu(menu: WpMenu, uid: string): Promise<void> {
    try {
      const items: WpMenuItem[] = [];
      for await (const item of this.wp.menuItems(menu.id)) items.push(item);
      const set = this.cfg.mapping ?? {};
      const mapped = applyMapping(menu, mergeMappings(set.common, set.menu ?? defaultMenuMapping()), {
        state: this.state.get(),
        strapiBaseUrl: this.cfg.strapi.baseUrl,
        virtuals: { $items: this.buildMenuTree(items) },
      });
      for (const n of mapped.notices) this.say(n);
      const item: ItemDetails = {
        title: menu.name,
        slug: menu.slug,
        target: uid,
        values: summarizeValues(mapped.data),
      };
      if (this.cfg.dryRun) {
        this.fire({
          type: "item-ok",
          kind: "menus",
          wpId: menu.id,
          detail: `[dry-run] ${menu.slug} (${items.length} items)`,
          item: { ...item, action: "dry-run" },
        });
        return;
      }
      const { documentId, action } = await this.upsertRecord(
        uid,
        this.cfg.strapi.menuPluralPath,
        menu.id,
        mapped.data,
      );
      this.state.clearFailure("menus", menu.id);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind: "menus",
        wpId: menu.id,
        detail: `${menu.slug} (${items.length} items) → ${documentId}`,
        item: { ...item, action, status: "published", documentId },
      });
    } catch (err) {
      this.state.recordFailure("menus", menu.id, (err as Error).message);
      await this.state.persist();
      this.fire({
        type: "item-error",
        kind: "menus",
        wpId: menu.id,
        message: (err as Error).message,
        item: { title: menu.name, slug: menu.slug, target: uid },
      });
    }
  }

  /** Nest menu items by parent, and point internal links at what they became in Strapi. */
  private buildMenuTree(items: WpMenuItem[]): unknown[] {
    const state = this.state.get();
    const toNode = (item: WpMenuItem) => {
      const target =
        item.object_id !== undefined
          ? (state.posts[item.object_id] ?? state.pages[item.object_id])
          : undefined;
      return {
        wpId: item.id,
        label: decodeEntities(
          typeof item.title === "string" ? item.title : (item.title?.rendered ?? ""),
        ).trim(),
        url: item.url,
        order: item.menu_order,
        type: item.type,
        object: item.object,
        /** documentId of the migrated entry this item points at, when there is one. */
        documentId: target?.documentId,
        children: [] as unknown[],
      };
    };
    const nodes = new Map(items.map((i) => [i.id, toNode(i)]));
    const roots: unknown[] = [];
    for (const item of items) {
      const node = nodes.get(item.id);
      if (!node) continue;
      const parent = item.parent ? nodes.get(item.parent) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  // ----- Hierarchies -----

  /** Second pass: a parent's documentId only exists once every page has been created. */
  private async linkPageHierarchy(): Promise<void> {
    const field = this.cfg.strapi.parentField;
    if (!field || this.cfg.dryRun) return;
    const pages = this.state.get().pages;
    let linked = 0;
    for await (const page of this.wp.pages(this.cfg.statuses)) {
      const self = pages[page.id];
      const parent = page.parent ? pages[page.parent] : undefined;
      if (!self || !parent) continue;
      try {
        await this.strapi.update(
          this.cfg.strapi.pageUid,
          self.documentId,
          { [field]: parent.documentId },
          this.cfg.strapi.pagePluralPath,
          { status: page.status === "publish" ? "published" : "draft" },
        );
        linked += 1;
      } catch (err) {
        this.fire({ type: "item-error", kind: "pages", wpId: page.id, message: (err as Error).message });
      }
    }
    if (linked > 0) this.say(notice("hierarchy.linked", { kind: "pages", count: linked }, "info"));
  }

  /** Same for hierarchical taxonomies — WordPress categories can nest. */
  private async linkTermHierarchy(): Promise<void> {
    const field = this.cfg.strapi.termParentField;
    const uid = this.cfg.strapi.categoryUid;
    if (!field || !uid || this.cfg.dryRun) return;
    const bucket = this.state.termBucket("categories");
    let linked = 0;
    for await (const term of this.wp.terms("categories")) {
      const self = bucket[term.id];
      const parent = term.parent ? bucket[term.parent] : undefined;
      if (!self || !parent) continue;
      try {
        await this.strapi.update(
          uid,
          self.documentId,
          { [field]: parent.documentId },
          this.cfg.strapi.categoryPluralPath,
          { status: "published" },
        );
        linked += 1;
      } catch (err) {
        this.fire({ type: "item-error", kind: "categories", wpId: term.id, message: (err as Error).message });
      }
    }
    if (linked > 0) {
      this.say(notice("hierarchy.linked", { kind: "categories", count: linked }, "info"));
    }
  }

  // ----- Redirects -----

  /** The old-URL table, so nothing 404s the day the WordPress install goes away. */
  private async writeRedirects(): Promise<void> {
    const redirects = this.state.get().redirects;
    if (redirects.length === 0) return;
    if (this.cfg.redirectsFile) {
      try {
        await writeFile(this.cfg.redirectsFile, JSON.stringify(redirects, null, 2), "utf8");
      } catch (err) {
        this.say(
          notice("redirects.writeFailed", { file: this.cfg.redirectsFile, error: (err as Error).message }, "error"),
        );
        return;
      }
    }
    this.say(
      notice("redirects.written", { count: redirects.length, file: this.cfg.redirectsFile ?? "" }, "info"),
    );
  }

  /** Upsert a record that is not a post-like entry (author, comment, menu). */
  private async upsertRecord(
    uid: string,
    pluralOverride: string | undefined,
    wpId: number,
    data: Record<string, unknown>,
  ): Promise<{ documentId: string; action: WriteAction }> {
    const existing = await this.strapi.findOneBy(
      uid,
      this.cfg.strapi.correlationField,
      wpId,
      pluralOverride,
    );
    const saved = existing
      ? await this.strapi.update(uid, existing.documentId, data, pluralOverride, {
          status: "published",
        })
      : await this.strapi.create(uid, data, pluralOverride, { status: "published" });
    return { documentId: saved.documentId, action: existing ? "updated" : "created" };
  }

  // ----- Media -----

  private async migrateMedia(): Promise<void> {
    this.fire({
      type: "section-start",
      kind: "media",
      expected: await this.wp.count("media", { status: "inherit" }),
    });
    const tasks: Promise<void>[] = [];
    let count = 0;
    for await (const m of this.wp.media()) {
      count += 1;
      tasks.push(this.limit(() => this.migrateOneMedia(m)));
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind: "media", total: count });
  }

  private async migrateOneMedia(m: WpMedia): Promise<void> {
    if (this.retryFailed && !this.state.failedIds("media").includes(m.id)) return;
    const info: ItemDetails = {
      title: decodeEntities(m.title?.rendered ?? "") || m.slug,
      source: m.source_url,
      target: "upload",
      mime: m.mime_type,
      ...(m.media_details?.filesize ? { size: m.media_details.filesize } : {}),
    };
    const known = this.state.get().media[m.id];
    if (known) {
      this.fire({
        type: "item-skip",
        kind: "media",
        wpId: m.id,
        reason: "already migrated",
        item: { ...info, mediaId: known.strapiId, url: known.url },
      });
      return;
    }
    if (!m.source_url) {
      this.fire({ type: "item-skip", kind: "media", wpId: m.id, reason: "no source_url", item: info });
      return;
    }

    try {
      const fileName = mediaFileName(m);
      info.title = fileName;
      if (this.cfg.dryRun) {
        // Check the file is reachable without downloading it: a site's videos alone can weigh GBs.
        const { size } = await this.wp.checkBinary(m.source_url);
        const bytes = size ?? m.media_details?.filesize;
        this.fire({
          type: "item-ok",
          kind: "media",
          wpId: m.id,
          detail: `[dry-run] ${fileName}${bytes !== undefined ? ` (${bytes}B)` : ""}`,
          item: { ...info, action: "dry-run", ...(bytes !== undefined ? { size: bytes } : {}) },
        });
        return;
      }
      const { buffer, contentType } = await this.wp.fetchBinary(m.source_url);
      const uploaded = await this.strapi.uploadFile({
        buffer,
        fileName,
        contentType: contentType || m.mime_type,
        alternativeText: m.alt_text || decodeEntities(m.title?.rendered ?? ""),
        caption: decodeEntities(m.caption?.rendered ?? ""),
      });
      this.state.setMedia(
        m.id,
        uploaded.id,
        uploaded.url,
        m.source_url,
        toMediaFormats(uploaded),
      );
      this.state.clearFailure("media", m.id);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind: "media",
        wpId: m.id,
        detail: uploaded.url,
        item: {
          ...info,
          action: "uploaded",
          mediaId: uploaded.id,
          url: uploaded.url,
          size: buffer.length,
          mime: contentType || m.mime_type,
        },
      });
    } catch (err) {
      this.state.recordFailure("media", m.id, (err as Error).message);
      await this.state.persist();
      this.fire({
        type: "item-error",
        kind: "media",
        wpId: m.id,
        message: (err as Error).message,
        item: info,
      });
    }
  }

  // ----- Posts & Pages -----

  private async migratePosts(): Promise<void> {
    this.fire({
      type: "section-start",
      kind: "posts",
      expected: await this.expectedCount("posts"),
    });
    const tasks: Promise<void>[] = [];
    let count = 0;
    for await (const p of this.wp.posts(this.cfg.statuses, this.scope("posts"))) {
      count += 1;
      tasks.push(this.limit(() => this.migrateOnePost(p)));
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind: "posts", total: count });
  }

  private async migratePages(): Promise<void> {
    this.fire({
      type: "section-start",
      kind: "pages",
      expected: await this.expectedCount("pages"),
    });
    const tasks: Promise<void>[] = [];
    let count = 0;
    for await (const p of this.wp.pages(this.cfg.statuses, this.scope("pages"))) {
      count += 1;
      tasks.push(this.limit(() => this.migrateOnePage(p)));
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind: "pages", total: count });
  }

  /**
   * Recover content the REST API could not render. Page builders (Elementor, Divi, WPBakery)
   * and FSE templates only emit their markup on the front end, so the public page is fetched
   * and stripped down to text and images. Used only when it beats what REST returned.
   */
  private async resolveContent(p: WpPost | WpPage): Promise<{
    html: string;
    notices: Notice[];
  }> {
    const rendered = p.content?.rendered ?? "";
    const flavour = detectFlavour(rendered);
    const needsFallback =
      flavour === "empty" || flavour === "elementor" || flavour === "divi" || flavour === "wpbakery";
    if (!this.cfg.htmlFallback || !needsFallback || !p.link) return { html: rendered, notices: [] };

    const label = `${p.type ?? "entry"} "${p.slug}" (wpId ${p.id})`;
    try {
      const page = await this.wp.fetchPage(p.link);
      const extracted = extractReadableContent(page, p.link);
      const renderedText = rendered.replace(/<[^>]*>/g, "").trim().length;
      if (extracted.textLength <= renderedText || extracted.textLength === 0) {
        return { html: rendered, notices: [] };
      }
      const notices: Notice[] = [
        notice("content.recovered", {
          entry: label,
          reason: flavour === "empty" ? "empty REST body" : `${flavour} layout`,
          chars: extracted.textLength,
          url: p.link,
        }),
      ];
      if (extracted.droppedEmbeds > 0) {
        notices.push(
          notice("content.embedsDropped", { entry: label, count: extracted.droppedEmbeds }),
        );
      }
      return { html: extracted.html, notices };
    } catch (err) {
      return {
        html: rendered,
        notices: [
          notice("content.fallbackFailed", {
            entry: label,
            url: p.link,
            error: (err as Error).message,
          }),
        ],
      };
    }
  }

  private async buildEntryData(
    p: WpPost | WpPage,
    kind: "post" | "page",
    restBase?: string,
    routeName?: string,
  ): Promise<{ data: Record<string, unknown>; notices: Notice[] }> {
    const resolved = await this.resolveContent(p);
    const state = this.state.get();
    const mapped = applyMapping(p, this.mappingFor(kind, restBase, routeName), {
      state,
      strapiBaseUrl: this.cfg.strapi.baseUrl,
      virtuals: {
        // Values the engine computed rather than ones WordPress sent.
        $content: resolved.html,
        $publishedAt: p.status === "publish" ? `${p.date_gmt}Z` : null,
        $link: p.link,
        $status: p.status,
      },
    });

    const rewritten = rewriteMediaUrls(resolved.html, state, this.cfg.strapi.baseUrl);
    return {
      data: mapped.data,
      notices: [
        ...resolved.notices,
        ...mapped.notices,
        ...this.auditContent(p, resolved.html, rewritten),
      ],
    };
  }

  /**
   * Flag what the REST API could not hand over: page-builder layouts living in post meta,
   * unexpanded shortcodes, and media still pointing at WordPress. Silent blanks are the
   * failure mode that bites weeks later, once the WP install is gone.
   */
  private auditContent(p: WpPost | WpPage, rendered: string, rewritten: string): Notice[] {
    const label = `${p.type ?? "entry"} "${p.slug}" (wpId ${p.id})`;
    const notices: Notice[] = [];

    const flavour = detectFlavour(rendered);
    if (flavour === "empty") {
      notices.push(notice("content.empty", { entry: label }));
    } else if (flavour === "elementor" || flavour === "divi" || flavour === "wpbakery") {
      notices.push(notice("content.builder", { entry: label, builder: flavour }));
    }

    const shortcodes = findShortcodes(rendered);
    if (shortcodes.length > 0) {
      notices.push(
        notice("content.shortcodes", {
          entry: label,
          count: shortcodes.length,
          tags: shortcodes.slice(0, 5).map((t) => `[${t}]`).join(" "),
        }),
      );
    }

    const state = this.state.get();
    const missingTerms = [
      ...(this.cfg.strapi.categoryUid
        ? (p.categories ?? []).filter((id) => !state.categories[id])
        : []),
      ...(this.cfg.strapi.tagUid ? (p.tags ?? []).filter((id) => !state.tags[id]) : []),
    ];
    if (missingTerms.length > 0) {
      notices.push(notice("terms.missing", { entry: label, count: missingTerms.length }));
    }

    // With no media map at all, every entry would repeat the same warning; the run says it
    // once instead (see `warnAboutMissingMedia`).
    const unresolved = this.mediaMigrated
      ? findUnresolvedMediaUrls(rewritten, this.cfg.wp.baseUrl)
      : [];
    if (unresolved.length > 0) {
      notices.push(
        notice("content.unresolvedMedia", {
          entry: label,
          count: unresolved.length,
          examples: unresolved.slice(0, 3).join(", "),
        }),
      );
    }
    return notices;
  }

  private async upsertEntry(
    uid: string,
    p: WpPost | WpPage,
    pluralOverride?: string,
    opts: {
      kind?: "post" | "page";
      restBase?: string;
      single?: boolean;
      routeName?: string;
    } = {},
  ): Promise<{ documentId: string; item: ItemDetails }> {
    const { kind = "post", restBase, single = false, routeName } = opts;
    const { data, notices } = await this.buildEntryData(p, kind, restBase, routeName);
    for (const n of notices) this.say(n);
    // Strapi v5 publishes by `status`; a `publishedAt` in the payload is stripped and the
    // write defaults to a draft. Anything not published in WordPress stays a draft here.
    const status = p.status === "publish" ? "published" : "draft";
    const item: ItemDetails = {
      ...entryInfo(p, uid, routeName),
      status,
      values: summarizeValues(data),
      ...(notices.length > 0 ? { notices } : {}),
    };
    if (this.cfg.dryRun) {
      return { documentId: "dry-run", item: { ...item, action: "dry-run" } };
    }
    const write: WriteOptions = { status, ...(single ? { single: true } : {}) };
    // A single type holds one document: there is nothing to look up, and PUT replaces it.
    if (single) {
      const saved = await this.strapi.create(uid, data, pluralOverride, write);
      return {
        documentId: saved.documentId,
        item: { ...item, action: "updated", documentId: saved.documentId },
      };
    }
    const existing = await this.strapi.findOneBy(
      uid,
      this.cfg.strapi.correlationField,
      p.id,
      pluralOverride,
    );
    const saved = existing
      ? await this.strapi.update(uid, existing.documentId, data, pluralOverride, write)
      : await this.strapi.create(uid, data, pluralOverride, write);
    return {
      documentId: saved.documentId,
      item: {
        ...item,
        action: existing ? "updated" : "created",
        documentId: saved.documentId,
      },
    };
  }

  private async migrateOnePost(p: WpPost): Promise<void> {
    await this.migrateRoutedEntry(p, "posts");
  }

  private async migrateOnePage(p: WpPage): Promise<void> {
    await this.migrateRoutedEntry(p, "pages");
  }

  /**
   * Write a post or a page wherever its route sends it — the default content-type when no
   * route takes it, unless routing says to skip those.
   *
   * A routed entry is still recorded under `posts`/`pages` too: comments, menus and retries
   * look entries up there, and should not have to know about routing.
   */
  private async migrateRoutedEntry(p: WpPost | WpPage, from: "posts" | "pages"): Promise<void> {
    const route = this.routeFor(p, from);
    if (!route && this.resolvedRoutes.length > 0 && this.cfg.routing.unmatched === "skip") {
      this.fire({
        type: "item-skip",
        kind: from,
        wpId: p.id,
        reason: "no route matches",
        item: entryInfo(p),
      });
      return;
    }

    const target = route
      ? { uid: route.uid, plural: route.pluralPath }
      : from === "posts"
        ? { uid: this.cfg.strapi.postUid, plural: this.cfg.strapi.postPluralPath }
        : { uid: this.cfg.strapi.pageUid, plural: this.cfg.strapi.pagePluralPath };

    try {
      const { documentId, item } = await this.upsertEntry(target.uid, p, target.plural, {
        kind: from === "posts" ? "post" : "page",
        routeName: route?.name,
      });
      if (from === "posts") this.state.setPost(p.id, documentId);
      else this.state.setPage(p.id, documentId);
      if (route) {
        this.state.setCustom(`route:${route.name}`, p.id, documentId);
        this.countRoute(route.name);
      }
      this.state.addRedirect(pathOf(p.link), p.slug, route?.name ?? from, documentId);
      this.state.clearFailure(from, p.id);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind: from,
        wpId: p.id,
        detail: route ? `${p.slug} → [${route.name}] ${documentId}` : `${p.slug} → ${documentId}`,
        item,
      });
    } catch (err) {
      this.state.recordFailure(from, p.id, (err as Error).message);
      await this.state.persist();
      this.fire({
        type: "item-error",
        kind: from,
        wpId: p.id,
        message: (err as Error).message,
        item: entryInfo(p, target.uid, route?.name),
      });
    }
  }
}
