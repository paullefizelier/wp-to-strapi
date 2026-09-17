import { EventEmitter } from "node:events";
import { basename } from "node:path";
import pLimit from "p-limit";
import type { AppConfig, CustomTypeConfig } from "./config.js";
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
  defaultEntryMapping,
  defaultTermMapping,
  mergeMappings,
  validateMapping,
  type FieldMapping,
} from "./mapping.js";
import { StateStore, type MediaFormat } from "./state.js";
import type { StrapiAdapter } from "./strapi-adapter.js";
import { StrapiClient } from "./strapi-client.js";
import type { StrapiUploadFile, WpMedia, WpPage, WpPost, WpTerm } from "./types.js";
import { WordPressClient } from "./wordpress-client.js";

/** Keep the responsive variants Strapi generated so `srcset` can be rebuilt on the way out. */
function toMediaFormats(file: StrapiUploadFile): MediaFormat[] {
  return Object.values(file.formats ?? {})
    .flatMap((f) => (f?.url && f.width ? [{ url: f.url, width: f.width }] : []))
    .sort((a, b) => a.width - b.width);
}

export type Kind = "media" | "categories" | "tags" | "posts" | "pages" | "custom";

export interface MigrateOptions {
  only?: ReadonlyArray<Kind>;
}

export type MigratorEvent =
  | { type: "run-start"; at: string; kinds: Kind[] }
  | { type: "section-start"; kind: Kind }
  | { type: "section-end"; kind: Kind; total: number }
  | { type: "item-skip"; kind: Kind; wpId: number; reason: string }
  | { type: "item-ok"; kind: Kind; wpId: number; detail: string }
  | { type: "item-error"; kind: Kind; wpId: number; message: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
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
  data: Record<string, unknown>;
  warnings: string[];
}

