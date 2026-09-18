import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ url: string; method: string; body?: unknown }> = [];

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    request: vi.fn(async (url: string | URL, opts: { method: string; body?: string }) => {
      calls.push({
        url: String(url),
        method: opts.method,
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });
      return {
        statusCode: 200,
        headers: {},
        body: {
          json: async () => ({ data: { id: 1, documentId: "doc-1" } }),
          text: async () => "",
        },
      };
    }),
  };
});

const { StrapiClient } = await import("./strapi-client.js");

describe("StrapiClient publication", () => {
  const client = new StrapiClient({ baseUrl: "https://cms.test", token: "t" });

  beforeEach(() => {
    calls.length = 0;
  });

  it("asks Strapi to publish through the status query, not a payload field", async () => {
    await client.create("api::post.post", { title: "x" }, undefined, { status: "published" });
    expect(calls[0]?.url).toBe("https://cms.test/api/posts?status=published");
    expect(calls[0]?.body).toEqual({ data: { title: "x" } });
  });

  it("creates drafts explicitly", async () => {
    await client.create("api::post.post", { title: "x" }, undefined, { status: "draft" });
    expect(calls[0]?.url).toContain("?status=draft");
  });

  it("leaves the status out when the caller does not care", async () => {
    await client.create("api::post.post", { title: "x" });
    expect(calls[0]?.url).toBe("https://cms.test/api/posts");
  });

  it("carries the status on updates too", async () => {
    await client.update("api::post.post", "doc-9", { title: "x" }, undefined, {
      status: "published",
    });
    expect(calls[0]?.url).toBe("https://cms.test/api/posts/doc-9?status=published");
    expect(calls[0]?.method).toBe("PUT");
  });

  it("publishes an existing document without touching its fields", async () => {
    await client.publish("api::post.post", "doc-9");
    expect(calls[0]?.url).toBe("https://cms.test/api/posts/doc-9?status=published");
    expect(calls[0]?.body).toEqual({ data: {} });
  });
});
