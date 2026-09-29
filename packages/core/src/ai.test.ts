import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    request: vi.fn(async (url: string, opts: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
      return { statusCode: reply.status, headers: {}, body: { text: async () => JSON.stringify(reply.body) } };
    }),
  };
});

const { GeminiClient, buildAiRequest, readAiAnswer } = await import("./ai.js");

beforeEach(() => {
  calls.length = 0;
});

const source = { title: "Actual ouvre à Nantes", slug: "nantes", content: "<p>Le 12 mars 2024, Actual ouvre une agence.</p>" };

describe("buildAiRequest", () => {
  it("names each field, carries the instruction, and constrains enums", () => {
    const req = buildAiRequest(
      source,
      [
        { target: "seo.metaDescription", instruction: "155 caractères max" },
        { target: "audience", instruction: "Public visé", type: "enum", options: ["pro", "grand-public"] },
      ],
      { instructions: "Écris en français." },
    );
    expect(req.schema).toEqual({
      type: "object",
      properties: {
        field_0: { type: "string", description: "155 caractères max" },
        field_1: { type: "string", enum: ["pro", "grand-public"], description: "Public visé" },
      },
    });
    expect(req.prompt).toContain("field_0 → champ Strapi « seo.metaDescription » : 155 caractères max");
    expect(req.system).toContain("Écris en français.");
  });

  it("truncates long content", () => {
    const req = buildAiRequest({ ...source, content: "x".repeat(50) }, [{ target: "a", instruction: "b" }], { maxContentChars: 10 });
    expect(req.prompt).toContain(`${"x".repeat(10)}\n[…tronqué]`);
  });
});

describe("readAiAnswer", () => {
  it("maps answers back to targets and drops what does not fit", () => {
    const rules = [
      { target: "a", instruction: "" },
      { target: "b", instruction: "", type: "enum" as const, options: ["pro"] },
      { target: "c", instruction: "", type: "json" as const },
      { target: "d", instruction: "", type: "number" as const },
      { target: "e", instruction: "" },
    ];
    const { values } = readAiAnswer(
      { field_0: "ok", field_1: "hors-liste", field_2: '[{"x":1}]', field_3: "12", field_4: "" },
      rules,
    );
    expect(values).toEqual({ a: "ok", c: [{ x: 1 }], d: 12 });
  });
});

describe("GeminiClient", () => {
  it("calls generateContent with the key in a header and a JSON schema", async () => {
    reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: '{"field_0":"Bonjour"}' }] } }] } };
    const client = new GeminiClient("secret", { retries: 0 });
    const out = await client.generateJson("gemini-test", { system: "S", prompt: "P", schema: { type: "object" } });
    expect(out).toEqual({ field_0: "Bonjour" });
    const call = calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(call.headers["x-goog-api-key"]).toBe("secret");
    expect(call.url).not.toContain("secret");
    expect(call.body).toMatchObject({
      systemInstruction: { parts: [{ text: "S" }] },
      contents: [{ role: "user", parts: [{ text: "P" }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
    });
  });

  it("surfaces Google's error message", async () => {
    reply = { status: 400, body: { error: { message: "API key not valid" } } };
    const client = new GeminiClient("bad", { retries: 0 });
    await expect(client.generateJson("m", { system: "", prompt: "", schema: {} })).rejects.toThrow(
      "Gemini 400: API key not valid",
    );
  });

  it("lists only models that can generate content", async () => {
    reply = {
      status: 200,
      body: {
        models: [
          { name: "models/gemini-a", displayName: "A", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed", displayName: "E", supportedGenerationMethods: ["embedContent"] },
        ],
      },
    };
    const models = await new GeminiClient("k", { retries: 0 }).listModels();
    expect(models.map((m) => m.id)).toEqual(["gemini-a"]);
  });

  it("refuses to start without a key", () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(() => new GeminiClient(undefined)).toThrow(/API key missing/);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});
