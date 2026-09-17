import { request } from "undici";
import type { WpMedia, WpPage, WpPost } from "./types.js";

export interface WordPressClientOptions {
  baseUrl: string;
  username?: string;
  appPassword?: string;
  pageSize?: number;
}

export class WordPressClient {
  private readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly pageSize: number;

  constructor(opts: WordPressClientOptions) {
    this.baseUrl = `${opts.baseUrl.replace(/\/+$/, "")}/wp-json/wp/v2`;
    this.pageSize = opts.pageSize ?? 100;
    if (opts.username && opts.appPassword) {
      const b64 = Buffer.from(`${opts.username}:${opts.appPassword}`).toString(
        "base64",
      );
      this.authHeader = `Basic ${b64}`;
    }
  }

  private async get<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ body: T; totalPages: number; total: number }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "wp-to-strapi/0.1",
    };
    if (this.authHeader) headers.Authorization = this.authHeader;

    const res = await request(url, { method: "GET", headers });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(
        `WP GET ${url.pathname} failed ${res.statusCode}: ${text.slice(0, 300)}`,
      );
    }
    const totalPages = Number(res.headers["x-wp-totalpages"] ?? "1");
    const total = Number(res.headers["x-wp-total"] ?? "0");
    const body = (await res.body.json()) as T;
    return { body, totalPages, total };
  }

  /**
   * Async-iterate a paginated endpoint.
   *
   * `status` is deliberately left to the caller: post types use `publish`, but attachments
   * are stored with WP's internal `inherit` status and the media endpoint rejects `publish`
   * outright (400 rest_forbidden_status).
   */
  private async *paginate<T>(
    path: string,
    extraQuery: Record<string, string | number | undefined> = {},
  ): AsyncGenerator<T> {
    let page = 1;
    while (true) {
      const { body, totalPages } = await this.get<T[]>(path, {
        ...extraQuery,
        per_page: this.pageSize,
        page,
        orderby: "id",
        order: "asc",
      });
      for (const item of body) yield item;
      if (page >= totalPages || body.length === 0) break;
      page += 1;
    }
  }

  /** Hit /posts with per_page=1 to verify the endpoint is reachable and return counts. */
  async probe(): Promise<{ posts: number; pages: number; media: number }> {
    const [posts, pages, media] = await Promise.all([
      this.get<unknown[]>("/posts", { per_page: 1, status: "publish" }),
      this.get<unknown[]>("/pages", { per_page: 1, status: "publish" }),
      this.get<unknown[]>("/media", { per_page: 1 }),
    ]);
    return { posts: posts.total, pages: pages.total, media: media.total };
  }

  posts(): AsyncGenerator<WpPost> {
    return this.paginate<WpPost>("/posts", { status: "publish" });
  }

  pages(): AsyncGenerator<WpPage> {
    return this.paginate<WpPage>("/pages", { status: "publish" });
  }

  media(): AsyncGenerator<WpMedia> {
    return this.paginate<WpMedia>("/media", { status: "inherit" });
  }

  async fetchBinary(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await request(url, {
      method: "GET",
      headers: this.authHeader
        ? { Authorization: this.authHeader, "User-Agent": "wp-to-strapi/0.1" }
        : { "User-Agent": "wp-to-strapi/0.1" },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Download ${url} failed: ${res.statusCode}`);
    }
    const arr = await res.body.arrayBuffer();
    const contentType =
      (res.headers["content-type"] as string | undefined) ??
      "application/octet-stream";
    return { buffer: Buffer.from(arr), contentType };
  }
}
