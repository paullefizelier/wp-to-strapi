import { request, FormData, type Dispatcher } from "undici";
import type { ContentTypeSummary, TargetField, TargetSchema } from "./introspect.js";
import { HttpStatusError, parseRetryAfter, withRetry } from "./retry.js";
import type { WriteOptions } from "./strapi-adapter.js";
import type { StrapiEntry, StrapiUploadFile } from "./types.js";

type HttpMethod = Dispatcher.HttpMethod;

export interface StrapiClientOptions {
  baseUrl: string;
  token: string;
  /** Extra attempts on rate limiting, 5xx and dropped sockets. */
  retries?: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/**
 * Strapi v5 REST client.
 *
 * Notes on v5:
 *  - Entries are addressed by `documentId` (not numeric id).
 *  - Collection endpoints live at `/api/{pluralApiId}`.
 *  - Responses are flat: { data: { id, documentId, ...attrs } } (no nested `attributes`).
 *  - Media upload is unchanged from v4: POST /api/upload (multipart/form-data).
 */
/** v5 reads the publication target from the query string, not from the payload. */
function statusQuery(options?: WriteOptions): string {
  return options?.status ? `?status=${options.status}` : "";
}

interface CtbAttribute {
  type?: string;
  required?: boolean;
  target?: string;
  enum?: string[];
  component?: string;
  repeatable?: boolean;
  components?: string[];
}

interface CtbContentType {
  uid: string;
  apiID?: string;
  schema?: {
    displayName?: string;
    kind?: "collectionType" | "singleType";
    pluralName?: string;
    visible?: boolean;
    attributes?: Record<string, CtbAttribute>;
  };
}

interface CtbComponent {
  uid: string;
  schema?: { displayName?: string; attributes?: Record<string, CtbAttribute> };
}

/** Flatten one CTB attribute, pulling in the component's own fields when there are any. */
function toTargetField(
  name: string,
  a: CtbAttribute,
  components: Map<string, CtbComponent>,
): TargetField {
  const field: TargetField = {
    name,
    type: a.type,
    required: a.required,
    target: a.target,
    options: a.enum,
  };
  if (a.type === "component" && a.component) {
    field.component = a.component;
    field.repeatable = a.repeatable;
    field.fields = componentFields(a.component, components);
  }
  if (a.type === "dynamiczone" && a.components) {
    field.components = a.components;
    field.fields = a.components.flatMap((uid) => componentFields(uid, components));
  }
  return field;
}

function componentFields(uid: string, components: Map<string, CtbComponent>): TargetField[] {
  const attributes = components.get(uid)?.schema?.attributes ?? {};
  return Object.entries(attributes).map(([name, a]) => ({
    name,
    type: a.type,
    required: a.required,
    options: a.enum,
  }));
}

export class StrapiClient {
  private componentCache: Map<string, CtbComponent> | null = null;
  private readonly baseUrl: string;
  private readonly retry: { retries: number; onRetry?: StrapiClientOptions["onRetry"] };

  constructor(private readonly opts: StrapiClientOptions) {
    // A pasted URL keeps its trailing slash, and `https://host//api/posts` never matches an
    // API route: Strapi falls through to the static-file middleware, which answers
    // 400 "Malicious Path". Normalise here rather than trusting every caller.
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
    this.retry = { retries: opts.retries ?? 3, onRetry: opts.onRetry };
  }

  private async json<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return withRetry(async () => {
      const res = await request(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text();
        throw new HttpStatusError(
          `Strapi ${method} ${path} failed ${res.statusCode}: ${text.slice(0, 500)}`,
          res.statusCode,
          parseRetryAfter(res.headers["retry-after"]),
        );
      }
      return (await res.body.json()) as T;
    }, this.retry);
  }

  /** A single type lives at its singular route; everything else at the plural one. */
  singleUrl(uid: string, override?: string): string {
    const parts = uid.trim().split(".");
    const last = (parts[parts.length - 1] ?? uid).trim();
    return `/api/${(override || last).trim().replace(/^\/+|\/+$/g, "")}`;
  }

