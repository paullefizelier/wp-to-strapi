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
  }),
  concurrency: z.number().int().positive().max(32).default(4),
  pageSize: z.number().int().positive().max(100).default(100),
  stateFile: z.string().default("./.migration-state.json"),
  dryRun: z.boolean().default(false),
  only: z.array(z.enum(["media", "posts", "pages"])).default(["media", "posts", "pages"]),
});

export type MigrationConfigInput = z.infer<typeof MigrationConfigSchema>;
