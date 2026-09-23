import type { Core } from "@strapi/strapi";
import type { Kind } from "@paullefizelier/wp-to-strapi-core";
import type { Run } from "../services/run-store";

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const migrationSvc = () =>
    strapi.plugin("wp-import").service("migration") as {
      testWordPress: () => Promise<unknown>;
      start: (only?: Kind[], retryFailed?: boolean) => Promise<Run>;
      preview: (opts: { kind?: string; restBase?: string; limit?: number }) => Promise<unknown>;
      wpFields: (restBase: string) => Promise<unknown>;
      strapiFields: (uid: string) => Promise<unknown>;
    };

  const runStoreSvc = () =>
    strapi.plugin("wp-import").service("runStore") as {
      current: () => Run | null;
    };

  return {
    async testWp() {
      return migrationSvc().testWordPress();
    },

    async preview(ctx: { request: { body?: { kind?: string; restBase?: string; limit?: number } } }) {
      return migrationSvc().preview(ctx.request.body ?? {});
    },

    async wpFields(ctx: { query?: { type?: string } }) {
      return migrationSvc().wpFields(ctx.query?.type || "posts");
    },

    async strapiFields(ctx: { query?: { uid?: string }; badRequest: (msg: string) => never }) {
      const uid = ctx.query?.uid;
      if (!uid) ctx.badRequest("uid is required");
      return migrationSvc().strapiFields(uid as string);
    },

    async start(ctx: {
      request: { body?: { only?: string[]; retryFailed?: boolean } };
      badRequest: (msg: string) => never;
      conflict?: (msg: string) => never;
    }) {
      const body = ctx.request.body ?? {};
      const kinds: Kind[] = [
        "media", "categories", "tags", "taxonomies", "authors",
        "posts", "pages", "custom", "comments", "menus",
      ];
      const only = (body.only ?? []).filter((k): k is Kind => kinds.includes(k as Kind));
      if (body.only && only.length === 0) {
        ctx.badRequest(`only must include at least one of ${kinds.join("/")}`);
      }
      try {
        const run = await migrationSvc().start(
          only.length > 0 ? only : undefined,
          body.retryFailed === true,
        );
        return { id: run.id, startedAt: run.startedAt };
      } catch (err) {
        throw Object.assign(new Error((err as Error).message), { status: 409 });
      }
    },

    async status() {
      const run = runStoreSvc().current();
      if (!run) return { hasRun: false };
      return {
        hasRun: true,
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        error: run.error ?? null,
        eventsCount: run.events.length,
      };
    },

    /**
     * SSE stream. Writes to the raw Node response (Strapi exposes ctx.res = Node's ServerResponse).
     */
    async events(ctx: { req: { on: (evt: string, cb: () => void) => void }; res: { writeHead: (s: number, h: Record<string, string>) => void; write: (chunk: string) => void; end: () => void; flushHeaders?: () => void }; respond?: boolean }) {
      const run = runStoreSvc().current();
      if (!run) {
        ctx.res.writeHead(404, { "Content-Type": "text/plain" });
        ctx.res.end();
        return;
      }

      // Signal Koa not to manage the response.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      ctx.respond = false;

      ctx.res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      ctx.res.flushHeaders?.();

      const write = (event: string, data: unknown) => {
        ctx.res.write(`event: ${event}\n`);
        ctx.res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Replay buffered events.
      for (const e of run.events) write("progress", e);
      write("status", { status: run.status });
      if (run.status !== "running") {
        write("end", { status: run.status, error: run.error ?? null });
        ctx.res.end();
        return;
      }

      const onEvent = (e: unknown) => write("progress", e);
      const onDone = () => {
        write("end", { status: run.status, error: run.error ?? null });
        ctx.res.end();
      };
      run.bus.on("event", onEvent);
      run.bus.once("done", onDone);

      ctx.req.on("close", () => {
        run.bus.off("event", onEvent);
        run.bus.off("done", onDone);
      });
    },
  };
};
