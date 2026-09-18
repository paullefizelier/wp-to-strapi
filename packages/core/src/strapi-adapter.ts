import type { TargetSchema } from "./introspect.js";

/**
 * Strapi v5 decides publication by `status`, never by a `publishedAt` in the payload: the
 * Document Service strips that attribute and defaults every write to a draft.
 */
export interface WriteOptions {
  status?: "draft" | "published";
}
import type { StrapiEntry, StrapiUploadFile } from "./types.js";

/**
 * The surface the Migrator needs from Strapi.
 *
 * Two implementations live in the monorepo:
 *   - StrapiClient (./strapi-client.ts) — talks to Strapi's REST API. Used by the CLI and the Nuxt UI.
 *   - NativeStrapiAdapter (@wp-to-strapi/strapi-adapter) — uses strapi.documents() + the upload service directly,
 *     from inside a Strapi plugin. No token, no HTTP round-trip.
 */
export interface StrapiAdapter {
  uploadFile(args: {
    buffer: Buffer;
    fileName: string;
    contentType: string;
    alternativeText?: string;
    caption?: string;
  }): Promise<StrapiUploadFile>;

  findOneBy(
    uid: string,
    field: string,
    value: string | number,
    pluralOverride?: string,
  ): Promise<StrapiEntry | null>;

  create<T extends object>(
    uid: string,
    data: T,
    pluralOverride?: string,
    options?: WriteOptions,
  ): Promise<StrapiEntry>;

  update<T extends object>(
    uid: string,
    documentId: string,
    data: T,
    pluralOverride?: string,
    options?: WriteOptions,
  ): Promise<StrapiEntry>;

  /**
   * List the fields of a target content-type, to drive the mapping UI. Optional: an adapter
   * that cannot introspect its destination simply omits it, and callers fall back to typing
   * field names.
   */
  describeTarget?(uid: string, pluralOverride?: string): Promise<TargetSchema>;
}
