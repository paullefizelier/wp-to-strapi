import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfig } from "./config.js";
import { Migrator, type MigratorEvent } from "./migrator.js";
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
          ? [{ id: 3, name: "News", slug: "news", description: "d" }]
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
    fetchBinary: async () => ({ buffer: Buffer.from("jpeg-bytes"), contentType: "image/jpeg" }),
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
    const category = created.find((c) => c.uid === "api::category.category");
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
      categories: 1,
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
    expect(category?.data).toMatchObject({ locale: "fr", source: "wordpress", name: "News" });
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

  it("only runs the kinds asked for", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const migrator = new Migrator(config(), { strapi: strapi.adapter, wp: wp.wp });
    await migrator.run({ only: ["media", "posts"] });
    expect(strapi.created.map((c) => c.uid)).toEqual(["api::post.post", "api::post.post"]);
  });
});
