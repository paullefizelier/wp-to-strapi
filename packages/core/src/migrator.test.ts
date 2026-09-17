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
  const created: Array<{ uid: string; data: Record<string, unknown> }> = [];
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
    async create(uid, data): Promise<StrapiEntry> {
      created.push({ uid, data: data as Record<string, unknown> });
      return { id: created.length, documentId: `doc-${uid}-${created.length}` };
    },
    async update(_uid, documentId): Promise<StrapiEntry> {
      return { id: 1, documentId };
    },
  };
  return { adapter, created };
}

function fakeWp(over: Partial<Record<string, unknown>> = {}) {
  const calls = { pages: [] as string[], statuses: [] as string[] };
  const wp = {
    authenticated: true,
    media: () => stream<WpMedia>([MEDIA]),
    terms: (restBase: string) =>
      stream<WpTerm>(
        restBase === "categories"
          ? [{ id: 3, name: "News", slug: "news", description: "d" }]
          : [{ id: 9, name: "Tag", slug: "tag" }],
      ),
    posts: (statuses: string[]) => {
      calls.statuses.push(statuses.join(","));
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

  it("imports non-published entries as Strapi drafts", async () => {
    const { created } = await run();
    const draft = created.find((c) => c.data.slug === "draft-one");
    expect(draft?.data.publishedAt).toBeNull();
    const published = created.find((c) => c.data.slug === "with-image");
    expect(published?.data.publishedAt).toBe("2024-05-01T08:00:00Z");
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

  it("only runs the kinds asked for", async () => {
    const strapi = fakeStrapi();
    const wp = fakeWp();
    const migrator = new Migrator(config(), { strapi: strapi.adapter, wp: wp.wp });
    await migrator.run({ only: ["media", "posts"] });
    expect(strapi.created.map((c) => c.uid)).toEqual(["api::post.post", "api::post.post"]);
  });
});
