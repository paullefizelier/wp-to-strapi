import { buildConfig, Migrator } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";
import { MigrationConfigSchema } from "../../shared/schema";

const Body = MigrationConfigSchema.extend({
  kind: z.enum(["posts", "pages", "categories", "tags", "custom"]).default("posts"),
  restBase: z.string().optional(),
  limit: z.number().int().min(1).max(10).default(3),
});

/** Render what a run would write, without writing anything. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  const { kind, restBase, limit, retryFailed: _retryFailed, ...config } = parsed.data;
  try {
    const migrator = new Migrator(buildConfig(config));
    return { items: await migrator.preview({ kind, restBase, limit }) };
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message });
  }
});
