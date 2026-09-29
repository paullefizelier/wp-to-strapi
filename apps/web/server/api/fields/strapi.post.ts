import { StrapiClient } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({
  baseUrl: z.string().url(),
  token: z.string().min(1),
  uid: z.string().min(1),
  pluralPath: z.string().optional(),
});

/** Fields available on the Strapi side, for the mapping picker. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  const { baseUrl, token, uid, pluralPath } = parsed.data;
  const client = new StrapiClient({ baseUrl, token });
  return client.describeTarget(uid, pluralPath);
});
