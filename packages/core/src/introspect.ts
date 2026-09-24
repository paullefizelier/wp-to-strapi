/** A field available on the WordPress side, discovered from a sample entry. */
export interface SourceField {
  /** Dot path to use as a mapping `source`, e.g. `acf.subtitle`. */
  path: string;
  kind: "string" | "number" | "boolean" | "array" | "object" | "null";
  /** Short preview of the real value, to make the picker readable. */
  sample?: string;
}

/** A field on the Strapi side. */
export interface TargetField {
  name: string;
  /** Strapi attribute type when the real schema was available. */
  type?: string;
  required?: boolean;
  /** Related content-type or allowed media types, when known. */
  target?: string;
  /** Allowed values of an enumeration field — what a select will accept. */
  options?: string[];
  /** For a `component` attribute: the component UID and whether it repeats. */
  component?: string;
  repeatable?: boolean;
  /** For a `dynamiczone` attribute: the component UIDs it accepts. */
  components?: string[];
  /** Fields of the component(s) above, so a mapping can target inside them. */
  fields?: TargetField[];
}

/** A content type as offered in a picker, instead of typing `api::post.post` by hand. */
export interface ContentTypeSummary {
  uid: string;
  displayName: string;
  kind: "collectionType" | "singleType";
  /** REST path segment — what the collection lives under in /api/. */
  pluralName?: string;
  /** False for Strapi's internal types, which are never migration targets. */
  visible: boolean;
}

export interface TargetSchema {
  uid: string;
  fields: TargetField[];
  /**
   * `schema` — read from Strapi's own definition (plugin, in-process).
   * `sample` — inferred from an existing entry, so unpopulated fields are missing.
   * `none` — nothing could be read; map by typing field names.
   */
  source: "schema" | "sample" | "none";
  note?: string;
}

const MAX_DEPTH = 3;
const MAX_FIELDS = 300;

function preview(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

function kindOf(value: unknown): SourceField["kind"] {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "string";
  }
}

/**
 * Flatten a WordPress entity into the dot paths a mapping can address.
 *
 * Containers are listed too — `title` is as valid a source as `title.rendered`, and an ACF
 * repeater is worth seeing before drilling into it. Arrays are offered whole (that is what
 * `terms:` and `mediaId` consume) rather than expanded index by index.
 */
export function flattenEntity(entity: unknown, prefix = "", depth = 0): SourceField[] {
  if (depth > MAX_DEPTH || entity === null || typeof entity !== "object") return [];
  const out: SourceField[] = [];
  for (const [key, value] of Object.entries(entity as Record<string, unknown>)) {
    if (key.startsWith("_") && key !== "_embedded") continue; // REST plumbing: _links, _embedded
    const path = prefix ? `${prefix}.${key}` : key;
    out.push({ path, kind: kindOf(value), sample: preview(value) });
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenEntity(value, path, depth + 1));
    }
    if (out.length > MAX_FIELDS) break;
  }
  return out;
}

/** Virtual sources the migrator computes; they are as mappable as WordPress's own fields. */
export const VIRTUAL_SOURCES: SourceField[] = [
  {
    path: "$content",
    kind: "string",
    sample: "rendered content, after the page-builder fallback",
  },
  { path: "$publishedAt", kind: "string", sample: "GMT publish date, or null for a draft" },
  { path: "$link", kind: "string", sample: "the entry's public WordPress URL" },
  { path: "$status", kind: "string", sample: "publish, draft, future…" },
];
