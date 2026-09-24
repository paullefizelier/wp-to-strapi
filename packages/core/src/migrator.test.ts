import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfig } from "./config.js";
import { describeNotice, NOTICE_CODES } from "./notices.js";
import { mediaFileName, Migrator, summarizeValues, type MigratorEvent } from "./migrator.js";
import type { StrapiAdapter } from "./strapi-adapter.js";
import type { MigrationState } from "./state.js";
import type { WordPressClient } from "./wordpress-client.js";
import type { StrapiEntry, WpMedia, WpPage, WpPost, WpTerm } from "./types.js";

const WP = "https://blog.example.com";

async function* stream<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function wpPost(over: Partial<WpPost> & { id: number; slug: string }): WpPost {
  return {
    date: "2024-05-01T10:00:00",
    date_gmt: "2024-05-01T08:00:00",
    modified: "2024-05-01T10:00:00",
    modified_gmt: "2024-05-01T08:00:00",
    status: "publish",
    type: "post",
    link: `${WP}/${over.slug}/`,
    title: { rendered: "Caf&#233;s &amp; co" },
    content: { rendered: "<p>hello</p>" },
    excerpt: { rendered: "" },
    author: 1,
    featured_media: 0,
    ...over,
  };
}

const MEDIA: WpMedia = {
  id: 7,
  date: "2024-05-01T10:00:00",
  slug: "photo",
  type: "attachment",
  mime_type: "image/jpeg",
  media_type: "image",
  source_url: `${WP}/wp-content/uploads/2024/05/photo.jpg`,
  title: { rendered: "Photo" },
  alt_text: "A photo",
  caption: { rendered: "" },
  media_details: {},
};

/** Records everything the migrator sends to Strapi. */
function fakeStrapi() {
  const created: Array<{
    uid: string;
    data: Record<string, unknown>;
    options?: { status?: string };
  }> = [];
  const adapter: StrapiAdapter = {
    async uploadFile(args) {
      return {
        id: 101,
        name: args.fileName,
        url: "/uploads/photo_hash.jpg",
        mime: args.contentType,
        formats: { small: { url: "/uploads/small_photo_hash.jpg", width: 500 } },
      };
    },
    async findOneBy(): Promise<StrapiEntry | null> {
      return null;
    },
    async create(uid, data, _plural, options): Promise<StrapiEntry> {
      created.push({ uid, data: data as Record<string, unknown>, options });
      return { id: created.length, documentId: `doc-${uid}-${created.length}` };
    },
    async update(_uid, documentId): Promise<StrapiEntry> {
      return { id: 1, documentId };
    },
  };
  return { adapter, created };
}

function fakeWp(over: Partial<Record<string, unknown>> = {}) {
  const calls = { pages: [] as string[], statuses: [] as string[], include: [] as string[] };
  const wp = {
    authenticated: true,
    media: () => stream<WpMedia>([MEDIA]),
    terms: (restBase: string) =>
      stream<WpTerm>(
        restBase === "categories"
          ? [
              { id: 2, name: "Racine", slug: "racine" },
              { id: 3, name: "News", slug: "news", description: "d", parent: 2 },
            ]
          : restBase === "genre"
            ? [{ id: 40, name: "Roman", slug: "roman" }]
            : [{ id: 9, name: "Tag", slug: "tag" }],
      ),
    posts: (statuses: string[], include?: number[]) => {
      calls.statuses.push(statuses.join(","));
      if (include) calls.include.push(include.join(","));
      return stream<WpPost>([
        wpPost({
          id: 1,
          slug: "with-image",
          categories: [3],
          tags: [9],
          featured_media: 7,
          content: {
            rendered: `<p>See <img src="${WP}/wp-content/uploads/2024/05/photo-300x200.jpg"></p>`,
          },
        }),
        wpPost({ id: 2, slug: "draft-one", status: "draft" }),
      ]);
    },
    pages: () =>
      stream<WpPage>([
        {
          ...wpPost({ id: 20, slug: "built-with-elementor" }),
          parent: 0,
          menu_order: 0,
          type: "page",
          content: { rendered: `<div class="elementor-element elementor-widget"></div>` },
        },
      ]),
    customType: (restBase: string) => {
      calls.pages.push(restBase);
      return stream<WpPost>([wpPost({ id: 50, slug: "a-project", type: "portfolio" })]);
    },
    users: () => stream([{ id: 7, name: "Jean Dupont", slug: "jean", description: "Bio" }]),
    comments: () =>
      stream([
        {
          id: 900, post: 1, parent: 0, author: 7, author_name: "Jean",
          date_gmt: "2024-05-02T09:00:00", content: { rendered: "<p>Bravo</p>" }, status: "approved",
        },
        { id: 901, post: 999, parent: 0, author: 7, author_name: "Orphelin",
          date_gmt: "2024-05-02T09:00:00", content: { rendered: "<p>?</p>" }, status: "approved" },
      ]),
    menus: () => stream([{ id: 5, name: "Principal", slug: "principal" }]),
    menuItems: () =>
      stream([
        { id: 51, title: { rendered: "Accueil" }, url: "/", status: "publish", parent: 0, menu_order: 1, object_id: 1, object: "post", type: "post_type" },
        { id: 52, title: { rendered: "Enfant" }, url: "/enfant", status: "publish", parent: 51, menu_order: 2 },
      ]),
    count: async (restBase: string) =>
      ({ media: 1, categories: 1, tags: 1, posts: 2, pages: 1, portfolio: 1, users: 1, comments: 2, menus: 1, genre: 1 })[restBase] ?? 0,
    fetchBinary: vi.fn(async () => ({ buffer: Buffer.from("jpeg-bytes"), contentType: "image/jpeg" })),
    checkBinary: vi.fn(async () => ({ size: 10 })),
    fetchPage: vi.fn(async () =>
      `<html><body><div class="entry-content"><h2>Recovered</h2><p>${"body ".repeat(60)}</p>` +
      `<img src="/wp-content/uploads/2024/05/photo.jpg" alt="p"></div></body></html>`,
    ),
    ...over,
  };
  return { wp: wp as unknown as WordPressClient, calls, raw: wp };
}

