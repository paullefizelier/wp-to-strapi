import { z } from "zod";

const FieldMappingSchema = z.object({
  target: z.string().min(1),
  source: z.string().optional(),
  value: z.unknown().optional(),
  transforms: z.array(z.string()).optional(),
  omitEmpty: z.boolean().optional(),
});

const MappingRows = z.array(FieldMappingSchema);

/** Per-kind field mappings. Omitted kinds fall back to the engine's built-in mapping. */
export const MappingSetSchema = z.object({
  common: MappingRows.optional(),
  post: MappingRows.optional(),
  page: MappingRows.optional(),
  category: MappingRows.optional(),
  tag: MappingRows.optional(),
  custom: z.record(MappingRows).optional(),
  route: z.record(MappingRows).optional(),
});

export const MigrationConfigSchema = z.object({
  wp: z.object({
    baseUrl: z.string().url(),
    username: z.string().optional(),
    appPassword: z.string().optional(),
  }),
  strapi: z.object({
    baseUrl: z.string().url(),
    token: z.string().min(1),
    postUid: z.string().min(1).default("api::post.post"),
    pageUid: z.string().min(1).default("api::page.page"),
    postPluralPath: z.string().optional(),
    pagePluralPath: z.string().optional(),
    categoryUid: z.string().optional(),
    authorUid: z.string().optional(),
    commentUid: z.string().optional(),
    menuUid: z.string().optional(),
    parentField: z.string().optional(),
    termParentField: z.string().optional(),
    categoryPluralPath: z.string().optional(),
    tagUid: z.string().optional(),
    tagPluralPath: z.string().optional(),
  }),
  concurrency: z.number().int().positive().max(32).default(4),
  pageSize: z.number().int().positive().max(100).default(100),
  stateFile: z.string().default("./.migration-state.json"),
  dryRun: z.boolean().default(false),
  htmlFallback: z.boolean().default(true),
  statuses: z.array(z.string().min(1)).default(["publish"]),
  customTypes: z
    .array(
      z.object({
        restBase: z.string().min(1),
        uid: z.string().min(1),
        pluralPath: z.string().optional(),
      }),
    )
    .default([]),
  mapping: MappingSetSchema.default({}),
  taxonomies: z
    .array(z.object({ restBase: z.string().min(1), uid: z.string().min(1), pluralPath: z.string().optional() }))
    .default([]),
  redirectsFile: z.string().optional(),
  routing: z
    .object({
      routes: z
        .array(
          z.object({
            name: z.string().min(1),
            from: z.enum(["posts", "pages"]).optional(),
            categories: z.array(z.union([z.string(), z.number()])).optional(),
            tags: z.array(z.union([z.string(), z.number()])).optional(),
            uid: z.string().min(1),
            pluralPath: z.string().optional(),
          }),
        )
        .default([]),
      unmatched: z.enum(["default", "skip"]).default("default"),
    })
    .default({ routes: [], unmatched: "default" }),
  only: z
    .array(
      z.enum([
        "media", "categories", "tags", "taxonomies", "authors",
        "posts", "pages", "custom", "comments", "menus",
      ]),
    )
    .default(["media", "posts", "pages"]),
  /** Re-run only what the previous run recorded as failed. */
  retryFailed: z.boolean().default(false),
  /** `used`: only the files the imported entries point at. */
  mediaScope: z.enum(["all", "used"]).default("all"),
  /** WordPress ids to import per kind; a kind left out imports everything. */
  selection: z
    .object({
      posts: z.array(z.number().int()).optional(),
      pages: z.array(z.number().int()).optional(),
      custom: z.record(z.array(z.number().int())).optional(),
    })
    .default({}),
});

export type MigrationConfigInput = z.infer<typeof MigrationConfigSchema>;
