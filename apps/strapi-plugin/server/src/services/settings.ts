import type { Core } from "@strapi/strapi";

export interface StoredSettings {
  wpBaseUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  postUid: string;
  pageUid: string;
  concurrency: number;
  pageSize: number;
}

const DEFAULTS: StoredSettings = {
  wpBaseUrl: "",
  wpUsername: "",
  wpAppPassword: "",
  postUid: "api::post.post",
  pageUid: "api::page.page",
  concurrency: 4,
  pageSize: 100,
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
