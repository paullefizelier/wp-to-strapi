import { currentRun, type RunState } from "../utils/runtime";

/**
 * SSE stream of migration events: what already happened, then what happens next.
 *
 * Two things this has to get right.
 *
 * Nothing is pushed before `send()`. Pushing beforehand fills the transform stream's buffer
 * with nobody reading it, so on a real run (hundreds of buffered events) the write never
 * resolves, the handler never returns the stream, and the page shows nothing at all.
 *
 * Replay and live delivery go through one cursor rather than a catch-up phase followed by a
 * subscription — the gap between the two is where events get lost or sent twice.
 */
export default defineEventHandler(async (event) => {
  const run = currentRun();
  if (!run) {
    throw createError({ statusCode: 404, statusMessage: "No migration has been started" });
  }

  const stream = createEventStream(event);
  let cursor = 0; // absolute position of the next event to send
  let pumping = false;
  let closed = false;

  const total = (r: RunState) => r.dropped + r.events.length;

  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (cursor < total(run) && !closed) {
        const index = Math.max(0, cursor - run.dropped);
        const e = run.events[index];
        cursor = run.dropped + index + 1;
        if (e) await stream.push({ event: "progress", data: JSON.stringify(e) });
      }
    } catch {
      closed = true; // the client went away
    } finally {
      pumping = false;
    }
  };

  const onEvent = () => void pump();
  const onDone = () => {
    void (async () => {
      await pump();
      if (closed) return;
      await stream
        .push({ event: "end", data: JSON.stringify({ status: run.status, error: run.error ?? null }) })
        .catch(() => {});
      await stream.close().catch(() => {});
    })();
  };

  // Subscribe before the first pump so nothing slips through in between.
  run.bus.on("event", onEvent);
  run.bus.once("done", onDone);

  stream.onClosed(() => {
    closed = true;
    run.bus.off("event", onEvent);
    run.bus.off("done", onDone);
  });

  void (async () => {
    await stream
      .push({ event: "status", data: JSON.stringify({ status: run.status }) })
      .catch(() => {});
    await pump();
    if (run.status !== "running") onDone();
  })();

  return stream.send();
});
