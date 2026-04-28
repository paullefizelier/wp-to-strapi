import { buildConfig, Migrator } from "@YOUR-NPM-USERNAME/wp-to-strapi-core";
import { MigrationConfigSchema } from "../../shared/schema";
import { completeRun, currentRun, recordEvent, startRun } from "../utils/runtime";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const parsed = MigrationConfigSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.message });
  }
  const existing = currentRun();
  if (existing?.status === "running") {
    throw createError({ statusCode: 409, statusMessage: "A migration is already in progress" });
  }
  const cfg = buildConfig(parsed.data);
  const run = startRun();

  // Kick off the migration but don't await — we return the run id immediately so the UI
  // can switch to the SSE stream at /api/events.
  (async () => {
    try {
      const migrator = new Migrator(cfg);
      migrator.on("event", (e) => recordEvent(run, e));
      await migrator.run({ only: parsed.data.only });
      completeRun(run);
    } catch (err) {
      completeRun(run, err as Error);
    }
  })();

  return { runId: run.id, startedAt: run.startedAt };
});