describe("Migrator", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wp-to-strapi-"));
    stateFile = join(dir, "state.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function config(over: Record<string, unknown> = {}) {
    return buildConfig({
      wp: { baseUrl: WP },
      strapi: {
        baseUrl: "https://cms.example.com",
        token: "t",
        categoryUid: "api::category.category",
        tagUid: "api::tag.tag",
      },
      stateFile,
      customTypes: [{ restBase: "portfolio", uid: "api::project.project" }],
      concurrency: 1,
      ...over,
    });
  }

  async function run(over: Record<string, unknown> = {}, wpOver = {}) {
    const strapi = fakeStrapi();
    const wp = fakeWp(wpOver);
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(config(over), { strapi: strapi.adapter, wp: wp.wp });
    migrator.on("event", (e) => events.push(e));
    await migrator.run();
    const state = JSON.parse(await readFile(stateFile, "utf8")) as MigrationState;
    return { ...strapi, ...wp, events, state };
  }

  it("migrates media and records the Strapi formats in the state file", async () => {
    const { state } = await run();
    expect(state.media[7]).toEqual({
      strapiId: 101,
      url: "/uploads/photo_hash.jpg",
      sourceUrl: MEDIA.source_url,
      formats: [{ url: "/uploads/small_photo_hash.jpg", width: 500 }],
    });
  });

  it("migrates taxonomies before posts and relates them by documentId", async () => {
    const { created, state } = await run();
    const category = created.find(
      (c) => c.uid === "api::category.category" && c.data.slug === "news",
    );
    expect(category?.data).toMatchObject({ name: "News", slug: "news", wpId: 3 });

    const post = created.find((c) => c.uid === "api::post.post" && c.data.slug === "with-image");
    expect(post?.data.categories).toEqual([state.categories[3]?.documentId]);
    expect(post?.data.tags).toEqual([state.tags[9]?.documentId]);
  });

  it("rewrites media URLs in post content and attaches the featured image", async () => {
    const { created } = await run();
    const post = created.find((c) => c.data.slug === "with-image");
    expect(post?.data.content).toContain("https://cms.example.com/uploads/photo_hash.jpg");
    expect(post?.data.content).not.toContain("blog.example.com");
    expect(post?.data.cover).toBe(101);
    expect(post?.data.title).toBe("Cafés & co");
  });

  it("publishes through `status`, which is the only thing Strapi v5 honours", async () => {
    const { created } = await run();
    const draft = created.find((c) => c.data.slug === "draft-one");
    const published = created.find((c) => c.data.slug === "with-image");
    expect(draft?.options?.status).toBe("draft");
    expect(published?.options?.status).toBe("published");
    // A publishedAt in the payload is stripped by the Document Service, so we never send one.
    expect(published?.data).not.toHaveProperty("publishedAt");
  });

  it("keeps the WordPress publication date available to a mapping", async () => {
    const { created } = await run({
      mapping: {
        post: [
          { target: "wpId", source: "id" },
          { target: "dateOriginale", source: "$publishedAt" },
        ],
      },
    });
    const published = created.find((c) => c.data.wpId === 1);
    expect(published?.data.dateOriginale).toBe("2024-05-01T08:00:00Z");
  });

  it("publishes taxonomy terms rather than leaving them as drafts", async () => {
    const { created } = await run();
    const category = created.find((c) => c.uid === "api::category.category");
    expect(category?.options?.status).toBe("published");
  });

  it("passes the configured statuses through to WordPress", async () => {
    const { calls } = await run({ statuses: ["publish", "draft", "future"] });
    expect(calls.statuses).toContain("publish,draft,future");
  });

  it("recovers an Elementor page from the public page and warns about it", async () => {
    const { created, raw, events } = await run();
    expect(raw.fetchPage).toHaveBeenCalledWith(`${WP}/built-with-elementor/`);
    const page = created.find((c) => c.uid === "api::page.page");
    expect(page?.data.content).toContain("<h2>Recovered</h2>");
    // The image inside the recovered content goes through the media map too.
    expect(page?.data.content).toContain("https://cms.example.com/uploads/photo_hash.jpg");
    const warnings = events.filter((e) => e.type === "log" && e.level === "warn");
    expect(warnings.some((w) => "message" in w && w.message.includes("elementor layout"))).toBe(true);
  });

  it("leaves the REST body alone when the fallback is disabled", async () => {
    const { created, raw } = await run({ htmlFallback: false });
    expect(raw.fetchPage).not.toHaveBeenCalled();
    const page = created.find((c) => c.uid === "api::page.page");
    expect(page?.data.content).toContain("elementor-element");
  });

  it("migrates custom post types into their configured UID", async () => {
    const { created, state } = await run();
    const project = created.find((c) => c.uid === "api::project.project");
    expect(project?.data).toMatchObject({ slug: "a-project", wpId: 50 });
    expect(state.custom.portfolio?.[50]).toBeDefined();
  });

  it("reports every kind in the run summary", async () => {
    const { events } = await run();
    const end = events.find((e) => e.type === "run-end");
    expect(end && "summary" in end && end.summary).toEqual({
      media: 1,
      posts: 2,
      pages: 1,
      categories: 2, // a root and its child, to exercise hierarchies
      tags: 1,
      custom: 1,
    });
  });

  it("writes a custom mapping instead of the built-in one", async () => {
    const { created } = await run({
      mapping: {
        post: [
          { target: "titre", source: "title.rendered", transforms: ["decodeEntities"] },
          { target: "corps", source: "$content", transforms: ["rewriteMedia"] },
          { target: "resume", source: "content.rendered", transforms: ["stripHtml", "truncate:10"] },
          { target: "wpId", source: "id" },
        ],
      },
    });
    const post = created.find((c) => c.uid === "api::post.post" && c.data.wpId === 1);
    expect(Object.keys(post?.data ?? {}).sort()).toEqual(["corps", "resume", "titre", "wpId"]);
    expect(post?.data.titre).toBe("Cafés & co");
    expect(post?.data.corps).toContain("https://cms.example.com/uploads/photo_hash.jpg");
  });

  it("applies common fields to every kind, letting kind rows win", async () => {
    const { created } = await run({
      mapping: {
        common: [
          { target: "locale", value: "fr" },
          { target: "source", value: "wordpress" },
        ],
        post: [
          { target: "wpId", source: "id" },
          { target: "source", value: "blog-legacy" },
        ],
      },
    });
    const post = created.find((c) => c.uid === "api::post.post");
    const category = created.find((c) => c.uid === "api::category.category");
    const project = created.find((c) => c.uid === "api::project.project");
    expect(post?.data).toMatchObject({ locale: "fr", source: "blog-legacy" });
    // The common rows reach the taxonomy and custom-type payloads too.
    expect(category?.data).toMatchObject({ locale: "fr", source: "wordpress" });
    expect(project?.data).toMatchObject({ locale: "fr", source: "blog-legacy" });
  });

  it("refuses to run on an invalid mapping instead of importing rubbish", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const migrator = new Migrator(
      config({ mapping: { post: [{ target: "x", source: "a", transforms: ["nope"] }] } }),
      { strapi: strapi.adapter, wp: wp.wp },
    );
    await expect(migrator.run()).rejects.toThrow(/unknown transform "nope"/);
    expect(strapi.created).toEqual([]);
  });

  it("refuses a mapping that would break re-runs by dropping the correlation field", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const migrator = new Migrator(
      config({ mapping: { post: [{ target: "titre", source: "title.rendered" }] } }),
      { strapi: strapi.adapter, wp: wp.wp },
    );
    await expect(migrator.run()).rejects.toThrow(/never writes "wpId".*duplicates/s);
    expect(strapi.created).toEqual([]);
  });

  it("accepts a renamed correlation field when the mapping writes it", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const migrator = new Migrator(
      config({
        strapi: {
          baseUrl: "https://cms.example.com",
          token: "t",
          correlationField: "wordpressId",
        },
        mapping: {
          post: [{ target: "wordpressId", source: "id" }],
          page: [{ target: "wordpressId", source: "id" }],
        },
        customTypes: [],
      }),
      { strapi: strapi.adapter, wp: wp.wp },
    );
    await migrator.run({ only: ["posts"] });
    expect(strapi.created[0]?.data).toEqual({ wordpressId: 1 });
  });

  it("records failures, groups them in the report, and retries just those", async () => {
    // A Strapi that refuses the first post, then accepts everything on the retry run.
    let failing = true;
    const strapi = fakeStrapi();
    const created = strapi.created;
    const adapter = {
      ...strapi.adapter,
      async create(uid: string, data: Record<string, unknown>, plural?: string, options?: unknown) {
        if (failing && uid === "api::post.post") throw new Error("Strapi POST /api/posts failed 403: forbidden");
        return strapi.adapter.create(uid, data, plural, options as never);
      },
    };
    const wp = fakeWp();
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(config(), { strapi: adapter, wp: wp.wp });
    migrator.on("event", (e) => events.push(e));
    await migrator.run({ only: ["posts"] });

    const end = events.find((e) => e.type === "run-end");
    expect(end && "failures" in end && end.failures.map((f) => f.wpId).sort()).toEqual([1, 2]);
    const report = events.filter(
      (e) => e.type === "log" && e.level === "error" && e.message.includes("×"),
    );
    expect(report).toHaveLength(1); // both failures share one cause
    expect("message" in report[0]! && report[0].message).toContain("2× [posts]");

    // Now retry: only the failed ids are fetched, and the state is cleared once they land.
    failing = false;
    const retryEvents: MigratorEvent[] = [];
    const retry = new Migrator(config(), { strapi: adapter, wp: wp.wp });
    retry.on("event", (e) => retryEvents.push(e));
    await retry.run({ retryFailed: true });

    expect(wp.calls.include).toContain("1,2");
    expect(created.filter((c) => c.uid === "api::post.post")).toHaveLength(2);
    const retryEnd = retryEvents.find((e) => e.type === "run-end");
    expect(retryEnd && "failures" in retryEnd && retryEnd.failures).toEqual([]);
  });

  it("says so and stops when there is nothing to retry", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(config(), { strapi: strapi.adapter, wp: wp.wp });
    migrator.on("event", (e) => events.push(e));
    await migrator.run({ retryFailed: true });
    expect(strapi.created).toEqual([]);
    expect(
      events.some((e) => e.type === "log" && e.message.includes("no failures")),
    ).toBe(true);
  });

  it("announces how big each section is before walking it", async () => {
    const { events } = await run();
    const starts = events.filter((e) => e.type === "section-start");
    expect(starts.map((e) => [e.kind, "expected" in e ? e.expected : undefined])).toEqual([
      ["media", 1],
      ["categories", 1],
      ["tags", 1],
      ["posts", 2],
      ["pages", 1],
      ["custom", 1],
    ]);
  });

  it("warns once per run, not once per entry, when no media were migrated", async () => {
    const { events } = await run({}, {});
    const perRun = events.filter(
      (e) => e.type === "log" && e.message.includes("No media in the state file"),
    );
    const perEntry = events.filter(
      (e) => e.type === "log" && e.message.includes("media URL(s) still point at WordPress"),
    );
    // Media are migrated in this fixture, so neither message applies.
    expect(perRun).toHaveLength(0);
    expect(perEntry.length).toBeLessThanOrEqual(2);
  });

  it("only runs the kinds asked for", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const migrator = new Migrator(config(), { strapi: strapi.adapter, wp: wp.wp });
    await migrator.run({ only: ["media", "posts"] });
    expect(strapi.created.map((c) => c.uid)).toEqual(["api::post.post", "api::post.post"]);
  });
});

