import { request } from "undici";
import { flattenEntity, VIRTUAL_SOURCES, type SourceField } from "./introspect.js";
import { HttpStatusError, parseRetryAfter, withRetry } from "./retry.js";
import type { WpMedia, WpPage, WpPost, WpTerm } from "./types.js";

export interface WordPressClientOptions {
  baseUrl: string;
  username?: string;
  appPassword?: string;
  pageSize?: number;
  /** Extra attempts on rate limiting, 5xx and dropped sockets. */
  retries?: number;
  /** Called before each backoff wait, so a run can log what it is waiting on. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/** `include` narrows a listing to specific ids — how a retry fetches only what failed. */
function includeQuery(include?: ReadonlyArray<number>): Record<string, string> {
  return include && include.length > 0 ? { include: include.join(",") } : {};
}

export class WordPressClient {
  private readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly pageSize: number;
  private readonly retry: { retries: number; onRetry?: WordPressClientOptions["onRetry"] };

  constructor(opts: WordPressClientOptions) {
    this.baseUrl = `${opts.baseUrl.trim().replace(/\/+$/, "")}/wp-json/wp/v2`;
    this.pageSize = opts.pageSize ?? 100;
    this.retry = { retries: opts.retries ?? 3, onRetry: opts.onRetry };
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

    return withRetry(async () => {
      const res = await request(url, { method: "GET", headers });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text();
        throw new HttpStatusError(
          `WP GET ${url.pathname} failed ${res.statusCode}: ${text.slice(0, 300)}`,
          res.statusCode,
          parseRetryAfter(res.headers["retry-after"]),
        );
      }
      const totalPages = Number(res.headers["x-wp-totalpages"] ?? "1");
      const total = Number(res.headers["x-wp-total"] ?? "0");
      const body = (await res.body.json()) as T;
      return { body, totalPages, total };
    }, this.retry);
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

  posts(
    statuses: ReadonlyArray<string> = ["publish"],
    include?: ReadonlyArray<number>,
  ): AsyncGenerator<WpPost> {
    return this.paginate<WpPost>("/posts", {
      status: statuses.join(","),
      ...includeQuery(include),
    });
  }

  pages(
    statuses: ReadonlyArray<string> = ["publish"],
    include?: ReadonlyArray<number>,
  ): AsyncGenerator<WpPage> {
    return this.paginate<WpPage>("/pages", {
      status: statuses.join(","),
      ...includeQuery(include),
    });
  }

  /** Any custom post type exposed under its REST base, e.g. `portfolio`. */
  customType(
    restBase: string,
    statuses: ReadonlyArray<string> = ["publish"],
    include?: ReadonlyArray<number>,
  ): AsyncGenerator<WpPost> {
    return this.paginate<WpPost>(`/${restBase.replace(/^\/+/, "")}`, {
      status: statuses.join(","),
      ...includeQuery(include),
    });
  }

  /** Terms of a taxonomy (`categories`, `tags`, or a custom taxonomy's REST base). */
  terms(restBase: string): AsyncGenerator<WpTerm> {
    return this.paginate<WpTerm>(`/${restBase.replace(/^\/+/, "")}`);
  }

  media(): AsyncGenerator<WpMedia> {
    return this.paginate<WpMedia>("/media", { status: "inherit" });
  }

  /**
   * List the fields available on a WP content type, from a real entry. Uses the `edit` context
   * when credentials are set, which is what exposes `meta` — plugins like ACF surface their
   * fields here too.
   */
  async describeSource(restBase = "posts"): Promise<SourceField[]> {
    const path = `/${restBase.replace(/^\/+/, "")}`;
    const query: Record<string, string | number> = { per_page: 1 };
    if (this.authHeader) query.context = "edit";
    let body: unknown[];
    try {
      ({ body } = await this.get<unknown[]>(path, query));
    } catch (err) {
      // `context=edit` is refused when the account lacks the capability — retry as a reader.
      if (!this.authHeader) throw err;
      ({ body } = await this.get<unknown[]>(path, { per_page: 1 }));
    }
    const sample = body[0];
    if (!sample) return [...VIRTUAL_SOURCES];
    return [...flattenEntity(sample), ...VIRTUAL_SOURCES];
  }

  /** True when the client can authenticate — non-public statuses require it. */
  get authenticated(): boolean {
    return this.authHeader !== undefined;
  }

  /**
   * Fetch a public page as HTML. Used to recover content the REST API cannot render —
   * page builders keep their layout in post meta and only emit it on the front end.
   */
  async fetchPage(url: string): Promise<string> {
    return withRetry(async () => {
      const res = await request(url, {
        method: "GET",
        maxRedirections: 3,
        headers: {
          Accept: "text/html",
          "User-Agent": "wp-to-strapi/0.1",
          ...(this.authHeader ? { Authorization: this.authHeader } : {}),
        },
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new HttpStatusError(
          `WP GET ${url} failed: ${res.statusCode}`,
          res.statusCode,
          parseRetryAfter(res.headers["retry-after"]),
        );
      }
      return res.body.text();
    }, this.retry);
  }

  async fetchBinary(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    return withRetry(async () => {
      const res = await request(url, {
        method: "GET",
        headers: this.authHeader
          ? { Authorization: this.authHeader, "User-Agent": "wp-to-strapi/0.1" }
          : { "User-Agent": "wp-to-strapi/0.1" },
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new HttpStatusError(
          `Download ${url} failed: ${res.statusCode}`,
          res.statusCode,
          parseRetryAfter(res.headers["retry-after"]),
        );
      }
      const arr = await res.body.arrayBuffer();
      const contentType =
        (res.headers["content-type"] as string | undefined) ?? "application/octet-stream";
      return { buffer: Buffer.from(arr), contentType };
    }, this.retry);
  }
}
