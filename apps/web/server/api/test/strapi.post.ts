import { StrapiClient } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({
  baseUrl: z.string().url("URL Strapi invalide"),
  token: z.string().min(1, "Le token API est requis"),
  // Every UID is optional: a project may have no `page` type at all, and only what is
  // configured should be probed. Requiring them turned a normal setup into a 400.
  postUid: z.string().optional(),
  pageUid: z.string().optional(),
  categoryUid: z.string().optional(),
  tagUid: z.string().optional(),
  postPluralPath: z.string().optional(),
  pagePluralPath: z.string().optional(),
  categoryPluralPath: z.string().optional(),
  tagPluralPath: z.string().optional(),
});

/** Probe each configured content type, and say which ones answered. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues.map((i) => i.message).join(" · "),
    });
  }
  const { baseUrl, token, ...uids } = parsed.data;
  const client = new StrapiClient({ baseUrl, token });

  const targets = [
    { key: "posts", label: "articles", uid: uids.postUid, plural: uids.postPluralPath },
    { key: "pages", label: "pages", uid: uids.pageUid, plural: uids.pagePluralPath },
    { key: "categories", label: "catégories", uid: uids.categoryUid, plural: uids.categoryPluralPath },
    { key: "tags", label: "étiquettes", uid: uids.tagUid, plural: uids.tagPluralPath },
  ].filter((t): t is typeof t & { uid: string } => Boolean(t.uid));

  if (targets.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: "Renseignez au moins un content-type à vérifier.",
    });
  }

  const results = await Promise.all(
    targets.map(async (t) => ({ ...t, result: await client.probe(t.uid, t.plural) })),
  );
  return {
    checks: results.map(({ key, label, uid, result }) => ({ key, label, uid, result })),
  };
});
