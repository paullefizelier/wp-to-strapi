import { decodeEntities, rewriteMediaUrls } from "./html-transform.js";
import type { MigrationState } from "./state.js";

/**
 * One Strapi field, and where its value comes from.
 *
 * Either `source` (a path into the WordPress entity) or `value` (a constant written on every
 * entry — the "common fields" case). Transforms run left to right on whatever comes out.
 */
export interface FieldMapping {
  /** Strapi attribute to write, e.g. `title`, `seo_title`, `locale`. */
  target: string;
  /** Dot path into the WP entity: `title.rendered`, `acf.subtitle`, `meta._yoast_wpseo_title`. */
  source?: string;
  /** Constant value. Mutually exclusive with `source`. */
  value?: unknown;
  /** Transform names, applied in order. `name:arg` passes an argument. */
  transforms?: string[];
  /** Drop the field instead of writing an empty value. */
  omitEmpty?: boolean;
}

/** Per-kind mappings. `common` rows apply to every kind and are overridden by kind rows. */
export interface MappingSet {
  common?: FieldMapping[];
  post?: FieldMapping[];
  page?: FieldMapping[];
  category?: FieldMapping[];
  tag?: FieldMapping[];
  /** Keyed by the custom type's REST base. Falls back to `post` when absent. */
  custom?: Record<string, FieldMapping[]>;
}

export interface MappingContext {
  state: MigrationState;
  strapiBaseUrl: string;
  /**
   * Virtual sources merged over the entity, so a mapping can reach values the engine computed
   * rather than ones WordPress sent: `$content` (after the page-builder fallback),
   * `$publishedAt`, and anything a caller adds.
   */
  virtuals?: Record<string, unknown>;
}

type TransformFn = (value: unknown, arg: string | undefined, ctx: MappingContext) => unknown;

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function toArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The transform registry. Names are part of the saved configuration, so treat them as an API:
 * add freely, rename nothing.
 */
export const TRANSFORMS: Record<string, TransformFn> = {
  decodeEntities: (v) => decodeEntities(asText(v)),
  stripHtml: (v) =>
    decodeEntities(asText(v).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(),
  trim: (v) => asText(v).trim(),
  lower: (v) => asText(v).toLowerCase(),
  upper: (v) => asText(v).toUpperCase(),
  /** Point WP media URLs in HTML at their migrated Strapi files. */
  rewriteMedia: (v, _arg, ctx) => rewriteMediaUrls(asText(v), ctx.state, ctx.strapiBaseUrl),
  /** WP attachment id → Strapi file id, for media fields. */
  mediaId: (v, _arg, ctx) => {
    const ids = toArray(v)
      .map((id) => ctx.state.media[Number(id)]?.strapiId)
      .filter((id): id is number => typeof id === "number");
    return Array.isArray(v) ? ids : ids[0];
  },
  /** WP attachment id → the migrated file's URL. */
  mediaUrl: (v, _arg, ctx) => {
    const url = ctx.state.media[Number(v)]?.url;
    if (!url) return undefined;
    return url.startsWith("http") ? url : `${ctx.strapiBaseUrl.replace(/\/+$/, "")}${url}`;
  },
  /** WP term ids → Strapi documentIds. `terms:categories` or `terms:tags`. */
  terms: (v, arg, ctx) => {
    const taxonomy = arg === "tags" ? "tags" : "categories";
    return toArray(v)
      .map((id) => ctx.state[taxonomy][Number(id)]?.documentId)
      .filter((id): id is string => typeof id === "string");
  },
  date: (v) => {
    const text = asText(v);
    if (!text) return null;
    // WP GMT timestamps carry no zone designator.
    const parsed = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  },
  number: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  },
  boolean: (v) => v === true || v === "true" || v === 1 || v === "1",
  string: (v) => asText(v),
  slugify: (v) =>
    decodeEntities(asText(v))
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  first: (v) => toArray(v)[0],
  join: (v, arg) => toArray(v).map(asText).join(arg ?? ", "),
  truncate: (v, arg) => {
    const max = Number(arg ?? 280);
    const text = asText(v);
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  },
  default: (v, arg) => (isEmpty(v) ? arg : v),
  /**
   * Translate values: `map:actualites=professionnels,blog=grand-public`, with `*` as the
   * fallback. This is what turns a WordPress slug into a Strapi enumeration value.
   */
  map: (v, arg) => {
    const table = new Map(
      (arg ?? "")
        .split(",")
        .map((pair) => pair.split("="))
        .filter((parts): parts is [string, string] => parts.length === 2)
        .map(([from, to]) => [from.trim(), to.trim()]),
    );
    const translate = (value: unknown): unknown => {
      const hit = table.get(asText(value));
      if (hit !== undefined) return hit;
      const fallback = table.get("*");
      return fallback !== undefined ? fallback : value;
    };
    return Array.isArray(v) ? v.map(translate) : translate(v);
  },
};

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Read a dot path out of the entity. `a.b.0.c` walks objects and arrays alike. */
export function readPath(entity: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      const index = Number(key);
      return Number.isInteger(index) ? node[index] : undefined;
    }
    if (typeof node === "object") return (node as Record<string, unknown>)[key];
    return undefined;
  }, entity);
}

