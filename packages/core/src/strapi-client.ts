import { request, FormData, type Dispatcher } from "undici";
import type { StrapiEntry, StrapiUploadFile } from "./types.js";

type HttpMethod = Dispatcher.HttpMethod;

export interface StrapiClientOptions {
  baseUrl: string;
  token: string;
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
export class StrapiClient {
  constructor(private readonly opts: StrapiClientOptions) {}

  private async json<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await request(`${this.opts.baseUrl}${path}`, {
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
      throw new Error(
        `Strapi ${method} ${path} failed ${res.statusCode}: ${text.slice(0, 500)}`,
      );
    }
    return (await res.body.json()) as T;
  }

  /** Derive the plural REST path from an API UID like `api::post.post`. */
  private pluralPath(uid: string): string {
    const parts = uid.split(".");
    const last = parts[parts.length - 1] ?? uid;
    // Basic English pluralization fallback. Override via STRAPI_*_PLURAL env if needed.
    if (last.endsWith("y")) return `${last.slice(0, -1)}ies`;
    if (last.endsWith("s")) return last;
    return `${last}s`;
  }

  collectionUrl(uid: string, pluralOverride?: string): string {
    return `/api/${pluralOverride || this.pluralPath(uid)}`;
  }

  /** Call a collection endpoint with page size 1 to validate token + UID. */
  async probe(uid: string, pluralOverride?: string): Promise<{ ok: true; total: number } | { ok: false; status: number; message: string }> {
    const path = `${this.collectionUrl(uid, pluralOverride)}?pagination[pageSize]=1&pagination[withCount]=true`;
    const res = await request(`${this.opts.baseUrl}${path}`, {
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

    const res = await request(`${this.opts.baseUrl}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.token}` },
      body: form,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(
        `Strapi upload failed ${res.statusCode}: ${text.slice(0, 500)}`,
      );
    }
    const arr = (await res.body.json()) as StrapiUploadFile[];
    if (!arr[0]) throw new Error("Strapi upload returned empty array");
    return arr[0];
  }

  /** Look up an entry by a unique field (e.g., slug or an external id) via filters. */
  async findOneBy(
    uid: string,
    field: string,
    value: string | number,
    pluralOverride?: string,
  ): Promise<StrapiEntry | null> {
    const path = `${this.collectionUrl(uid, pluralOverride)}?filters[${field}][$eq]=${encodeURIComponent(
      String(value),
    )}&pagination[pageSize]=1&publicationState=preview`;
    const resp = await this.json<{ data: StrapiEntry[] }>("GET", path);
    return resp.data[0] ?? null;
  }

  async create<T extends object>(
    uid: string,
    data: T,
    pluralOverride?: string,
  ): Promise<StrapiEntry> {
    const resp = await this.json<{ data: StrapiEntry }>(
      "POST",
      this.collectionUrl(uid, pluralOverride),
      { data },
    );
    return resp.data;
  }

  async update<T extends object>(
    uid: string,
    documentId: string,
    data: T,
    pluralOverride?: string,
  ): Promise<StrapiEntry> {
    const resp = await this.json<{ data: StrapiEntry }>(
      "PUT",
      `${this.collectionUrl(uid, pluralOverride)}/${documentId}`,
      { data },
    );
    return resp.data;
  }

  async publish(
    uid: string,
    documentId: string,
    pluralOverride?: string,
  ): Promise<void> {
    // In Strapi v5, updating with publishedAt set publishes. Keep it simple and explicit.
    await this.update(
      uid,
      documentId,
      { publishedAt: new Date().toISOString() } as object,
      pluralOverride,
    );
  }
}
