import { StrapiClient } from "@YOUR-NPM-USERNAME/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({
  baseUrl: z.string().url(),
  token: z.string().min(1),
  postUid: z.string().min(1),
  pageUid: z.string().min(1),
  postPluralPath: z.string().optional(),
  pagePluralPath: z.string().optional(),
});

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  const { baseUrl, token, postUid, pageUid, postPluralPath, pagePluralPath } = parsed.data;
  const client = new StrapiClient({ baseUrl, token });
  const [posts, pages] = await Promise.all([
    client.probe(postUid, postPluralPath),
    client.probe(pageUid, pagePluralPath),
  ]);
  return { posts, pages };
});
