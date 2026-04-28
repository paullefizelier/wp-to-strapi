import { EventEmitter } from "node:events";
import type { MigratorEvent } from "@YOUR-NPM-USERNAME/wp-to-strapi-core";

export interface Run {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "failed";
  error?: string;
  events: MigratorEvent[];
  bus: EventEmitter;
}

let current: Run | null = null;

function makeRun(): Run {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  return {
    id: `run-${Date.now()}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    events: [],
    bus,
  };
}

const service = () => ({
  current() {
    return current;
  },

  start(): Run {
    if (current?.status === "running") {
      throw new Error("A migration is already running");
    }
    current = makeRun();
    return current;
  },

  record(run: Run, e: MigratorEvent) {
    run.events.push(e);
    if (run.events.length > 5000) run.events.splice(0, run.events.length - 5000);
    run.bus.emit("event", e);
  },

  complete(run: Run, error?: Error) {
    run.endedAt = new Date().toISOString();
    run.status = error ? "failed" : "completed";
    if (error) run.error = error.message;
    run.bus.emit("done");
  },

  stopAll() {
    if (current) {
      current.bus.removeAllListeners();
      current = null;
    }
  },
});

export default service;
