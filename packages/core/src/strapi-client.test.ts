import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ url: string; method: string; body?: unknown }> = [];

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    request: vi.fn(async (url: string | URL, opts: { method: string; body?: unknown }) => {
      calls.push({
        url: String(url),
        method: opts.method,
        // Uploads send FormData, not JSON.
        body: typeof opts.body === "string" ? JSON.parse(opts.body) : undefined,
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

describe("StrapiClient base URL", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("does not double the slash when the base URL ends with one", async () => {
    // `https://cms.test//api/posts` never matches an API route: Strapi falls through to the
    // static-file middleware, which rejects the absolute path with 400 "Malicious Path".
    const client = new StrapiClient({ baseUrl: "https://cms.test/", token: "t" });
    await client.probe("api::post.post");
    expect(calls[0]?.url).not.toContain("//api/");
    expect(calls[0]?.url).toContain("https://cms.test/api/posts");
  });

  it("keeps a stray slash or space in a UID out of the path", async () => {
    const client = new StrapiClient({ baseUrl: "https://cms.test", token: "t" });
    await client.probe(" api::post.post ");
    expect(calls[0]?.url).toContain("https://cms.test/api/posts?");
    await client.probe("api::post.post", "/articles/");
    expect(calls[1]?.url).toContain("https://cms.test/api/articles?");
  });

  it("normalises the media upload URL too", async () => {
    const client = new StrapiClient({ baseUrl: "https://cms.test/", token: "t" });
    await client
      .uploadFile({ buffer: Buffer.from("x"), fileName: "a.jpg", contentType: "image/jpeg" })
      .catch(() => undefined); // the stub answers with an entry shape, not an upload array
    expect(calls[0]?.url).toBe("https://cms.test/api/upload");
  });

  it("tolerates several trailing slashes and surrounding spaces", async () => {
    const client = new StrapiClient({ baseUrl: "  https://cms.test///  ", token: "t" });
    await client.create("api::post.post", { title: "x" });
    expect(calls[0]?.url).toBe("https://cms.test/api/posts");
  });
});

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

  it("looks entries up with v5 syntax — publicationState is rejected by v5", async () => {
    await client.findOneBy("api::post.post", "wpId", 42);
    expect(calls[0]?.url).toContain("filters[wpId][$eq]=42");
    expect(calls[0]?.url).toContain("status=draft");
    expect(calls[0]?.url).not.toContain("publicationState");
  });

  it("reads the content types from the Content-Type Builder content-API routes", async () => {
    await client.listContentTypes().catch(() => []);
    expect(calls[0]?.url).toBe("https://cms.test/api/content-type-builder/content-types");
  });

  it("publishes an existing document without touching its fields", async () => {
    await client.publish("api::post.post", "doc-9");
    expect(calls[0]?.url).toBe("https://cms.test/api/posts/doc-9?status=published");
    expect(calls[0]?.body).toEqual({ data: {} });
  });
});

describe("multipart upload body", () => {
  it("is a form Strapi (or any parser) reads back: file bytes, name, type and fileInfo", async () => {
    const { multipart } = await import("./strapi-client.js");
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a, 0x2d, 0x2d]);
    const { body, contentType } = multipart([
      { name: "files", fileName: 'photo "été".jpg', contentType: "image/jpeg", data: bytes },
      { name: "fileInfo", data: Buffer.from(JSON.stringify({ alternativeText: "Légende" })) },
    ]);
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    const file = form.get("files") as File;
    // Quotes travel percent-encoded, as browsers send them; the parser gives the name back.
    expect(file.name).toBe('photo "été".jpg');
    expect(file.type).toBe("image/jpeg");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    expect(JSON.parse(form.get("fileInfo") as string)).toEqual({ alternativeText: "Légende" });
  });

  it("sends a plain Buffer with its multipart content-type", async () => {
    calls.length = 0;
    const seen: Array<{ headers?: Record<string, string>; body?: unknown }> = [];
    const undici = await import("undici");
    (undici.request as unknown as { mockImplementationOnce: (f: unknown) => void }).mockImplementationOnce(
      async (_url: string, opts: { headers?: Record<string, string>; body?: unknown }) => {
        seen.push(opts);
        return { statusCode: 201, headers: {}, body: { json: async () => [{ id: 7, url: "/u/a.jpg" }], text: async () => "" } };
      },
    );
    const client = new StrapiClient({ baseUrl: "https://cms.test", token: "t" });
    const up = await client.uploadFile({ buffer: Buffer.from("x"), fileName: "a.jpg", contentType: "image/jpeg" });
    expect(up.id).toBe(7);
    expect(Buffer.isBuffer(seen[0]?.body)).toBe(true);
    expect(seen[0]?.headers?.["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]?.headers?.["content-length"]).toBe(String((seen[0]?.body as Buffer).length));
  });
});