  /** Derive the plural REST path from an API UID like `api::post.post`. */
  private pluralPath(uid: string): string {
    const parts = uid.trim().split(".");
    const last = (parts[parts.length - 1] ?? uid).trim();
    // Basic English pluralization fallback. Override via STRAPI_*_PLURAL env if needed.
    if (last.endsWith("y")) return `${last.slice(0, -1)}ies`;
    if (last.endsWith("s")) return last;
    return `${last}s`;
  }

  collectionUrl(uid: string, pluralOverride?: string): string {
    // Any stray slash here produces a path Strapi does not route, and the static-file
    // middleware answers 400 "Malicious Path" rather than a helpful 404.
    const segment = (pluralOverride || this.pluralPath(uid)).trim().replace(/^\/+|\/+$/g, "");
    return `/api/${segment}`;
  }

  /** Call a collection endpoint with page size 1 to validate token + UID. */
  async probe(uid: string, pluralOverride?: string): Promise<{ ok: true; total: number } | { ok: false; status: number; message: string }> {
    const path = `${this.collectionUrl(uid, pluralOverride)}?pagination[pageSize]=1&pagination[withCount]=true`;
    const res = await request(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: "application/json",
      },
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { ok: false, status: res.statusCode, message: text.slice(0, 300) };
    }
    try {
      const body = JSON.parse(text) as { meta?: { pagination?: { total?: number } } };
      return { ok: true, total: body.meta?.pagination?.total ?? 0 };
    } catch {
      return { ok: false, status: res.statusCode, message: "invalid JSON from Strapi" };
    }
  }

  /** Upload a binary file to Strapi's media library. Returns the created upload file record. */
  async uploadFile(args: {
    buffer: Buffer;
    fileName: string;
    contentType: string;
    alternativeText?: string;
    caption?: string;
  }): Promise<StrapiUploadFile> {
    const form = new FormData();
    const blob = new Blob([args.buffer], { type: args.contentType });
    form.append("files", blob, args.fileName);
    const fileInfo: Record<string, string> = {};
    if (args.alternativeText)
      fileInfo.alternativeText = args.alternativeText;
    if (args.caption) fileInfo.caption = args.caption;
    if (Object.keys(fileInfo).length > 0) {
      form.append("fileInfo", JSON.stringify(fileInfo));
    }

    const arr = await withRetry(async () => {
      const res = await request(`${this.baseUrl}/api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.token}` },
        body: form,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text();
        throw new HttpStatusError(
          `Strapi upload failed ${res.statusCode}: ${text.slice(0, 500)}`,
          res.statusCode,
          parseRetryAfter(res.headers["retry-after"]),
        );
      }
      return (await res.body.json()) as StrapiUploadFile[];
    }, this.retry);
    if (!arr[0]) throw new Error("Strapi upload returned empty array");
    return arr[0];
  }

  /**
   * List the content types this Strapi exposes.
   *
   * The Content-Type Builder publishes content-API routes under /api/content-type-builder,
   * so a plain API token is enough — no admin session, and nothing to type by hand.
   */
  async listContentTypes(): Promise<ContentTypeSummary[]> {
    const resp = await this.json<{ data?: CtbContentType[] }>(
      "GET",
      "/api/content-type-builder/content-types",
    );
    return (resp.data ?? [])
      .filter((ct) => ct.uid?.startsWith("api::") || ct.schema?.visible)
      .map((ct) => ({
        uid: ct.uid,
        displayName: ct.schema?.displayName ?? ct.apiID ?? ct.uid,
        kind: ct.schema?.kind ?? "collectionType",
        pluralName: ct.schema?.pluralName,
        visible: ct.schema?.visible !== false,
      }));
  }

  /** Component definitions, so a mapping can target the fields inside a component. */
  private async components(): Promise<Map<string, CtbComponent>> {
    if (this.componentCache) return this.componentCache;
    try {
      const resp = await this.json<{ data?: CtbComponent[] }>(
        "GET",
        "/api/content-type-builder/components",
      );
      this.componentCache = new Map((resp.data ?? []).map((c) => [c.uid, c]));
    } catch {
      this.componentCache = new Map();
    }
    return this.componentCache;
  }

  /**
   * Describe a target content-type: its fields, and the fields inside any component or
   * dynamic zone, so a rich-text component can be mapped as easily as a plain attribute.
   *
   * Falls back to inferring the shape from an existing entry when the Content-Type Builder is
   * not reachable — hence the `source` flag, so the UI can say how much to trust the list.
   */
  async describeTarget(uid: string, pluralOverride?: string): Promise<TargetSchema> {
    try {
      const resp = await this.json<{ data?: CtbContentType }>(
        "GET",
        `/api/content-type-builder/content-types/${encodeURIComponent(uid)}`,
      );
      const attributes = resp.data?.schema?.attributes;
      if (attributes && Object.keys(attributes).length > 0) {
        const components = await this.components();
        return {
          uid,
          source: "schema",
          fields: Object.entries(attributes).map(([name, a]) =>
            toTargetField(name, a, components),
          ),
        };
      }
    } catch {
      // Older Strapi, or a token without access to the Content-Type Builder routes.
    }

    try {
      const path = `${this.collectionUrl(uid, pluralOverride)}?pagination[pageSize]=1&status=draft`;
      const sample = await this.json<{ data?: Array<Record<string, unknown>> }>("GET", path);
      const entry = sample.data?.[0];
      if (entry) {
        const fields: TargetField[] = Object.entries(entry)
          .filter(([name]) => !["id", "documentId", "createdAt", "updatedAt"].includes(name))
          .map(([name, value]) => ({
            name,
            type: typeof value === "object" && value !== null ? "relation" : typeof value,
          }));
        return {
          uid,
          source: "sample",
          fields,
          note: "Inferred from an existing entry — fields left empty on it are missing.",
        };
      }
      return {
        uid,
        source: "none",
        fields: [],
        note: "No entry to infer from yet. Type the Strapi field names by hand.",
      };
    } catch (err) {
      return { uid, source: "none", fields: [], note: (err as Error).message };
    }
  }

  /** Look up an entry by a unique field (e.g., slug or an external id) via filters. */
  async findOneBy(
    uid: string,
    field: string,
    value: string | number,
    pluralOverride?: string,
  ): Promise<StrapiEntry | null> {
    // `status=draft` is v5's way of reaching every document: a published one keeps a draft
    // version alongside it, so this finds both. (v4's `publicationState=preview` is rejected.)
    const path = `${this.collectionUrl(uid, pluralOverride)}?filters[${field}][$eq]=${encodeURIComponent(
      String(value),
    )}&pagination[pageSize]=1&status=draft`;
    const resp = await this.json<{ data: StrapiEntry[] }>("GET", path);
    return resp.data[0] ?? null;
  }

  async create<T extends object>(
    uid: string,
    data: T,
    pluralOverride?: string,
    options?: WriteOptions,
  ): Promise<StrapiEntry> {
    // A single type has no collection to POST into: PUT on its own route creates or replaces.
    const url = options?.single
      ? this.singleUrl(uid, pluralOverride)
      : this.collectionUrl(uid, pluralOverride);
    const resp = await this.json<{ data: StrapiEntry }>(
      options?.single ? "PUT" : "POST",
      `${url}${statusQuery(options)}`,
      { data },
    );
    return resp.data;
  }

  async update<T extends object>(
    uid: string,
    documentId: string,
    data: T,
    pluralOverride?: string,
    options?: WriteOptions,
  ): Promise<StrapiEntry> {
    const url = options?.single
      ? this.singleUrl(uid, pluralOverride)
      : `${this.collectionUrl(uid, pluralOverride)}/${documentId}`;
    const resp = await this.json<{ data: StrapiEntry }>("PUT", `${url}${statusQuery(options)}`, {
      data,
    });
    return resp.data;
  }

  async publish(uid: string, documentId: string, pluralOverride?: string): Promise<void> {
    await this.update(uid, documentId, {} as object, pluralOverride, { status: "published" });
  }
}
