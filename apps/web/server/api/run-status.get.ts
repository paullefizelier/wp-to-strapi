import { currentRun } from "../utils/runtime";

export default defineEventHandler(() => {
  const run = currentRun();
  if (!run) return { hasRun: false as const };
  return {
    hasRun: true as const,
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    error: run.error,
    eventsCount: run.events.length,
  };
});
