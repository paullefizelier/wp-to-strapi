import { buildConfig, Migrator } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";
import { MigrationConfigSchema } from "../../shared/schema";

const Body = MigrationConfigSchema.extend({
  kind: z.enum(["posts", "pages", "custom"]),
  restBase: z.string().optional(),
});

/** Every entry a run would walk for a kind, with where it would land — to pick from. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  const { kind, restBase, retryFailed: _retryFailed, ...config } = parsed.data;
  try {
    const migrator = new Migrator(buildConfig(config));
    return { entries: await migrator.catalogue({ kind, restBase }) };
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message });
  }
});
