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
      });
    this.strapi =
      deps.strapi ??
      new StrapiClient({
        baseUrl: cfg.strapi.baseUrl,
        token: cfg.strapi.token,
      });
    this.state = new StateStore(cfg.stateFile);
    this.limit = pLimit(cfg.concurrency);
  }

  private fire(e: MigratorEvent): void {
    this.emit("event", e);
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
      const data: Record<string, unknown> = {
        name: decodeEntities(term.name ?? "").trim(),
        slug: term.slug,
        description: decodeEntities(term.description ?? ""),
        wpId: term.id,
      };
      if (this.cfg.dryRun) {
        this.fire({ type: "item-ok", kind, wpId: term.id, detail: `[dry-run] ${term.slug}` });
        return;
      }
      const existing = await this.strapi.findOneBy(uid, "wpId", term.id, pluralOverride);
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
      const { documentId } = await this.upsertEntry(type.uid, p, type.pluralPath);
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

  private async buildEntryData(p: WpPost | WpPage): Promise<{
    data: Record<string, unknown>;
    warnings: string[];
  }> {
    const title = decodeEntities(p.title?.rendered ?? "").trim();
    const resolved = await this.resolveContent(p);
    const rendered = resolved.html;
    const content = rewriteMediaUrls(rendered, this.state.get(), this.cfg.strapi.baseUrl);
    const excerpt = decodeEntities(p.excerpt?.rendered ?? "");
    const featured = p.featured_media
      ? this.state.get().media[p.featured_media]
      : undefined;

    const data: Record<string, unknown> = {
      title,
      slug: p.slug,
      content,
      excerpt,
      wpId: p.id,
      publishedAt: p.status === "publish" ? p.date_gmt + "Z" : null,
    };
    if (featured) data.cover = featured.strapiId;

    const state = this.state.get();
    if (this.cfg.strapi.categoryUid) {
      const ids = (p.categories ?? [])
        .map((wpId) => state.categories[wpId]?.documentId)
        .filter((id): id is string => Boolean(id));
      if (ids.length > 0) data[this.cfg.strapi.categoryField] = ids;
    }
    if (this.cfg.strapi.tagUid) {
      const ids = (p.tags ?? [])
        .map((wpId) => state.tags[wpId]?.documentId)
        .filter((id): id is string => Boolean(id));
      if (ids.length > 0) data[this.cfg.strapi.tagField] = ids;
    }

    return {
      data,
      warnings: [...resolved.warnings, ...this.auditContent(p, rendered, content)],
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
  ): Promise<{ documentId: string }> {
    const { data, warnings } = await this.buildEntryData(p);
    for (const message of warnings) this.fire({ type: "log", level: "warn", message });
    if (this.cfg.dryRun) {
      return { documentId: "dry-run" };
    }
    const existing = await this.strapi.findOneBy(uid, "wpId", p.id, pluralOverride);
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