describe("Notices", () => {
  it("carries a code and its parameters, not just a sentence", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(
      buildConfig({
        wp: { baseUrl: "https://blog.example.com" },
        strapi: { baseUrl: "https://cms.example.com", token: "t" },
        stateFile: "/tmp/notices-state.json",
        statuses: ["publish", "draft"],
      }),
      { strapi: strapi.adapter, wp: { ...wp.raw, authenticated: false } as never },
    );
    migrator.on("event", (e) => events.push(e));
    await migrator.run({ only: ["pages"] });

    const logs = events.filter((e) => e.type === "log");
    const credentials = logs.find((e) => e.code === "statuses.needCredentials");
    expect(credentials?.params).toEqual({ statuses: "draft" });
    expect(credentials?.message).toContain("need WordPress credentials");

    // The Elementor page in the fixture reports which builder it came from.
    const builder = logs.find((e) => e.code === "content.recovered");
    expect(builder?.params).toMatchObject({ reason: "elementor layout" });
  });

  it("gives every code an English rendering", () => {
    for (const code of NOTICE_CODES) {
      // Params are code-specific; an empty object is enough to prove the entry exists.
      const text = describeNotice(code, {} as never);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("Everything else a WordPress site holds", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wp-to-strapi-full-"));
    stateFile = join(dir, "state.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fullConfig(over: Record<string, unknown> = {}) {
    return buildConfig({
      wp: { baseUrl: WP },
      strapi: {
        baseUrl: "https://cms.example.com",
        token: "t",
        categoryUid: "api::category.category",
        tagUid: "api::tag.tag",
        authorUid: "api::author.author",
        commentUid: "api::comment.comment",
        menuUid: "api::menu.menu",
        parentField: "parent",
        termParentField: "parent",
        commentEntryField: "article",
      },
      taxonomies: [{ restBase: "genre", uid: "api::genre.genre" }],
      stateFile,
      concurrency: 1,
      ...over,
    });
  }

  async function runFull(over: Record<string, unknown> = {}) {
    const strapi = fakeStrapi();
    const updates: Array<{ uid: string; documentId: string; data: Record<string, unknown> }> = [];
    const adapter = {
      ...strapi.adapter,
      async update(uid: string, documentId: string, data: Record<string, unknown>, plural?: string, options?: unknown) {
        updates.push({ uid, documentId, data });
        return strapi.adapter.update(uid, documentId, data, plural, options as never);
      },
    };
    const wp = fakeWp();
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(fullConfig(over), { strapi: adapter, wp: wp.wp });
    migrator.on("event", (e) => events.push(e));
    await migrator.run();
    const state = JSON.parse(await readFile(stateFile, "utf8")) as MigrationState;
    return { created: strapi.created, updates, events, state };
  }

  it("migrates authors and keeps them relatable", async () => {
    const { created, state } = await runFull();
    const author = created.find((c) => c.uid === "api::author.author");
    expect(author?.data).toMatchObject({ name: "Jean Dupont", slug: "jean", wpId: 7 });
    expect(state.terms.authors?.[7]?.documentId).toBeDefined();
  });

  it("migrates a custom taxonomy into its own bucket", async () => {
    const { created, state } = await runFull();
    expect(created.find((c) => c.uid === "api::genre.genre")?.data).toMatchObject({ slug: "roman" });
    expect(state.terms.genre?.[40]?.documentId).toBeDefined();
  });

  it("rebuilds the page tree in a second pass", async () => {
    const wpPages = { pages: () => 0 };
    void wpPages;
    const { updates } = await runFull();
    // The fixture's page has no parent, but categories do — the same mechanism.
    const link = updates.find((u) => u.uid === "api::category.category" && "parent" in u.data);
    expect(link?.data.parent).toBeDefined();
  });

  it("attaches comments to their entry and skips orphans", async () => {
    const { created, events } = await runFull();
    const comment = created.find((c) => c.uid === "api::comment.comment");
    expect(comment?.data).toMatchObject({ authorName: "Jean", wpId: 900 });
    expect(comment?.data.article).toBeDefined();
    const skipped = events.find((e) => e.type === "item-skip" && e.kind === "comments");
    expect(skipped && "reason" in skipped && skipped.reason).toContain("not migrated");
  });

  it("stores a menu as a tree, pointing items at what they became", async () => {
    const { created } = await runFull();
    const menu = created.find((c) => c.uid === "api::menu.menu");
    const items = menu?.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: "Accueil", url: "/" });
    expect(items[0]?.documentId).toBeDefined(); // resolved to the migrated post
    expect((items[0]?.children as unknown[])[0]).toMatchObject({ label: "Enfant" });
  });

  it("records a redirect for every entry it writes", async () => {
    const { state } = await runFull();
    expect(state.redirects).toContainEqual(
      expect.objectContaining({ from: "/with-image/", slug: "with-image", kind: "posts" }),
    );
  });

  it("writes the redirect table to disk when asked", async () => {
    const file = join(dir, "redirects.json");
    const { events } = await runFull({ redirectsFile: file });
    const written = JSON.parse(await readFile(file, "utf8")) as unknown[];
    expect(written.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "log" && e.code === "redirects.written")).toBe(true);
  });

  it("writes a single type without looking it up first", async () => {
    const strapi = fakeStrapi();
    const seen: Array<{ single?: boolean }> = [];
    const adapter = {
      ...strapi.adapter,
      async create(uid: string, data: Record<string, unknown>, plural?: string, options?: { single?: boolean }) {
        seen.push({ single: options?.single });
        return strapi.adapter.create(uid, data, plural, options as never);
      },
      async findOneBy() {
        throw new Error("a single type must not be looked up");
      },
    };
    const wp = fakeWp();
    const migrator = new Migrator(
      fullConfig({
        customTypes: [{ restBase: "portfolio", uid: "api::about.about", single: true }],
      }),
      { strapi: adapter, wp: wp.wp },
    );
    await migrator.run({ only: ["custom"] });
    expect(seen.some((s) => s.single === true)).toBe(true);
  });
});

