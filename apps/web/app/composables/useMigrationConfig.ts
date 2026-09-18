import type { MigrationConfigInput } from "#shared/schema";

const STORAGE_KEY = "wp-to-strapi:config";

const empty = (): MigrationConfigInput => ({
  wp: { baseUrl: "", username: "", appPassword: "" },
  strapi: {
    baseUrl: "http://localhost:1337",
    token: "",
    postUid: "api::post.post",
    pageUid: "api::page.page",
  },
  concurrency: 4,
  pageSize: 100,
  stateFile: "./.migration-state.json",
  dryRun: false,
  htmlFallback: true,
  statuses: ["publish"],
  customTypes: [],
  mapping: {},
  only: ["media", "posts", "pages"],
});

/**
 * Shared reactive config, persisted to localStorage on the client side so refreshing
 * the page doesn't wipe what you just typed. Secrets stay in the browser — they're
 * only ever sent to the local Nitro server when you click "Test" or "Run".
 */
export function useMigrationConfig() {
  const cfg = useState<MigrationConfigInput>("migration-config", empty);

  if (import.meta.client) {
    // Hydrate from localStorage once.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<MigrationConfigInput>;
        cfg.value = { ...empty(), ...parsed };
      } catch {
        // ignore
      }
    }
    watch(
      cfg,
      (v) => {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
        } catch {
          // storage quota / privacy mode — silently ignore
        }
      },
      { deep: true },
    );
  }

  function reset() {
    cfg.value = empty();
  }

  return { config: cfg, reset };
}
