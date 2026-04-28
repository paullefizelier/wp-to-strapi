import type { MigratorEvent } from "@paullefizelier/wp-to-strapi-core";
import { currentRun } from "../utils/runtime";

/**
 * SSE stream of migration events. Replays any buffered events on connect, then
 * subscribes to the live bus until the run completes.
 */
export default defineEventHandler(async (event) => {
  const run = currentRun();
  if (!run) {
    throw createError({ statusCode: 404, statusMessage: "No migration has been started" });
  }

  const stream = createEventStream(event);

  // Replay what already happened.
  for (const e of run.events) {
    await stream.push({ event: "progress", data: JSON.stringify(e) });
  }
  // Send an immediate status ping so the client can update the UI.
  await stream.push({ event: "status", data: JSON.stringify({ status: run.status }) });

  if (run.status !== "running") {
    await stream.push({ event: "end", data: JSON.stringify({ status: run.status, error: run.error ?? null }) });
    await stream.close();
    return stream.send();
  }

  const onEvent = async (e: MigratorEvent) => {
    await stream.push({ event: "progress", data: JSON.stringify(e) }).catch(() => {});
  };
  const onDone = async () => {
    await stream
      .push({ event: "end", data: JSON.stringify({ status: run.status, error: run.error ?? null }) })
      .catch(() => {});
    await stream.close();
  };
  run.bus.on("event", onEvent);
  run.bus.once("done", onDone);

  event.node.req.on("close", () => {
    run.bus.off("event", onEvent);
    run.bus.off("done", onDone);
  });

  return stream.send();
});
