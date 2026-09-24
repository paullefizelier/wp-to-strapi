import { StrapiClient } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({
  baseUrl: z.string().url("URL Strapi invalide"),
  token: z.string().min(1, "Le token API est requis"),
});

/** The content types this Strapi exposes, so UIDs are picked rather than typed. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues.map((i) => i.message).join(" · "),
    });
  }
  const client = new StrapiClient(parsed.data);
  try {
    return { contentTypes: await client.listContentTypes() };
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage:
        `Impossible de lister les content-types (${(err as Error).message}). ` +
        `Vérifiez que le token a accès au Content-Type Builder, ou saisissez les UID à la main.`,
    });
  }
});
