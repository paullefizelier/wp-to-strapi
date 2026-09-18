import type { MappingSet } from "./mapping.js";

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
  /**
   * Field holding the WordPress id on every Strapi entry. It is what makes a re-run update
   * instead of duplicating, so the mapping must write it.
   */
  correlationField: string;
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
  /** Extra attempts on rate limiting, 5xx and dropped sockets, per request. */
  retries: number;
  /** Custom post types to migrate alongside posts and pages. */
  customTypes: CustomTypeConfig[];
  /**
   * Field mapping. A kind's rows replace the built-in mapping entirely, so what you configure
   * is what gets written; `common` rows are merged underneath every kind. Omit for the
   * built-in behaviour.
   */
  mapping: MappingSet;
}

export const DRAFT_STATUSES = ["draft", "pending", "future", "private"] as const;

export const defaults = {
  htmlFallback: true,
  statuses: ["publish"],
  retries: 3,
  categoryField: "categories",
  tagField: "tags",
  correlationField: "wpId",
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
  retries?: number;
  customTypes?: CustomTypeConfig[];
  mapping?: MappingSet;
}): AppConfig {
  return {
    wp: {
      baseUrl: input.wp.baseUrl.trim().replace(/\/+$/, ""),
      username: input.wp.username,
      appPassword: input.wp.appPassword,
    },
    strapi: {
      baseUrl: input.strapi.baseUrl.trim().replace(/\/+$/, ""),
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
      correlationField: input.strapi.correlationField ?? defaults.correlationField,
    },
    concurrency: input.concurrency ?? defaults.concurrency,
    pageSize: input.pageSize ?? defaults.pageSize,
    stateFile: input.stateFile ?? defaults.stateFile,
    dryRun: input.dryRun ?? defaults.dryRun,
    htmlFallback: input.htmlFallback ?? defaults.htmlFallback,
    statuses:
      input.statuses && input.statuses.length > 0 ? [...input.statuses] : [...defaults.statuses],
    retries: input.retries ?? defaults.retries,
    customTypes: input.customTypes ? [...input.customTypes] : [],
    mapping: input.mapping ?? {},
  };
}
