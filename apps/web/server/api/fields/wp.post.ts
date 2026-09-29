import { WordPressClient } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({
  baseUrl: z.string().url(),
  username: z.string().optional(),
  appPassword: z.string().optional(),
  /** REST base to sample: posts, pages, categories, tags, or a custom type. */
  restBase: z.string().min(1).default("posts"),
});

/** Fields available on the WordPress side, for the mapping picker. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  const { baseUrl, username, appPassword, restBase } = parsed.data;
  const client = new WordPressClient({ baseUrl, username, appPassword });
  try {
    return { fields: await client.describeSource(restBase) };
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: (err as Error).message });
  }
});
