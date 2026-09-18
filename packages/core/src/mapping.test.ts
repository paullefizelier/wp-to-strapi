import { describe, expect, it } from "vitest";
import {
  applyMapping,
  defaultEntryMapping,
  mergeMappings,
  readPath,
  validateMapping,
  type MappingContext,
} from "./mapping.js";
import type { MigrationState } from "./state.js";

const state: MigrationState = {
  media: { 7: { strapiId: 101, url: "/uploads/photo.jpg", sourceUrl: "https://wp.test/2024/photo.jpg" } },
  posts: {},
  pages: {},
  categories: { 3: { documentId: "cat-doc" } },
  tags: { 9: { documentId: "tag-doc" } },
  custom: {},
};

const ctx: MappingContext = { state, strapiBaseUrl: "https://cms.test" };

const entity = {
  id: 42,
  slug: "bonjour",
  status: "publish",
  date_gmt: "2024-05-01T08:00:00",
  title: { rendered: "Caf&#233;s &amp; co" },
  content: { rendered: '<p>x <img src="https://wp.test/2024/photo.jpg"></p>' },
  featured_media: 7,
  categories: [3],
  tags: [9],
  acf: { subtitle: "Un sous-titre", rating: "4" },
  meta: { _yoast_wpseo_title: "SEO title" },
};

describe("readPath", () => {
  it("walks objects and array indexes", () => {
    expect(readPath(entity, "title.rendered")).toBe("Caf&#233;s &amp; co");
    expect(readPath(entity, "acf.subtitle")).toBe("Un sous-titre");
    expect(readPath(entity, "categories.0")).toBe(3);
    expect(readPath(entity, "nope.deep.path")).toBeUndefined();
  });
});

describe("applyMapping", () => {
  it("maps arbitrary source paths onto arbitrary target fields", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "seo_title", source: "meta._yoast_wpseo_title" },
        { target: "sous_titre", source: "acf.subtitle" },
        { target: "note", source: "acf.rating", transforms: ["number"] },
      ],
      ctx,
    );
    expect(data).toEqual({ seo_title: "SEO title", sous_titre: "Un sous-titre", note: 4 });
  });

  it("writes constants on every entry — the common-fields case", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "locale", value: "fr" },
        { target: "source", value: "wordpress" },
        { target: "imported", value: true },
      ],
      ctx,
    );
    expect(data).toEqual({ locale: "fr", source: "wordpress", imported: true });
  });

  it("runs transforms left to right", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "title", source: "title.rendered", transforms: ["decodeEntities", "trim"] },
        { target: "uid", source: "title.rendered", transforms: ["decodeEntities", "slugify"] },
        { target: "plain", source: "content.rendered", transforms: ["stripHtml"] },
        { target: "teaser", source: "acf.subtitle", transforms: ["truncate:8"] },
      ],
      ctx,
    );
    expect(data.title).toBe("Cafés & co");
    expect(data.uid).toBe("cafes-co");
    expect(data.plain).toBe("x");
    expect(data.teaser).toBe("Un sous…");
  });

  it("resolves media and term references through the state file", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "cover", source: "featured_media", transforms: ["mediaId"] },
        { target: "cover_url", source: "featured_media", transforms: ["mediaUrl"] },
        { target: "rubriques", source: "categories", transforms: ["terms:categories"] },
        { target: "mots_cles", source: "tags", transforms: ["terms:tags"] },
        { target: "body", source: "content.rendered", transforms: ["rewriteMedia"] },
      ],
      ctx,
    );
    expect(data.cover).toBe(101);
    expect(data.cover_url).toBe("https://cms.test/uploads/photo.jpg");
    expect(data.rubriques).toEqual(["cat-doc"]);
    expect(data.mots_cles).toEqual(["tag-doc"]);
    expect(data.body).toContain("https://cms.test/uploads/photo.jpg");
  });

  it("reads virtual sources the engine computed", () => {
    const { data } = applyMapping(entity, [{ target: "content", source: "$content" }], {
      ...ctx,
      virtuals: { $content: "<p>recovered</p>" },
    });
    expect(data.content).toBe("<p>recovered</p>");
  });

  it("omits empty values only when asked", () => {
    const rows = [
      { target: "a", source: "missing.path", omitEmpty: true },
      { target: "b", source: "acf.nothing" },
      { target: "c", value: "", omitEmpty: true },
      { target: "d", source: "missing", transforms: ["default:fallback"] },
    ];
    const { data } = applyMapping(entity, rows, ctx);
    expect(data).toEqual({ d: "fallback" });
  });

  it("normalises dates and keeps nulls", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "date", source: "date_gmt", transforms: ["date"] },
        { target: "publishedAt", source: "$publishedAt" },
      ],
      { ...ctx, virtuals: { $publishedAt: null } },
    );
    expect(data.date).toBe("2024-05-01T08:00:00.000Z");
    expect(data.publishedAt).toBeNull();
  });

  it("warns instead of throwing when a transform is unknown", () => {
    const { data, warnings } = applyMapping(entity, [{ target: "x", source: "slug", transforms: ["nope"] }], ctx);
    expect(data.x).toBe("bonjour");
    expect(warnings[0]).toContain('unknown transform "nope"');
  });
});

