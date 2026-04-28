import { WordPressClient } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({
  baseUrl: z.string().url(),
  username: z.string().optional(),
  appPassword: z.string().optional(),
});

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  const client = new WordPressClient(parsed.data);
  try {
    const counts = await client.probe();
    return { ok: true as const, counts };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
});
