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
  ): Promise<StrapiEntry>;

  update<T extends object>(
    uid: string,
    documentId: string,
    data: T,
    pluralOverride?: string,
  ): Promise<StrapiEntry>;
}