export interface MappingIssue {
  target: string;
  message: string;
}

/** Check a mapping before a run instead of failing entry by entry. */
export function validateMapping(rows: ReadonlyArray<FieldMapping>): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const target = row.target?.trim();
    if (!target) {
      issues.push({ target: row.target ?? "", message: "target field name is required" });
      continue;
    }
    if (seen.has(target)) issues.push({ target, message: "mapped more than once" });
    seen.add(target);
    if (row.source === undefined && row.value === undefined) {
      issues.push({ target, message: "needs either a source path or a constant value" });
    }
    if (row.source !== undefined && row.value !== undefined) {
      issues.push({ target, message: "set either a source path or a constant value, not both" });
    }
    for (const transform of row.transforms ?? []) {
      const name = transform.split(":")[0] ?? "";
      if (!TRANSFORMS[name]) {
        issues.push({ target, message: `unknown transform "${transform}"` });
      }
    }
  }
  return issues;
}

/** Later rows win, so kind-specific mappings override the common ones. */
export function mergeMappings(
  ...sets: Array<ReadonlyArray<FieldMapping> | undefined>
): FieldMapping[] {
  const byTarget = new Map<string, FieldMapping>();
  for (const set of sets) {
    for (const row of set ?? []) byTarget.set(row.target, row);
  }
  return [...byTarget.values()];
}

export interface MappingResult {
  data: Record<string, unknown>;
  warnings: string[];
}

/** Turn a WordPress entity into the Strapi payload described by `rows`. */
export function applyMapping(
  entity: unknown,
  rows: ReadonlyArray<FieldMapping>,
  ctx: MappingContext,
): MappingResult {
  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  const virtuals = ctx.virtuals ?? {};

  for (const row of rows) {
    const target = row.target?.trim();
    if (!target) continue;

    let value: unknown;
    if (row.source !== undefined) {
      value = row.source in virtuals ? virtuals[row.source] : readPath(entity, row.source);
    } else {
      value = row.value;
    }

    for (const transform of row.transforms ?? []) {
      const [name = "", ...rest] = transform.split(":");
      const fn = TRANSFORMS[name];
      if (!fn) {
        warnings.push(`unknown transform "${transform}" on field "${target}" — skipped`);
        continue;
      }
      value = fn(value, rest.length > 0 ? rest.join(":") : undefined, ctx);
    }

    if (value === undefined) continue;
    if (row.omitEmpty && isEmpty(value)) continue;
    data[target] = value;
  }
  return { data, warnings };
}

/**
 * The built-in mapping for posts, pages and custom types.
 *
 * `publishedAt` is deliberately absent: Strapi v5 strips it from any payload and decides
 * publication from the write's `status`, which the migrator sets from the WordPress status.
 * To keep the original WordPress date, map `$publishedAt` onto a date field of your own.
 */
export function defaultEntryMapping(): FieldMapping[] {
  return [
    { target: "title", source: "title.rendered", transforms: ["decodeEntities", "trim"] },
    { target: "slug", source: "slug" },
    { target: "content", source: "$content", transforms: ["rewriteMedia"] },
    { target: "excerpt", source: "excerpt.rendered", transforms: ["decodeEntities"] },
    { target: "wpId", source: "id" },
    { target: "cover", source: "featured_media", transforms: ["mediaId"], omitEmpty: true },
    {
      target: "categories",
      source: "categories",
      transforms: ["terms:categories"],
      omitEmpty: true,
    },
    { target: "tags", source: "tags", transforms: ["terms:tags"], omitEmpty: true },
  ];
}

/** The built-in mapping for taxonomy terms. */
export function defaultTermMapping(): FieldMapping[] {
  return [
    { target: "name", source: "name", transforms: ["decodeEntities", "trim"] },
    { target: "slug", source: "slug" },
    { target: "description", source: "description", transforms: ["decodeEntities"] },
    { target: "wpId", source: "id" },
  ];
}
