import { decodeEntities, WordPressClient } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({
  baseUrl: z.string().url("URL WordPress invalide"),
  username: z.string().optional(),
  appPassword: z.string().optional(),
});

/** Categories and tags, so a route picks them from a list instead of typing names. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues.map((i) => i.message).join(" · "),
    });
  }
  const wp = new WordPressClient(parsed.data);
  const read = async (taxonomy: "categories" | "tags") => {
    const out: Array<{ id: number; name: string; slug: string; count: number }> = [];
    for await (const t of wp.terms(taxonomy)) {
      out.push({
        id: t.id,
        name: decodeEntities(t.name ?? t.slug),
        slug: t.slug,
        count: t.count ?? 0,
      });
    }
    return out.sort((a, b) => b.count - a.count);
  };
  try {
    const [categories, tags] = await Promise.all([read("categories"), read("tags")]);
    return { categories, tags };
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: (err as Error).message });
  }
});
