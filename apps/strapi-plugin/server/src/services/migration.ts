import type { Core } from "@strapi/strapi";
import { buildConfig, Migrator, WordPressClient } from "@paullefizelier/wp-to-strapi-core";
import { NativeStrapiAdapter } from "@paullefizelier/wp-to-strapi-adapter";
import type { CustomTypeConfig, Kind } from "@paullefizelier/wp-to-strapi-core";
import type { Run } from "./run-store";

interface Settings {
  wpBaseUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  postUid: string;
  pageUid: string;
  categoryUid: string;
  tagUid: string;
  concurrency: number;
  pageSize: number;
  statuses: string[];
  customTypes: string[];
  htmlFallback: boolean;
}

/** `restBase:api::uid.uid[|pluralPath]` — split on the first colon, UIDs contain `::`. */
function parseCustomTypes(entries: string[] | undefined): CustomTypeConfig[] {
  return (entries ?? []).flatMap((entry) => {
    const colon = entry.indexOf(":");
    if (colon <= 0) return [];
    const restBase = entry.slice(0, colon).trim();
    const [uid, pluralPath] = entry.slice(colon + 1).split("|").map((part) => part.trim());
    if (!restBase || !uid) return [];
    return [pluralPath ? { restBase, uid, pluralPath } : { restBase, uid }];
  });
}

const service = ({ strapi }: { strapi: Core.Strapi }) => {
  const settingsSvc = () =>
    strapi.plugin("wp-import").service("settings") as {
      get: () => Promise<Settings>;
    };

  const runStoreSvc = () =>
    strapi.plugin("wp-import").service("runStore") as {
      current: () => Run | null;
      start: () => Run;
      record: (run: Run, e: unknown) => void;
      complete: (run: Run, err?: Error) => void;
    };

  return {
    async testWordPress(): Promise<{ ok: boolean; counts?: { posts: number; pages: number; media: number }; error?: string }> {
      const s = await settingsSvc().get();
      if (!s.wpBaseUrl) return { ok: false, error: "WP base URL not configured" };
      try {
        const client = new WordPressClient({
          baseUrl: s.wpBaseUrl,
          username: s.wpUsername || undefined,
          appPassword: s.wpAppPassword || undefined,
        });
        const counts = await client.probe();
        return { ok: true, counts };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    async start(only?: Kind[]): Promise<Run> {
      const s = await settingsSvc().get();
      if (!s.wpBaseUrl) throw new Error("WP base URL not configured");

      const cfg = buildConfig({
        wp: {
          baseUrl: s.wpBaseUrl,
          username: s.wpUsername || undefined,
          appPassword: s.wpAppPassword || undefined,
        },
        strapi: {
          // baseUrl and token are unused by the native adapter but still required by the config shape.
          baseUrl: "http://internal",
          token: "internal",
          postUid: s.postUid,
          pageUid: s.pageUid,
          categoryUid: s.categoryUid || undefined,
          tagUid: s.tagUid || undefined,
        },
        concurrency: s.concurrency,
        pageSize: s.pageSize,
        statuses: s.statuses,
        customTypes: parseCustomTypes(s.customTypes),
        htmlFallback: s.htmlFallback,
        stateFile: (strapi.config.get("plugin::wp-import.stateFile") as string | undefined) ?? "./.wp-import-state.json",
      });

      const run = runStoreSvc().start();
      const adapter = new NativeStrapiAdapter(
        strapi as unknown as Parameters<typeof NativeStrapiAdapter.prototype.constructor>[0],
      );
      const migrator = new Migrator(cfg, { strapi: adapter });
      migrator.on("event", (e) => runStoreSvc().record(run, e));

      // Fire-and-forget: the controller returns the run id immediately so the UI can subscribe.
      (async () => {
        try {
          await migrator.run(only ? { only } : {});
          runStoreSvc().complete(run);
        } catch (err) {
          runStoreSvc().complete(run, err as Error);
          strapi.log.error(`[wp-import] migration failed: ${(err as Error).message}`);
        }
      })();

      return run;
    },
  };
};

export default service;
