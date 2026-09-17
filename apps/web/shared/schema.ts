import { z } from "zod";

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
  only: z
    .array(z.enum(["media", "categories", "tags", "posts", "pages", "custom"]))
    .default(["media", "posts", "pages"]),
});

export type MigrationConfigInput = z.infer<typeof MigrationConfigSchema>;