export interface PreviewOptions {
  /** Which kind to sample. Defaults to posts. */
  kind?: "posts" | "pages" | "categories" | "tags" | "custom";
  /** REST base when previewing a custom type. */
  restBase?: string;
  /** How many entries to render. */
  limit?: number;
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
    this.state = new StateStore(cfg.stateFile);
    this.limit = pLimit(cfg.concurrency);
  }

  private fire(e: MigratorEvent): void {
    this.emit("event", e);
  }

  /** Surface waiting as progress, so a throttled run does not look frozen. */
  private reportRetry(side: string, attempt: number, delayMs: number, reason: string): void {
    this.fire({
      type: "log",
      level: "warn",
      message: `${side}: ${reason} — retry ${attempt} in ${delayMs}ms`,
    });
  }

  /**
   * Rows for one kind: the configured mapping if there is one, the built-in otherwise, with
   * the `common` rows merged underneath so a shared field lands on every entry.
   */
  private mappingFor(
    kind: "post" | "page" | "category" | "tag",
    restBase?: string,
  ): FieldMapping[] {
    const set = this.cfg.mapping ?? {};
    const isTerm = kind === "category" || kind === "tag";
    const configured = restBase ? (set.custom?.[restBase] ?? set.post) : set[kind];
    return mergeMappings(set.common, configured ?? (isTerm ? defaultTermMapping() : defaultEntryMapping()));
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
    kinds.push("posts", "pages");
    if (this.cfg.customTypes.length > 0) kinds.push("custom");
    return kinds;
  }

  async run(opts: MigrateOptions = {}): Promise<void> {
    this.assertMappingValid();
    await this.state.load();
    const configured = this.configuredKinds();
    const kinds = opts.only ? configured.filter((k) => opts.only?.includes(k)) : configured;
    this.fire({ type: "run-start", at: new Date().toISOString(), kinds });

    const extraStatuses = this.cfg.statuses.filter((st) => st !== "publish");
    if (extraStatuses.length > 0 && !this.wp.authenticated) {
      this.fire({
        type: "log",
        level: "warn",
        message:
          `Statuses ${extraStatuses.join(", ")} need WordPress credentials — ` +
          `without them the REST API only returns published content.`,
      });
    }

    // Media and taxonomies first: posts reference both.
    if (kinds.includes("media")) await this.migrateMedia();
    if (kinds.includes("categories")) {
      await this.migrateTerms("categories", this.cfg.strapi.categoryUid, this.cfg.strapi.categoryPluralPath);
    }
    if (kinds.includes("tags")) {
      await this.migrateTerms("tags", this.cfg.strapi.tagUid, this.cfg.strapi.tagPluralPath);
    }
    if (kinds.includes("posts")) await this.migratePosts();
    if (kinds.includes("pages")) await this.migratePages();
    if (kinds.includes("custom")) await this.migrateCustomTypes();

    await this.state.persist();
    const s = this.state.get();
    this.fire({
      type: "run-end",
      at: new Date().toISOString(),
      summary: {
        media: Object.keys(s.media).length,
        posts: Object.keys(s.posts).length,
        pages: Object.keys(s.pages).length,
        categories: Object.keys(s.categories).length,
        tags: Object.keys(s.tags).length,
        custom: Object.values(s.custom).reduce((n, bucket) => n + Object.keys(bucket).length, 0),
      },
    });
  }

  // ----- Taxonomies -----

  private async migrateTerms(
    kind: "categories" | "tags",
    uid: string | undefined,
    pluralOverride: string | undefined,
  ): Promise<void> {
    if (!uid) return;
    this.fire({ type: "section-start", kind });
    const tasks: Promise<void>[] = [];
    let count = 0;
    for await (const term of this.wp.terms(kind)) {
      count += 1;
      tasks.push(this.limit(() => this.migrateOneTerm(kind, term, uid, pluralOverride)));
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind, total: count });
  }

  private async migrateOneTerm(
    kind: "categories" | "tags",
    term: WpTerm,
    uid: string,
    pluralOverride?: string,
  ): Promise<void> {
    try {
      const mapped = applyMapping(term, this.mappingFor(kind === "tags" ? "tag" : "category"), {
        state: this.state.get(),
        strapiBaseUrl: this.cfg.strapi.baseUrl,
      });
      for (const message of mapped.warnings) this.fire({ type: "log", level: "warn", message });
      const data = mapped.data;
      if (this.cfg.dryRun) {
        this.fire({ type: "item-ok", kind, wpId: term.id, detail: `[dry-run] ${term.slug}` });
        return;
      }
      const existing = await this.strapi.findOneBy(
        uid,
        this.cfg.strapi.correlationField,
        term.id,
        pluralOverride,
      );
      const saved = existing
        ? await this.strapi.update(uid, existing.documentId, data, pluralOverride)
        : await this.strapi.create(uid, data, pluralOverride);
      this.state.setTerm(kind, term.id, saved.documentId);
      await this.state.persist();
      this.fire({ type: "item-ok", kind, wpId: term.id, detail: `${term.slug} → ${saved.documentId}` });
    } catch (err) {
      this.fire({ type: "item-error", kind, wpId: term.id, message: (err as Error).message });
    }
  }

  // ----- Custom post types -----

  private async migrateCustomTypes(): Promise<void> {
    this.fire({ type: "section-start", kind: "custom" });
    let count = 0;
    for (const type of this.cfg.customTypes) {
      const tasks: Promise<void>[] = [];
      try {
        for await (const entry of this.wp.customType(type.restBase, this.cfg.statuses)) {
          count += 1;
          tasks.push(this.limit(() => this.migrateOneCustom(entry, type)));
        }
      } catch (err) {
        this.fire({
          type: "log",
          level: "error",
          message: `custom type "${type.restBase}": ${(err as Error).message}`,
        });
      }
      await Promise.all(tasks);
    }
    this.fire({ type: "section-end", kind: "custom", total: count });
  }

  private async migrateOneCustom(p: WpPost, type: CustomTypeConfig): Promise<void> {
    try {
      const { documentId } = await this.upsertEntry(type.uid, p, type.pluralPath, "post", type.restBase);
      this.state.setCustom(type.restBase, p.id, documentId);
      await this.state.persist();
      this.fire({
        type: "item-ok",
        kind: "custom",
        wpId: p.id,
        detail: `${type.restBase}/${p.slug} → ${documentId}`,
      });
    } catch (err) {
      this.fire({ type: "item-error", kind: "custom", wpId: p.id, message: (err as Error).message });
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
    const limit = Math.max(1, opts.limit ?? 3);
    const kind = opts.kind ?? "posts";
    const items: PreviewItem[] = [];

    if (kind === "categories" || kind === "tags") {
      const uid = kind === "categories" ? this.cfg.strapi.categoryUid : this.cfg.strapi.tagUid;
      if (!uid) throw new Error(`No Strapi UID configured for ${kind}`);
      for await (const term of this.wp.terms(kind)) {
        const mapped = applyMapping(term, this.mappingFor(kind === "tags" ? "tag" : "category"), {
          state: this.state.get(),
          strapiBaseUrl: this.cfg.strapi.baseUrl,
        });
        items.push({
          kind,
          uid,
          wpId: term.id,
          slug: term.slug,
          data: mapped.data,
          warnings: mapped.warnings,
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
        ? this.wp.pages(this.cfg.statuses)
        : custom
          ? this.wp.customType(custom.restBase, this.cfg.statuses)
          : this.wp.posts(this.cfg.statuses);
    const uid = kind === "pages"
      ? this.cfg.strapi.pageUid
      : (custom?.uid ?? this.cfg.strapi.postUid);

    for await (const entry of source) {
      const built = await this.buildEntryData(
        entry,
        kind === "pages" ? "page" : "post",
        custom?.restBase,
      );
      items.push({
        kind: kind === "custom" ? "custom" : kind,
        uid,
        wpId: entry.id,
        slug: entry.slug,
        data: built.data,
        warnings: built.warnings,
      });
      if (items.length >= limit) break;
    }

    if (Object.keys(this.state.get().media).length === 0) {
      for (const item of items) {
        item.warnings.push(
          "No media migrated yet — media URLs and cover fields stay unresolved in this preview.",
        );
      }
    }
    return items;
  }

  // ----- Media -----

  private async migrateMedia(): Promise<void> {
    this.fire({ type: "section-start", kind: "media" });
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
    if (this.state.get().media[m.id]) {
      this.fire({ type: "item-skip", kind: "media", wpId: m.id, reason: "already migrated" });
      return;
    }
    if (!m.source_url) {
      this.fire({ type: "item-skip", kind: "media", wpId: m.id, reason: "no source_url" });
      return;
    }

    try {
      const { buffer, contentType } = await this.wp.fetchBinary(m.source_url);
      const fileName = basename(new URL(m.source_url).pathname);
      if (this.cfg.dryRun) {
        this.fire({
          type: "item-ok",
          kind: "media",
          wpId: m.id,
          detail: `[dry-run] ${fileName} (${buffer.length}B)`,
        });
        return;
      }
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
      await this.state.persist();
      this.fire({ type: "item-ok", kind: "media", wpId: m.id, detail: uploaded.url });
    } catch (err) {
      this.fire({
        type: "item-error",
        kind: "media",
        wpId: m.id,
        message: (err as Error).message,
      });
    }
  }

  // ----- Posts & Pages -----

  private async migratePosts(): Promise<void> {
    this.fire({ type: "section-start", kind: "posts" });
    const tasks: Promise<void>[] = [];
    let count = 0;
    for await (const p of this.wp.posts(this.cfg.statuses)) {
      count += 1;
      tasks.push(this.limit(() => this.migrateOnePost(p)));
    }
    await Promise.all(tasks);
    this.fire({ type: "section-end", kind: "posts", total: count });
  }

  private async migratePages(): Promise<void> {
    this.fire({ type: "section-start", kind: "pages" });
    const tasks: Promise<void>[] = [];
    let count = 0;
    for await (const p of this.wp.pages(this.cfg.statuses)) {
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
    warnings: string[];
  }> {
    const rendered = p.content?.rendered ?? "";
    const flavour = detectFlavour(rendered);
    const needsFallback =
      flavour === "empty" || flavour === "elementor" || flavour === "divi" || flavour === "wpbakery";
    if (!this.cfg.htmlFallback || !needsFallback || !p.link) return { html: rendered, warnings: [] };

    const label = `${p.type ?? "entry"} "${p.slug}" (wpId ${p.id})`;
    try {
      const page = await this.wp.fetchPage(p.link);
      const extracted = extractReadableContent(page, p.link);
      const renderedText = rendered.replace(/<[^>]*>/g, "").trim().length;
      if (extracted.textLength <= renderedText || extracted.textLength === 0) {
        return { html: rendered, warnings: [] };
      }
      const warnings = [
        `${label}: ${flavour === "empty" ? "empty REST body" : `${flavour} layout`} — ` +
          `recovered ${extracted.textLength} chars of text and images from ${p.link}. ` +
          `Layout and styling are not migrated.`,
      ];
      if (extracted.droppedEmbeds > 0) {
        warnings.push(
          `${label}: ${extracted.droppedEmbeds} embed(s) (iframe/video/audio) dropped from the ` +
            `recovered content — re-add them by hand if they matter.`,
        );
      }
      return { html: extracted.html, warnings };
    } catch (err) {
      return {
        html: rendered,
        warnings: [`${label}: could not fetch ${p.link} for fallback: ${(err as Error).message}`],
      };
    }
  }

  private async buildEntryData(
    p: WpPost | WpPage,
    kind: "post" | "page",
    restBase?: string,
  ): Promise<{ data: Record<string, unknown>; warnings: string[] }> {
    const resolved = await this.resolveContent(p);
    const state = this.state.get();
    const mapped = applyMapping(p, this.mappingFor(kind, restBase), {
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
      warnings: [...resolved.warnings, ...mapped.warnings, ...this.auditContent(p, resolved.html, rewritten)],
    };
  }

  /**
   * Flag what the REST API could not hand over: page-builder layouts living in post meta,
   * unexpanded shortcodes, and media still pointing at WordPress. Silent blanks are the
   * failure mode that bites weeks later, once the WP install is gone.
   */
  private auditContent(
    p: WpPost | WpPage,
    rendered: string,
    rewritten: string,
  ): string[] {
    const label = `${p.type ?? "entry"} "${p.slug}" (wpId ${p.id})`;
    const warnings: string[] = [];

    const flavour = detectFlavour(rendered);
    if (flavour === "empty") {
      warnings.push(`${label}: WordPress returned empty rendered content — nothing to import`);
    } else if (flavour === "elementor" || flavour === "divi" || flavour === "wpbakery") {
      warnings.push(
        `${label}: built with ${flavour} — the layout lives in post meta, so only the flattened ` +
          `REST output is migrated. Expect to rebuild this page.`,
      );
    }

    const shortcodes = findShortcodes(rendered);
    if (shortcodes.length > 0) {
      warnings.push(
        `${label}: ${shortcodes.length} unexpanded shortcode(s) kept as literal text: ` +
          shortcodes.slice(0, 5).map((t) => `[${t}]`).join(" "),
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
      warnings.push(
        `${label}: ${missingTerms.length} term(s) not in the state file — run the categories ` +
          `and tags steps before posts, or the relations stay empty.`,
      );
    }

    const unresolved = findUnresolvedMediaUrls(rewritten, this.cfg.wp.baseUrl);
    if (unresolved.length > 0) {
      warnings.push(
        `${label}: ${unresolved.length} media URL(s) still point at WordPress ` +
          `(missing from the media map): ${unresolved.slice(0, 3).join(", ")}`,
      );
    }
    return warnings;
  }

  private async upsertEntry(
    uid: string,
    p: WpPost | WpPage,
    pluralOverride?: string,
    kind: "post" | "page" = "post",
    restBase?: string,
  ): Promise<{ documentId: string }> {
    const { data, warnings } = await this.buildEntryData(p, kind, restBase);
    for (const message of warnings) this.fire({ type: "log", level: "warn", message });
    if (this.cfg.dryRun) {
      return { documentId: "dry-run" };
    }
    const existing = await this.strapi.findOneBy(
      uid,
      this.cfg.strapi.correlationField,
      p.id,
      pluralOverride,
    );
    if (existing) {
      const updated = await this.strapi.update(uid, existing.documentId, data, pluralOverride);
      return { documentId: updated.documentId };
    }
    const created = await this.strapi.create(uid, data, pluralOverride);
    return { documentId: created.documentId };
  }

  private async migrateOnePost(p: WpPost): Promise<void> {
    try {
      const { documentId } = await this.upsertEntry(
        this.cfg.strapi.postUid,
        p,
        this.cfg.strapi.postPluralPath,
      );
      this.state.setPost(p.id, documentId);
      await this.state.persist();
      this.fire({ type: "item-ok", kind: "posts", wpId: p.id, detail: `${p.slug} → ${documentId}` });
    } catch (err) {
      this.fire({
        type: "item-error",
        kind: "posts",
        wpId: p.id,
        message: (err as Error).message,
      });
    }
  }

  private async migrateOnePage(p: WpPage): Promise<void> {
    try {
      const { documentId } = await this.upsertEntry(
        this.cfg.strapi.pageUid,
        p,
        this.cfg.strapi.pagePluralPath,
        "page",
      );
      this.state.setPage(p.id, documentId);
      await this.state.persist();
      this.fire({ type: "item-ok", kind: "pages", wpId: p.id, detail: `${p.slug} → ${documentId}` });
    } catch (err) {
      this.fire({
        type: "item-error",
        kind: "pages",
        wpId: p.id,
        message: (err as Error).message,
      });
    }
  }
}
