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
  /**
   * Relation field holding a page's parent. Set it to rebuild the page tree in a second pass;
   * left unset, pages import flat.
   */
  parentField?: string;
  /** Same, for hierarchical taxonomies (WordPress categories). */
  termParentField?: string;
  /** Set to migrate WordPress users into a content-type, relatable with `terms:authors`. */
  authorUid?: string;
  authorPluralPath?: string;
  /** Set to migrate approved comments, related to their entry. */
  commentUid?: string;
  commentPluralPath?: string;
  /** Set to migrate navigation menus; items land as a JSON tree on the entry. */
  menuUid?: string;
  menuPluralPath?: string;
  /** Relation field linking a comment to its entry. */
  commentEntryField: string;
}

/**
 * Send part of a WordPress listing to its own Strapi content-type.
 *
 * `Actualités` posts to `api::blog.blog`, `Communiqués de presse` to `api::press.press`: each
 * route picks entries by category or tag and has its own mapping, under `mapping.route[name]`.
 */
export interface RouteConfig {
  /** Keys the route's mapping and its state bucket. Keep it stable across runs. */
  name: string;
  /** Listing the route takes entries from. */
  from?: "posts" | "pages";
  /** Categories by name, slug or id. An entry matches if it has any of them. */
  categories?: Array<string | number>;
  /** Same, for tags. Combined with `categories` as an OR. */
  tags?: Array<string | number>;
  /** Target Strapi UID. */
  uid: string;
  pluralPath?: string;
}

export interface RoutingConfig {
  /** Evaluated in order; the first route that matches takes the entry. */
  routes: RouteConfig[];
  /** What happens to an entry no route takes: the default content-type, or nothing. */
  unmatched: "default" | "skip";
}

/** A WordPress taxonomy beyond categories and tags. */
export interface TaxonomyConfig {
  /** REST base under /wp/v2 — `genre` for /wp-json/wp/v2/genre. */
  restBase: string;
  /** Target Strapi UID. */
  uid: string;
  pluralPath?: string;
}

/** A WordPress custom post type mapped onto a Strapi collection. */
export interface CustomTypeConfig {
  /** REST base under /wp/v2 — `portfolio` for /wp-json/wp/v2/portfolio. */
  restBase: string;
  /** Target Strapi UID, e.g. `api::project.project`. */
  uid: string;
  /** Override when the plural REST path is not the naive pluralisation of the UID. */
  pluralPath?: string;
  /**
   * Write into a Strapi single type rather than a collection. WordPress still returns a list,
   * so the newest entry wins unless `wpId` or `slug` names the one to take.
   */
  single?: boolean;
  wpId?: number;
  slug?: string;
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
  /** Custom taxonomies to migrate; attach them with the `terms:<restBase>` transform. */
  taxonomies: TaxonomyConfig[];
  /** Route posts and pages to different content-types by category or tag. */
  routing: RoutingConfig;
  /**
   * Where to write the old-URL → new-entry table. Unset means no file, but the redirects are
   * still recorded in the state.
   */
  redirectsFile?: string;
  /**
   * Field mapping. A kind's rows replace the built-in mapping entirely, so what you configure
   * is what gets written; `common` rows are merged underneath every kind. Omit for the
   * built-in behaviour.
   */
  mapping: MappingSet;
  /**
   * Import only these WordPress ids. A kind left out imports everything; an empty list
   * imports nothing of that kind.
   */
  selection: SelectionConfig;
  /**
   * `used` migrates only the files the imported entries point at (featured image, images in
   * the content, fields mapped through `mediaId`/`mediaUrl`); `all` the whole library.
   */
  mediaScope: "all" | "used";
}

export interface SelectionConfig {
  posts?: number[];
  pages?: number[];
  /** Keyed by custom type REST base. */
  custom?: Record<string, number[]>;
}

export const DRAFT_STATUSES = ["draft", "pending", "future", "private"] as const;

export const defaults = {
  htmlFallback: true,
  statuses: ["publish"],
  retries: 3,
  categoryField: "categories",
  tagField: "tags",
  correlationField: "wpId",
  commentEntryField: "article",
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
  selection?: SelectionConfig;
  mediaScope?: "all" | "used";
  taxonomies?: TaxonomyConfig[];
  routing?: Partial<RoutingConfig>;
  redirectsFile?: string;
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
      parentField: input.strapi.parentField,
      termParentField: input.strapi.termParentField,
      authorUid: input.strapi.authorUid,
      authorPluralPath: input.strapi.authorPluralPath,
      commentUid: input.strapi.commentUid,
      commentPluralPath: input.strapi.commentPluralPath,
      menuUid: input.strapi.menuUid,
      menuPluralPath: input.strapi.menuPluralPath,
      commentEntryField: input.strapi.commentEntryField ?? defaults.commentEntryField,
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
    taxonomies: input.taxonomies ? [...input.taxonomies] : [],
    routing: {
      routes: input.routing?.routes ? [...input.routing.routes] : [],
      unmatched: input.routing?.unmatched ?? "default",
    },
    redirectsFile: input.redirectsFile,
    mapping: input.mapping ?? {},
    selection: input.selection ?? {},
    mediaScope: input.mediaScope ?? "all",
  };
}
