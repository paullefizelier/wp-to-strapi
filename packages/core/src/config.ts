/**
 * AppConfig is the single shape both the CLI and the web UI pass to the Migrator.
 * No filesystem/env coupling here — callers are responsible for loading values.
 */

export interface WpConfig {
  baseUrl: string;
  username?: string;
  appPassword?: string;
}

export interface StrapiConfig {
  baseUrl: string;
  token: string;
  postUid: string;
  pageUid: string;
  postPluralPath?: string;
  pagePluralPath?: string;
}

export interface AppConfig {
  wp: WpConfig;
  strapi: StrapiConfig;
  concurrency: number;
  pageSize: number;
  stateFile: string;
  dryRun: boolean;
  /**
   * When the REST body is empty or comes from a page builder, scrape the public page and keep
   * its text and images. Off means those entries import as WordPress returned them.
   */
  htmlFallback: boolean;
}

export const defaults = {
  htmlFallback: true,
  concurrency: 4,
  pageSize: 100,
  stateFile: "./.migration-state.json",
  dryRun: false,
  postUid: "api::post.post",
  pageUid: "api::page.page",
} as const;

/** Build a config from a partial input, applying defaults. Throws on missing required fields. */
export function buildConfig(input: {
  wp: Partial<WpConfig> & { baseUrl: string };
  strapi: Partial<StrapiConfig> & { baseUrl: string; token: string };
  concurrency?: number;
  pageSize?: number;
  stateFile?: string;
  dryRun?: boolean;
  htmlFallback?: boolean;
}): AppConfig {
  return {
    wp: {
      baseUrl: input.wp.baseUrl.replace(/\/+$/, ""),
      username: input.wp.username,
      appPassword: input.wp.appPassword,
    },
    strapi: {
      baseUrl: input.strapi.baseUrl.replace(/\/+$/, ""),
      token: input.strapi.token,
      postUid: input.strapi.postUid ?? defaults.postUid,
      pageUid: input.strapi.pageUid ?? defaults.pageUid,
      postPluralPath: input.strapi.postPluralPath,
      pagePluralPath: input.strapi.pagePluralPath,
    },
    concurrency: input.concurrency ?? defaults.concurrency,
    pageSize: input.pageSize ?? defaults.pageSize,
    stateFile: input.stateFile ?? defaults.stateFile,
    dryRun: input.dryRun ?? defaults.dryRun,
    htmlFallback: input.htmlFallback ?? defaults.htmlFallback,
  };
}
