import { GeminiClient } from "@paullefizelier/wp-to-strapi-core";
import { z } from "zod";

const Body = z.object({ apiKey: z.string().optional() });

/** The Gemini models this key can use — also how the key gets checked. */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  try {
    const client = new GeminiClient(parsed.data.apiKey || undefined, { retries: 1 });
    return { models: await client.listModels(), fromEnv: !parsed.data.apiKey };
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message });
  }
});