describe("mergeMappings", () => {
  it("lets kind rows override common rows on the same target", () => {
    const merged = mergeMappings(
      [{ target: "locale", value: "fr" }, { target: "title", value: "shared" }],
      [{ target: "title", source: "title.rendered" }],
    );
    expect(merged).toEqual([
      { target: "locale", value: "fr" },
      { target: "title", source: "title.rendered" },
    ]);
  });
});

describe("validateMapping", () => {
  it("accepts the built-in mapping", () => {
    expect(validateMapping(defaultEntryMapping())).toEqual([]);
  });

  it("reports the mistakes a hand-written mapping makes", () => {
    const issues = validateMapping([
      { target: "", source: "a" },
      { target: "b" },
      { target: "c", source: "x", value: 1 },
      { target: "d", source: "x", transforms: ["bogus"] },
      { target: "e", source: "x" },
      { target: "e", source: "y" },
    ]);
    expect(issues.map((i) => i.message)).toEqual([
      "target field name is required",
      "needs either a source path or a constant value",
      "set either a source path or a constant value, not both",
      'unknown transform "bogus"',
      "mapped more than once",
    ]);
  });
});

describe("select/enumeration targets", () => {
  it("writes a fixed enumeration value on every entry", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "audience", value: "professionnels" },
        { target: "wpId", source: "id" },
      ],
      ctx,
    );
    expect(data).toEqual({ audience: "professionnels", wpId: 42 });
  });

  it("coerces constants typed in a UI, which always arrive as strings", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "priorite", value: "3", transforms: ["number"] },
        { target: "miseEnAvant", value: "true", transforms: ["boolean"] },
      ],
      ctx,
    );
    expect(data).toEqual({ priorite: 3, miseEnAvant: true });
  });

  it("translates WordPress values into enumeration values", () => {
    const { data } = applyMapping(
      { ...entity, acf: { ...entity.acf, kind: "actualites" }, tags: ["promo", "interne"] },
      [
        { target: "audience", source: "acf.kind", transforms: ["map:actualites=professionnels,blog=grand-public"] },
        { target: "visibilite", source: "slug", transforms: ["map:*=grand-public"] },
        { target: "labels", source: "tags", transforms: ["map:promo=promotion"] },
      ],
      ctx,
    );
    expect(data.audience).toBe("professionnels");
    expect(data.visibilite).toBe("grand-public");
    expect(data.labels).toEqual(["promotion", "interne"]);
  });

  it("can derive the value from WordPress instead of fixing it", () => {
    const { data } = applyMapping(
      entity,
      [{ target: "audience", source: "acf.subtitle", transforms: ["slugify", "default:grand-public"] }],
      ctx,
    );
    expect(data.audience).toBe("un-sous-titre");
  });
});

describe("component and dynamic-zone targets", () => {
  it("writes into a single component with a dot path", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "contenu.body", source: "content.rendered", transforms: ["rewriteMedia"] },
        { target: "wpId", source: "id" },
      ],
      ctx,
    );
    expect(data).toEqual({
      contenu: { body: expect.stringContaining("https://cms.test/uploads/photo.jpg") },
      wpId: 42,
    });
  });

  it("builds a repeatable component from an indexed path", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "blocs.0.body", source: "content.rendered" },
        { target: "blocs.0.titre", source: "title.rendered", transforms: ["decodeEntities"] },
      ],
      ctx,
    );
    expect(data.blocs).toEqual([
      { body: entity.content.rendered, titre: "Cafés & co" },
    ]);
  });

  it("builds a dynamic zone with the component transform", () => {
    const { data } = applyMapping(
      entity,
      [
        {
          target: "contenu",
          source: "content.rendered",
          transforms: ["component:content.rich-text:body", "wrap"],
        },
      ],
      ctx,
    );
    expect(data.contenu).toEqual([
      { __component: "content.rich-text", body: entity.content.rendered },
    ]);
  });

  it("shapes a repeatable component without a dynamic zone marker", () => {
    const { data } = applyMapping(
      entity,
      [{ target: "paragraphes", source: "content.rendered", transforms: ["object:body", "wrap"] }],
      ctx,
    );
    expect(data.paragraphes).toEqual([{ body: entity.content.rendered }]);
  });

  it("keeps sibling paths in the same component", () => {
    const { data } = applyMapping(
      entity,
      [
        { target: "seo.metaTitle", source: "title.rendered", transforms: ["decodeEntities"] },
        { target: "seo.metaDescription", source: "acf.subtitle" },
      ],
      ctx,
    );
    expect(data.seo).toEqual({ metaTitle: "Cafés & co", metaDescription: "Un sous-titre" });
  });
});
