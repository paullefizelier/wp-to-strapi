import { request } from "undici";
import { flattenEntity, VIRTUAL_SOURCES, type SourceField } from "./introspect.js";
import { HttpStatusError, parseRetryAfter, withRetry } from "./retry.js";
import type {
  WpComment,
  WpMedia,
  WpMenu,
  WpMenuItem,
  WpPage,
  WpPost,
  WpTerm,
  WpUser,
} from "./types.js";

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

/**
 * Whether a redirect is the same site under its canonical address — worth adopting, with the
 * credentials — or somewhere else, where they must not follow.
 *
 * Accepted: the same host with or without `www.`, and an upgrade from http to https. Refused:
 * another host (a moved site, or a hijack — either way not ours to send a password to) and a
 * downgrade to http, which would put the credentials on the wire in clear.
 */
export function isCanonicalRedirect(from: URL, to: URL): boolean {
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
  if (bare(from.host) !== bare(to.host)) return false;
  if (from.protocol === "https:" && to.protocol === "http:") return false;
  return true;
}

/** The site root a REST URL belongs to: everything before `/wp-json/`. */
function siteRootOf(url: URL): string | null {
  const index = url.pathname.indexOf("/wp-json/");
  if (index < 0) return null;
  return `${url.origin}${url.pathname.slice(0, index)}`;
}

export class WordPressClient {
  private baseUrl: string;
  private readonly configuredRoot: string;
  /**
   * Every site root the client has been sent to, in order, starting with the configured one.
   * Real sites often chain two hops (http://www → https://www → https://), so this is a path,
   * not a single move — and its order is what tells a chain from a loop.
   */
  private readonly visited: string[];
  private readonly authHeader?: string;
  private readonly pageSize: number;
  private readonly retry: { retries: number; onRetry?: WordPressClientOptions["onRetry"] };

  constructor(opts: WordPressClientOptions) {
    this.configuredRoot = opts.baseUrl.trim().replace(/\/+$/, "");
    this.baseUrl = `${this.configuredRoot}/wp-json/wp/v2`;
    this.visited = [this.configuredRoot];
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
      if (res.statusCode >= 300 && res.statusCode < 400) {
        await res.body.dump();
        if (this.adoptRedirect(url, res.headers.location)) return this.get<T>(path, query);
        throw new HttpStatusError(this.describeRedirect(url, res.statusCode, res.headers.location), res.statusCode);
      }
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
   * Move to the site's canonical address when WordPress redirects there.
   *
   * Following the redirect per request would lose the credentials: undici drops Authorization
   * whenever the origin changes, so an http→https or www hop turns an authenticated call into
   * an anonymous one — and drafts and meta quietly disappear. Adopting the new root once means
   * every later request goes straight to the right address, credentials intact.
   */
  private adoptRedirect(from: URL, location: string | string[] | undefined): boolean {
    const raw = Array.isArray(location) ? location[0] : location;
    if (!raw) return false;
    let to: URL;
    try {
      to = new URL(raw, from);
    } catch {
      return false;
    }
    const root = siteRootOf(to);
    if (!root) return false;
    // Judged against the address the user gave, not just the previous hop, so a chain cannot
    // drift to another site one plausible step at a time.
    let configured: URL;
    try {
      configured = new URL(this.configuredRoot);
    } catch {
      return false;
    }
    if (!isCanonicalRedirect(configured, to) || !isCanonicalRedirect(from, to)) return false;

    const fromRoot = siteRootOf(from);
    const fromIndex = fromRoot ? this.visited.indexOf(fromRoot) : -1;
    const toIndex = this.visited.indexOf(root);
    // Pointing back to where we came from is a loop. Pointing forward is either a new hop in
    // the chain or a request that was in flight before we moved — both are fine.
    if (toIndex !== -1 && toIndex <= fromIndex) return false;
    if (toIndex === -1) {
      if (this.visited.length >= 5) return false; // a chain this long is misconfiguration
      this.visited.push(root);
    }
    this.baseUrl = `${this.visited[this.visited.length - 1]}/wp-json/wp/v2`;
    return true;
  }

  private describeRedirect(
    from: URL,
    status: number,
    location: string | string[] | undefined,
  ): string {
    const raw = Array.isArray(location) ? location[0] : location;
    if (!raw) return `WP GET ${from.pathname} answered ${status} with no Location header`;
    let to: URL;
    try {
      to = new URL(raw, from);
    } catch {
      return `WP GET ${from.pathname} redirected (${status}) to an invalid address: ${raw}`;
    }
    if (from.protocol === "https:" && to.protocol === "http:") {
      return (
        `WordPress redirects from https to http (${to.origin}). Credentials would travel in ` +
        `clear, so the redirect was not followed.`
      );
    }
    if (siteRootOf(to) && isCanonicalRedirect(from, to)) {
      return (
        `WordPress keeps redirecting between ${from.origin} and ${to.origin} — a redirect loop, ` +
        `usually a mismatch between the site URL in WordPress settings and the server config.`
      );
    }
    if (!siteRootOf(to)) {
      return (
        `WordPress redirects the REST API to ${to.href}, outside /wp-json/. The REST API may be ` +
        `disabled, or blocked by a security plugin.`
      );
    }
    return (
      `WordPress redirects to another site (${to.origin}). Credentials are not sent there ` +
      `automatically — if that is the right address, use it as the WordPress URL.`
    );
  }

  /**
   * The site root actually in use. Differs from the configured one when WordPress redirected
   * to its canonical address — worth showing, so the stored URL can be corrected.
   */
  get resolvedBaseUrl(): string {
    return this.visited[this.visited.length - 1] ?? this.configuredRoot;
  }

  get redirected(): boolean {
    return this.visited.length > 1;
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

  /**
   * How many items an endpoint holds, from WordPress's own X-WP-Total header. Cheap (one
   * request) and it is what lets a run show "12 / 1651" instead of a count with no end.
   */
  async count(
    restBase: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<number> {
    try {
      const { total } = await this.get<unknown[]>(`/${restBase.replace(/^\/+/, "")}`, {
        ...query,
        per_page: 1,
      });
      return total;
    } catch {
      return 0; // an unknown total is better than a failed run
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

  /** Authors. `/users` only lists users with published content unless authenticated. */
  users(): AsyncGenerator<WpUser> {
    return this.paginate<WpUser>("/users");
  }

  /** Approved comments. */
  comments(): AsyncGenerator<WpComment> {
    return this.paginate<WpComment>("/comments", { status: "approve" });
  }

  /** Navigation menus and their items. Both need authentication (WP 5.9+). */
  menus(): AsyncGenerator<WpMenu> {
    return this.paginate<WpMenu>("/menus");
  }

  menuItems(menuId: number): AsyncGenerator<WpMenuItem> {
    return this.paginate<WpMenuItem>("/menu-items", { menus: menuId });
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
      // Uploads are often served from a CDN behind a redirect. Following it is fine here:
      // undici drops Authorization on a cross-origin hop, and a file needs none.
      const res = await request(url, {
        method: "GET",
        maxRedirections: 5,
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
