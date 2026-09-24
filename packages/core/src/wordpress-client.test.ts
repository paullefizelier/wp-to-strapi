import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every request the client makes, with whether it carried the credentials. */
const calls: Array<{ url: string; auth: boolean }> = [];
/** Scripted answers: return a redirect for a URL, or fall through to a 200. */
let redirects: Record<string, string> = {};

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    request: vi.fn(async (url: string | URL, opts: { headers?: Record<string, string> }) => {
      const href = String(url);
      calls.push({ url: href, auth: Boolean(opts.headers?.Authorization) });
      const target = Object.entries(redirects).find(([from]) => href.startsWith(from));
      if (target) {
        return {
          statusCode: 301,
          headers: { location: href.replace(target[0], target[1]) },
          body: { dump: async () => {}, text: async () => "", json: async () => ({}) },
        };
      }
      return {
        statusCode: 200,
        headers: { "x-wp-total": "7", "x-wp-totalpages": "1" },
        body: { json: async () => [], text: async () => "[]", dump: async () => {} },
      };
    }),
  };
});

const { WordPressClient, isCanonicalRedirect } = await import("./wordpress-client.js");

const withAuth = (baseUrl: string) =>
  new WordPressClient({ baseUrl, username: "admin", appPassword: "secret", retries: 0 });

beforeEach(() => {
  calls.length = 0;
  redirects = {};
});

describe("WordPress redirects", () => {
  it("moves to the canonical address when the site redirects http → https", async () => {
    redirects = { "http://blog.test/": "https://blog.test/" };
    const wp = withAuth("http://blog.test");
    const counts = await wp.probe();
    expect(counts.posts).toBe(7);
    expect(wp.resolvedBaseUrl).toBe("https://blog.test");
    expect(wp.redirected).toBe(true);
  });

  it("keeps the credentials on the canonical address — undici would have dropped them", async () => {
    redirects = { "https://blog.test/": "https://www.blog.test/" };
    const wp = withAuth("https://blog.test");
    await wp.describeSource("posts");
    const onCanonical = calls.filter((c) => c.url.startsWith("https://www.blog.test/"));
    expect(onCanonical.length).toBeGreaterThan(0);
    expect(onCanonical.every((c) => c.auth)).toBe(true);
  });

  it("sends later requests straight to the canonical address", async () => {
    redirects = { "http://blog.test/": "https://blog.test/" };
    const wp = withAuth("http://blog.test");
    await wp.probe();
    calls.length = 0;
    await wp.count("posts");
    expect(calls.map((c) => c.url.startsWith("https://blog.test/"))).toEqual([true]);
  });

  it("copes with parallel requests that were in flight when the first one moved", async () => {
    // probe() fires posts, pages and media at once: all three come back with a 301.
    redirects = { "http://blog.test/": "https://blog.test/" };
    const wp = withAuth("http://blog.test");
    await expect(wp.probe()).resolves.toMatchObject({ posts: 7, pages: 7, media: 7 });
  });

  it("refuses to follow the credentials to another site", async () => {
    redirects = { "https://blog.test/": "https://attacker.test/" };
    const wp = withAuth("https://blog.test");
    await expect(wp.probe()).rejects.toThrow(/another site \(https:\/\/attacker\.test\)/);
    expect(calls.some((c) => c.url.startsWith("https://attacker.test"))).toBe(false);
  });

  it("refuses a downgrade to http, which would send the password in clear", async () => {
    redirects = { "https://blog.test/": "http://blog.test/" };
    const wp = withAuth("https://blog.test");
    await expect(wp.probe()).rejects.toThrow(/from https to http/);
    expect(calls.some((c) => c.url.startsWith("http://blog.test"))).toBe(false);
  });

  it("names a redirect loop instead of retrying forever", async () => {
    redirects = {
      "https://blog.test/": "https://www.blog.test/",
      "https://www.blog.test/": "https://blog.test/",
    };
    const wp = withAuth("https://blog.test");
    await expect(wp.count("posts").then(() => wp.describeSource("posts"))).rejects.toThrow(
      /redirect loop/,
    );
    expect(calls.length).toBeLessThan(10);
  });

  it("says so when the REST API is redirected outside /wp-json/", async () => {
    redirects = { "https://blog.test/wp-json/": "https://blog.test/login?wp-json/" };
    const wp = withAuth("https://blog.test");
    await expect(wp.probe()).rejects.toThrow(/outside \/wp-json\/.*disabled/s);
  });
});

describe("isCanonicalRedirect", () => {
  const u = (s: string) => new URL(s);
  it.each([
    ["http://a.test/x", "https://a.test/x", true],
    ["https://a.test/x", "https://www.a.test/x", true],
    ["https://www.a.test/x", "https://a.test/x", true],
    ["https://a.test/x", "http://a.test/x", false],
    ["https://a.test/x", "https://b.test/x", false],
    ["https://a.test/x", "https://a.test.evil/x", false],
  ])("%s → %s is %s", (from, to, expected) => {
    expect(isCanonicalRedirect(u(from), u(to))).toBe(expected);
  });
});

describe("Redirect chains", () => {
  it("follows the two-hop chain real sites use: http://www → https://www → https://", async () => {
    redirects = {
      "http://www.blog.test/": "https://www.blog.test/",
      "https://www.blog.test/": "https://blog.test/",
    };
    const wp = withAuth("http://www.blog.test");
    await expect(wp.probe()).resolves.toMatchObject({ posts: 7 });
    expect(wp.resolvedBaseUrl).toBe("https://blog.test");
  });

  it("keeps the credentials all along the chain", async () => {
    redirects = {
      "http://www.blog.test/": "https://www.blog.test/",
      "https://www.blog.test/": "https://blog.test/",
    };
    const wp = withAuth("http://www.blog.test");
    await wp.describeSource("posts");
    const final = calls.filter((c) => c.url.startsWith("https://blog.test/"));
    expect(final.length).toBeGreaterThan(0);
    expect(final.every((c) => c.auth)).toBe(true);
  });

  it("cannot drift to another site one plausible hop at a time", async () => {
    // www.blog.test → blog.test is canonical, but blog.test → blog.test.evil is not,
    // even though each hop only looks like a small change.
    redirects = {
      "https://www.blog.test/": "https://blog.test/",
      "https://blog.test/": "https://blog.test.evil/",
    };
    const wp = withAuth("https://www.blog.test");
    await expect(wp.probe()).rejects.toThrow(/another site/);
    expect(calls.some((c) => c.url.includes("blog.test.evil"))).toBe(false);
  });
});

describe("Narrowed listings", () => {
  async function drain(gen: AsyncGenerator<unknown>) {
    for await (const _ of gen) {
      /* consume */
    }
  }

  it("asks for nothing when the selection is empty — never `include=` or `-1`", async () => {
    const wp = withAuth("https://blog.test");
    await drain(wp.posts(["publish"], []));
    expect(calls).toHaveLength(0);
  });

  it("splits a long selection into batches WordPress accepts", async () => {
    const wp = withAuth("https://blog.test");
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    await drain(wp.posts(["publish"], ids));
    const includes = calls.map((c) => new URL(c.url).searchParams.get("include")?.split(",").length);
    expect(includes).toEqual([100, 100, 50]);
  });

  it("trims entries to the requested fields", async () => {
    const wp = withAuth("https://blog.test");
    await drain(wp.pages(["publish"], undefined, ["id", "title"]));
    expect(new URL(calls[0]!.url).searchParams.get("_fields")).toBe("id,title");
  });
});
