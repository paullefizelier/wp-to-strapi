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
  /** Set to migrate WP categories and relate them to posts. No default — opt in. */
  categoryUid?: string;
  categoryPluralPath?: string;
  /** Set to migrate WP tags and relate them to posts. No default — opt in. */
  tagUid?: string;
  tagPluralPath?: string;
  /** Relation field names on the post content-type. */
  categoryField: string;
  tagField: string;
}

/** A WordPress custom post type mapped onto a Strapi collection. */
export interface CustomTypeConfig {
  /** REST base under /wp/v2 — `portfolio` for /wp-json/wp/v2/portfolio. */
  restBase: string;
  /** Target Strapi UID, e.g. `api::project.project`. */
  uid: string;
  /** Override when the plural REST path is not the naive pluralisation of the UID. */
  pluralPath?: string;
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
  /**
   * WordPress statuses to fetch for posts, pages and custom types. Anything beyond `publish`
   * needs credentials, and lands in Strapi as a draft (`publishedAt: null`).
   */
  statuses: string[];
  /** Custom post types to migrate alongside posts and pages. */
  customTypes: CustomTypeConfig[];
}

export const DRAFT_STATUSES = ["draft", "pending", "future", "private"] as const;

export const defaults = {
  htmlFallback: true,
  statuses: ["publish"],
  categoryField: "categories",
  tagField: "tags",
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
  statuses?: string[];
  customTypes?: CustomTypeConfig[];
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
      categoryUid: input.strapi.categoryUid,
      categoryPluralPath: input.strapi.categoryPluralPath,
      tagUid: input.strapi.tagUid,
      tagPluralPath: input.strapi.tagPluralPath,
      categoryField: input.strapi.categoryField ?? defaults.categoryField,
      tagField: input.strapi.tagField ?? defaults.tagField,
    },
    concurrency: input.concurrency ?? defaults.concurrency,
    pageSize: input.pageSize ?? defaults.pageSize,
    stateFile: input.stateFile ?? defaults.stateFile,
    dryRun: input.dryRun ?? defaults.dryRun,
    htmlFallback: input.htmlFallback ?? defaults.htmlFallback,
    statuses:
      input.statuses && input.statuses.length > 0 ? [...input.statuses] : [...defaults.statuses],
    customTypes: input.customTypes ? [...input.customTypes] : [],
  };
}
