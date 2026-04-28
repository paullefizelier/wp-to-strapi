import { EventEmitter } from "node:events";
import type { MigratorEvent } from "@paullefizelier/wp-to-strapi-core";

/**
 * Single in-process run holder. The web UI is a local tool, so one run at a time is fine.
 * If you want multiple concurrent runs, key these by a generated run id.
 */
export interface RunState {
  id: string;
  startedAt: string;
  endedAt: string | null;
  events: MigratorEvent[];
  status: "running" | "completed" | "failed";
  error?: string;
  bus: EventEmitter;
}

let current: RunState | null = null;

export function currentRun(): RunState | null {
  return current;
}

export function startRun(): RunState {
  if (current && current.status === "running") {
    throw new Error("A migration is already running");
  }
  current = {
    id: `run-${Date.now()}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
    status: "running",
    bus: new EventEmitter(),
  };
  // Allow many SSE subscribers.
  current.bus.setMaxListeners(50);
  return current;
}

export function recordEvent(run: RunState, e: MigratorEvent): void {
  run.events.push(e);
  // Cap memory: keep the last 5000 events (plenty for normal runs).
  if (run.events.length > 5000) run.events.splice(0, run.events.length - 5000);
  run.bus.emit("event", e);
}

export function completeRun(run: RunState, error?: Error): void {
  run.endedAt = new Date().toISOString();
  run.status = error ? "failed" : "completed";
  if (error) run.error = error.message;
  run.bus.emit("done");
}
