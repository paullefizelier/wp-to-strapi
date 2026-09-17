import type {
  StrapiAdapter,
  StrapiEntry,
  StrapiUploadFile,
} from "@paullefizelier/wp-to-strapi-core";

/**
 * Minimal, loose typing of the Strapi runtime surface we need. Using `any` at the edge
 * lets us avoid pinning a specific @strapi/strapi major version. The plugin passes
 * the `strapi` global as-is.
 */
export interface StrapiLike {
  documents: (uid: string) => {
    findFirst: (params: { filters?: Record<string, unknown>; status?: "draft" | "published" }) => Promise<unknown>;
    findMany: (params: { filters?: Record<string, unknown>; pagination?: { pageSize?: number } }) => Promise<unknown[]>;
    create: (params: { data: Record<string, unknown>; status?: "draft" | "published" }) => Promise<unknown>;
    update: (params: { documentId: string; data: Record<string, unknown>; status?: "draft" | "published" }) => Promise<unknown>;
  };
  plugin: (name: string) => {
    service: (name: string) => unknown;
  };
}

interface UploadService {
  upload: (args: {
    data: { fileInfo?: { name?: string; alternativeText?: string; caption?: string } };
    files: { filepath?: string; originalFilename?: string; mimetype?: string; size?: number; buffer?: Buffer } | { filepath?: string; originalFilename?: string; mimetype?: string; size?: number; buffer?: Buffer }[];
  }) => Promise<Array<{ id: number; documentId?: string; url: string; name: string; mime: string; width?: number; height?: number; formats?: Record<string, { url?: string; width?: number } | undefined> | null }>>;
}

/**
 * Native in-process adapter: uses `strapi.documents()` for entry CRUD and the upload
 * plugin service for media. No HTTP, no API token, and respects any configured upload
 * provider (S3, Cloudinary, etc.) automatically.
 */
export class NativeStrapiAdapter implements StrapiAdapter {
  constructor(private readonly strapi: StrapiLike) {}

  private upload(): UploadService {
    const svc = this.strapi.plugin("upload").service("upload") as UploadService | undefined;
    if (!svc) throw new Error("Strapi upload service not available");
    return svc;
  }

  async uploadFile(args: {
    buffer: Buffer;
    fileName: string;
    contentType: string;
    alternativeText?: string;
    caption?: string;
  }): Promise<StrapiUploadFile> {
    const svc = this.upload();
    const uploaded = await svc.upload({
      data: {
        fileInfo: {
          name: args.fileName,
          alternativeText: args.alternativeText,
          caption: args.caption,
        },
      },
      files: {
        buffer: args.buffer,
        originalFilename: args.fileName,
        mimetype: args.contentType,
        size: args.buffer.length,
      },
    });
    const first = uploaded[0];
    if (!first) throw new Error("Strapi upload returned empty array");
    return {
      id: first.id,
      documentId: first.documentId,
      name: first.name,
      url: first.url,
      mime: first.mime,
      width: first.width,
      height: first.height,
      formats: first.formats,
    };
  }

  async findOneBy(
    uid: string,
    field: string,
    value: string | number,
  ): Promise<StrapiEntry | null> {
    const found = (await this.strapi.documents(uid).findFirst({
      filters: { [field]: { $eq: value } },
      status: "draft",
    })) as { id: number; documentId: string } | null;
    return found ? { id: found.id, documentId: found.documentId } : null;
  }

  async create<T extends object>(uid: string, data: T): Promise<StrapiEntry> {
    const created = (await this.strapi.documents(uid).create({
      data: data as Record<string, unknown>,
    })) as { id: number; documentId: string };
    return { id: created.id, documentId: created.documentId };
  }

  async update<T extends object>(
    uid: string,
    documentId: string,
    data: T,
  ): Promise<StrapiEntry> {
    const updated = (await this.strapi.documents(uid).update({
      documentId,
      data: data as Record<string, unknown>,
    })) as { id: number; documentId: string };
    return { id: updated.id, documentId: updated.documentId };
  }
}
