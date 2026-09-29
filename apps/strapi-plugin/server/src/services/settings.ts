import type { Core } from "@strapi/strapi";

export interface StoredSettings {
  wpBaseUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  postUid: string;
  pageUid: string;
  /** Empty means the taxonomy is not migrated. */
  categoryUid: string;
  tagUid: string;
  concurrency: number;
  pageSize: number;
  /** WP statuses to fetch. Anything beyond `publish` needs WP credentials. */
  statuses: string[];
  /** `restBase:api::uid.uid[|pluralPath]`, one entry per custom post type. */
  customTypes: string[];
  htmlFallback: boolean;
  /** Field mapping as JSON text, edited in the admin panel. Empty means the built-in mapping. */
  mapping: string;
  /** Routing as JSON text: `{ routes, unmatched }` or a bare array of routes. */
  routing: string;
}

const DEFAULTS: StoredSettings = {
  wpBaseUrl: "",
  wpUsername: "",
  wpAppPassword: "",
  postUid: "api::post.post",
  pageUid: "api::page.page",
  categoryUid: "",
  tagUid: "",
  concurrency: 4,
  pageSize: 100,
  statuses: ["publish"],
  customTypes: [],
  htmlFallback: true,
  mapping: "",
  routing: "",
};

/**
 * Persists credentials + options in Strapi's core store so they survive restarts
 * without needing to be in an .env file. Rotates via the settings page.
 */
const service = ({ strapi }: { strapi: Core.Strapi }) => {
  const pluginStore = () =>
    strapi.store({ type: "plugin", name: "wp-import", key: "settings" });

  return {
    async get(): Promise<StoredSettings> {
      const v = (await pluginStore().get({})) as Partial<StoredSettings> | null;
      return { ...DEFAULTS, ...(v ?? {}) };
    },

    async set(next: Partial<StoredSettings>): Promise<StoredSettings> {
      const merged: StoredSettings = { ...(await this.get()), ...next };
      await pluginStore().set({ value: merged });
      return merged;
    },
  };
};

export default service;