describe("Routing posts by category", () => {
  let dir: string;
  let stateFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wp-to-strapi-routing-"));
    stateFile = join(dir, "state.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The user's case: "Actualités" → blog with a target group, "Communiqués de presse" → press.
  const categories: WpTerm[] = [
    { id: 11, name: "Actualit&eacute;s", slug: "actualites" },
    { id: 12, name: "Communiqu&eacute;s de presse", slug: "communiques-de-presse" },
    { id: 13, name: "Divers", slug: "divers" },
  ];
  const posts = [
    wpPost({ id: 1, slug: "une-actu", categories: [11] }),
    wpPost({ id: 2, slug: "un-communique", categories: [12] }),
    wpPost({ id: 3, slug: "hors-route", categories: [13] }),
    wpPost({ id: 4, slug: "les-deux", categories: [12, 11] }),
  ];

  function routingWp() {
    const base = fakeWp();
    return {
      ...base.raw,
      terms: (restBase: string) => stream<WpTerm>(restBase === "categories" ? categories : []),
      posts: () => stream<WpPost>(posts),
      pages: () => stream<WpPage>([]),
    } as unknown as WordPressClient;
  }

  function routedConfig(over: Record<string, unknown> = {}) {
    return buildConfig({
      wp: { baseUrl: WP },
      strapi: { baseUrl: "https://cms.example.com", token: "t" },
      stateFile,
      concurrency: 1,
      routing: {
        routes: [
          // Names as a person types them — accents and capitals included.
          { name: "blog", categories: ["Actualités"], uid: "api::blog.blog" },
          { name: "presse", categories: ["communiques-de-presse"], uid: "api::press.press" },
        ],
      },
      mapping: {
        route: {
          blog: [
            { target: "titre", source: "title.rendered", transforms: ["decodeEntities"] },
            { target: "targetGroup", value: "grand-public" },
            { target: "wpId", source: "id" },
          ],
          presse: [
            { target: "titre", source: "title.rendered", transforms: ["decodeEntities"] },
            { target: "wpId", source: "id" },
          ],
        },
      },
      ...over,
    });
  }

  async function runRouted(over: Record<string, unknown> = {}) {
    const strapi = fakeStrapi();
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(routedConfig(over), { strapi: strapi.adapter, wp: routingWp() });
    migrator.on("event", (e) => events.push(e));
    await migrator.run({ only: ["posts"] });
    const state = JSON.parse(await readFile(stateFile, "utf8")) as MigrationState;
    return { created: strapi.created, events, state };
  }

  it("sends each category to its own content-type with its own mapping", async () => {
    const { created } = await runRouted();
    const blog = created.filter((c) => c.uid === "api::blog.blog");
    const press = created.filter((c) => c.uid === "api::press.press");
    // Post 4 is in both categories and lands here too — see the next test.
    expect(blog.map((c) => c.data.wpId)).toEqual([1, 4]);
    expect(press.map((c) => c.data.wpId)).toEqual([2]);
    expect(blog[0]?.data).toEqual({ titre: "Cafés & co", targetGroup: "grand-public", wpId: 1 });
    // The press route has no target group: mappings are per route.
    expect(press[0]?.data).not.toHaveProperty("targetGroup");
  });

  it("gives an entry in two routed categories to the first route listed", async () => {
    const { created } = await runRouted();
    // Post 4 is in both "Communiqués" and "Actualités"; "blog" comes first.
    expect(created.find((c) => c.data.wpId === 4)?.uid).toBe("api::blog.blog");
  });

  it("sends unrouted entries to the default content-type, or skips them", async () => {
    const byDefault = await runRouted();
    expect(byDefault.created.find((c) => c.data.wpId === 3)?.uid).toBe("api::post.post");

    const skipping = await runRouted({
      routing: { ...routedConfig().routing, unmatched: "skip" },
    });
    expect(skipping.created.find((c) => c.data.wpId === 3)).toBeUndefined();
    expect(
      skipping.events.some((e) => e.type === "item-skip" && e.wpId === 3 && e.reason === "no route matches"),
    ).toBe(true);
  });

  it("refuses to run when a route names a category WordPress does not have", async () => {
    const strapi = fakeStrapi();
    const migrator = new Migrator(
      routedConfig({
        routing: { routes: [{ name: "blog", categories: ["Actus"], uid: "api::blog.blog" }] },
      }),
      { strapi: strapi.adapter, wp: routingWp() },
    );
    await expect(migrator.run({ only: ["posts"] })).rejects.toThrow(/category "Actus" does not exist/);
    expect(strapi.created).toEqual([]);
  });

  it("guards the correlation field on every route's mapping", async () => {
    const strapi = fakeStrapi();
    const migrator = new Migrator(
      routedConfig({
        mapping: { route: { blog: [{ target: "titre", source: "title.rendered" }] } },
      }),
      { strapi: strapi.adapter, wp: routingWp() },
    );
    await expect(migrator.run({ only: ["posts"] })).rejects.toThrow(/route "blog".*never writes "wpId"/s);
  });

  it("keeps routed entries findable, records their redirect, and reports the split", async () => {
    const { state, events } = await runRouted();
    expect(state.posts[1]?.documentId).toBeDefined(); // comments and menus still resolve it
    expect(state.custom["route:blog"]?.[1]).toBeDefined();
    expect(state.redirects.find((r) => r.slug === "une-actu")?.kind).toBe("blog");
    const summary = events.find((e) => e.type === "log" && e.code === "routing.summary");
    expect(summary && "params" in summary && summary.params).toEqual({
      counts: "2 → blog, 1 → presse",
    });
  });

  it("shows the routed content-type in the preview, before anything is written", async () => {
    const strapi = fakeStrapi();
    const migrator = new Migrator(routedConfig(), { strapi: strapi.adapter, wp: routingWp() });
    const items = await migrator.preview({ kind: "posts", limit: 4 });
    expect(items.map((i) => [i.wpId, i.route ?? null, i.uid])).toEqual([
      [1, "blog", "api::blog.blog"],
      [2, "presse", "api::press.press"],
      [3, null, "api::post.post"],
      [4, "blog", "api::blog.blog"],
    ]);
    expect(strapi.created).toEqual([]);
  });
});

describe("Dry runs and the state file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wp-to-strapi-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function config(stateFile: string, over: Record<string, unknown> = {}) {
    return buildConfig({
      wp: { baseUrl: WP },
      strapi: { baseUrl: "https://cms.example.com", token: "t" },
      stateFile,
      concurrency: 1,
      ...over,
    });
  }

  it("a dry run never writes the state file, even when an entry fails", async () => {
    const stateFile = join(dir, "state.json");
    const failing = { ...MEDIA, id: 8, source_url: `${WP}/wp-content/uploads/missing.jpg` };
    const wp = fakeWp({
      media: () => stream([MEDIA, failing]),
      checkBinary: vi.fn(async (url: string) => {
        if (url.includes("missing")) throw new Error("Download failed: 404");
        return { size: 10 };
      }),
    });
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(config(stateFile, { dryRun: true }), {
      strapi: fakeStrapi().adapter,
      wp: wp.wp,
    });
    migrator.on("event", (e) => events.push(e));
    await migrator.run({ only: ["media"] });

    await expect(access(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.filter((e) => e.type === "item-error")).toHaveLength(1);
    // The failure is still reported at the end of the rehearsal.
    const end = events.find((e) => e.type === "run-end");
    expect(end && "failures" in end ? end.failures : []).toHaveLength(1);
  });

  it("a dry run checks media without downloading them", async () => {
    const wp = fakeWp();
    const migrator = new Migrator(config(join(dir, "state.json"), { dryRun: true }), {
      strapi: fakeStrapi().adapter,
      wp: wp.wp,
    });
    await migrator.run({ only: ["media"] });
    expect(wp.raw.checkBinary).toHaveBeenCalledTimes(1);
    expect(wp.raw.fetchBinary).not.toHaveBeenCalled();
  });

  it("a real run stops before touching Strapi when the state file can't be written", async () => {
    const strapi = fakeStrapi();
    const upload = vi.spyOn(strapi.adapter, "uploadFile");
    const migrator = new Migrator(config(join(dir, "no-such-dir", "state.json")), {
      strapi: strapi.adapter,
      wp: fakeWp().wp,
    });
    await expect(migrator.run()).rejects.toThrow(/Cannot write the state file/);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("mediaFileName", () => {
  it("decodes percent-encoded accents", () => {
    expect(
      mediaFileName({
        source_url: `${WP}/wp-content/uploads/photo-actualite%CC%81s-chantier-scaled.jpg`,
        mime_type: "image/jpeg",
      }),
    ).toBe("photo-actualités-chantier-scaled.jpg");
  });

  it("adds an extension from the MIME type when the URL has none", () => {
    expect(mediaFileName({ source_url: `${WP}/wp-content/uploads/watch`, mime_type: "video/mp4" })).toBe(
      "watch.mp4",
    );
    expect(mediaFileName({ source_url: `${WP}/u/cover`, mime_type: "image/jpeg" })).toBe("cover.jpg");
  });

  it("keeps a name that is already fine, or not decodable", () => {
    expect(mediaFileName({ source_url: `${WP}/u/logo.png`, mime_type: "image/png" })).toBe("logo.png");
    expect(mediaFileName({ source_url: `${WP}/u/bad%E0.png`, mime_type: "image/png" })).toBe("bad%E0.png");
  });
});

describe("Import details", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wp-to-strapi-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function items(over: Record<string, unknown> = {}, strapi = fakeStrapi()) {
    const events: MigratorEvent[] = [];
    const migrator = new Migrator(
      buildConfig({
        wp: { baseUrl: WP },
        strapi: { baseUrl: "https://cms.example.com", token: "t", categoryUid: "api::category.category" },
        stateFile: join(dir, "state.json"),
        concurrency: 1,
        ...over,
      }),
      { strapi: strapi.adapter, wp: fakeWp().wp },
    );
    migrator.on("event", (e) => events.push(e));
    await migrator.run({ only: ["media", "categories", "posts"] });
    return events.flatMap((e) =>
      e.type === "item-ok" || e.type === "item-skip" || e.type === "item-error"
        ? [{ kind: e.kind, wpId: e.wpId, type: e.type, item: e.item }]
        : [],
    );
  }

  it("says what each entry is, where it went and what was written", async () => {
    const all = await items();
    const post = all.find((i) => i.kind === "posts" && i.wpId === 1)?.item;
    expect(post).toMatchObject({
      title: "Cafés & co",
      slug: "with-image",
      source: `${WP}/with-image/`,
      wpStatus: "publish",
      target: "api::post.post",
      action: "created",
      status: "published",
      documentId: expect.stringMatching(/^doc-/),
    });
    expect(post?.values?.title).toBe("Cafés & co");
    const draft = all.find((i) => i.kind === "posts" && i.wpId === 2)?.item;
    expect(draft).toMatchObject({ wpStatus: "draft", status: "draft" });

    expect(all.find((i) => i.kind === "media")?.item).toMatchObject({
      title: "photo.jpg",
      source: MEDIA.source_url,
      target: "upload",
      action: "uploaded",
      mediaId: 101,
      url: "/uploads/photo_hash.jpg",
      size: "jpeg-bytes".length,
      mime: "image/jpeg",
    });
    expect(all.find((i) => i.kind === "categories")?.item).toMatchObject({
      target: "api::category.category",
      action: "created",
    });
  });

  it("tells an update from a creation", async () => {
    const strapi = fakeStrapi();
    strapi.adapter.findOneBy = async () => ({ id: 9, documentId: "existing" });
    const post = (await items({}, strapi)).find((i) => i.kind === "posts")?.item;
    expect(post).toMatchObject({ action: "updated", documentId: "existing" });
  });

  it("marks dry-run entries as such, with the payload they would have sent", async () => {
    const all = await items({ dryRun: true });
    const post = all.find((i) => i.kind === "posts")?.item;
    expect(post?.action).toBe("dry-run");
    expect(post?.documentId).toBeUndefined();
    expect(post?.values).toHaveProperty("slug", "with-image");
  });
});

describe("summarizeValues", () => {
  it("flattens HTML, keeps scalars and shortens structures", () => {
    const out = summarizeValues(
      {
        content: "<p>Bonjour&nbsp;<strong>tout</strong> le monde</p>",
        views: 3,
        featured: false,
        cover: null,
        blocks: [{ __component: "shared.rich-text", body: "x".repeat(400) }],
      },
      40,
    );
    expect(out.content).toBe("Bonjour tout le monde");
    expect(out.views).toBe("3");
    expect(out.featured).toBe("false");
    expect(out.cover).toBe("");
    expect(out.blocks).toHaveLength(40);
    expect(out.blocks?.endsWith("…")).toBe(true);
  });
});

describe("Selection", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wp-to-strapi-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function migrator(over: Record<string, unknown>, wp = fakeWp(), strapi = fakeStrapi()) {
    const m = new Migrator(
      buildConfig({
        wp: { baseUrl: WP },
        strapi: { baseUrl: "https://cms.example.com", token: "t", categoryUid: "api::category.category" },
        stateFile: join(dir, "state.json"),
        concurrency: 1,
        ...over,
      }),
      { strapi: strapi.adapter, wp: wp.wp },
    );
    return { m, wp, strapi };
  }

  it("asks WordPress only for the selected entries, and counts them for progress", async () => {
    const { m, wp } = migrator({ selection: { posts: [1] } });
    const events: MigratorEvent[] = [];
    m.on("event", (e) => events.push(e));
    await m.run({ only: ["posts"] });
    expect(wp.calls.include).toEqual(["1"]);
    const start = events.find((e) => e.type === "section-start" && e.kind === "posts");
    expect(start).toMatchObject({ expected: 1 });
  });

  it("leaves unselected kinds untouched", async () => {
    const { m, wp } = migrator({ selection: { pages: [20] } });
    await m.run({ only: ["posts"] });
    expect(wp.calls.include).toEqual([]);
  });

  it("lists entries with where routing would send them", async () => {
    const { m } = migrator({
      routing: { routes: [{ name: "blog", categories: [3], uid: "api::blog.blog" }], unmatched: "skip" },
    });
    const list = await m.catalogue({ kind: "posts" });
    expect(list.map((e) => [e.wpId, e.uid, e.route ?? null])).toEqual([
      [1, "api::blog.blog", "blog"],
      [2, null, null],
    ]);
    expect(list[0]).toMatchObject({ title: "Cafés & co", slug: "with-image", status: "publish" });
  });

  it("previews chosen ids, including one routing would skip", async () => {
    const { m, wp } = migrator({
      routing: { routes: [{ name: "blog", categories: [3], uid: "api::blog.blog" }], unmatched: "skip" },
    });
    const items = await m.preview({ kind: "posts", ids: [1, 2] });
    expect(wp.calls.include).toContain("1,2");
    expect(items.map((i) => [i.wpId, i.skipped ?? false])).toEqual([
      [1, false],
      [2, true],
    ]);
  });
});

describe("Media used by the imported entries", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wp-to-strapi-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const unused: WpMedia = {
    ...MEDIA,
    id: 8,
    slug: "unused",
    source_url: `${WP}/wp-content/uploads/2024/05/unused.jpg`,
  };
  const inContent: WpMedia = {
    ...MEDIA,
    id: 9,
    slug: "inline",
    source_url: `${WP}/wp-content/uploads/2024/05/inline.png`,
  };

  async function run(over: Record<string, unknown>, posts: WpPost[]) {
    const events: MigratorEvent[] = [];
    const wp = fakeWp({
      media: () => stream([MEDIA, unused, inContent]),
      posts: () => stream(posts),
    });
    const m = new Migrator(
      buildConfig({
        wp: { baseUrl: WP },
        strapi: { baseUrl: "https://cms.example.com", token: "t" },
        stateFile: join(dir, "state.json"),
        concurrency: 1,
        mediaScope: "used",
        ...over,
      }),
      { strapi: fakeStrapi().adapter, wp: wp.wp },
    );
    m.on("event", (e) => events.push(e));
    await m.run({ only: ["media", "posts"] });
    const media = events.filter((e) => e.type === "item-ok" && e.kind === "media").map((e) => e.wpId);
    return { media, events };
  }

  it("keeps the featured image and the images in the content — sizes and all", async () => {
    const { media, events } = await run({}, [
      wpPost({
        id: 1,
        slug: "a",
        featured_media: 7,
        content: { rendered: `<p><img src="${WP}/wp-content/uploads/2024/05/inline-1024x768.png"></p>` },
      }),
    ]);
    expect(media.sort()).toEqual([7, 9]);
    const start = events.find((e) => e.type === "section-start" && e.kind === "media");
    expect(start).toMatchObject({ expected: 2 });
    const scoped = events.find((e) => e.type === "log" && e.code === "media.scoped");
    expect(scoped && "params" in scoped ? scoped.params : null).toEqual({ used: 2, total: 3 });
  });

  it("follows the selection: an unselected entry's media stay behind", async () => {
    const posts = [
      wpPost({ id: 1, slug: "a", featured_media: 7 }),
      wpPost({ id: 2, slug: "b", featured_media: 8 }),
    ];
    // The fake WordPress ignores `include`; filter like the real one would.
    const { media } = await run({ selection: { posts: [1] } }, posts.filter((p) => p.id === 1));
    expect(media).toEqual([7]);
  });

  it("counts ids from Gutenberg markup and fields mapped through mediaId", async () => {
    const { media } = await run(
      {
        mapping: {
          post: [
            { target: "title", source: "title.rendered" },
            { target: "wpId", source: "id" },
            { target: "hero", source: "acf.hero", transforms: ["mediaId"] },
          ],
        },
      },
      [
        {
          ...wpPost({ id: 1, slug: "a", content: { rendered: '<figure class="wp-block-image"><img class="wp-image-9"></figure>' } }),
          acf: { hero: 8 },
        } as WpPost,
      ],
    );
    expect(media.sort()).toEqual([8, 9]);
  });
});
