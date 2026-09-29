import { createHash } from "node:crypto";
import { request } from "undici";
import { HttpStatusError, parseRetryAfter, withRetry, type RetryOptions } from "./retry.js";

/**
 * One field the assistant fills: where it goes and, in plain words, what to put there —
 * "a 155-character meta description", "the event date, ISO format", "pro or grand-public".
 */
export interface AiRule {
  /** Strapi field, dot paths allowed (`seo.metaDescription`). */
  target: string;
  instruction: string;
  /** Shape of the answer. `html` and `json` come back as strings and are parsed for `json`. */
  type?: "string" | "html" | "number" | "boolean" | "enum" | "json" | "string[]";
  /** Allowed values, for `enum`. */
  options?: string[];
  /** Replace what the mapping wrote. Off: only fill a field the mapping left empty. */
  overwrite?: boolean;
}

export interface AiConfig {
  provider: "gemini";
  /** Falls back to the GEMINI_API_KEY environment variable. */
  apiKey?: string;
  model: string;
  /**
   * Rules by mapping key — `post`, `page`, `route:<name>`, `custom:<restBase>` — plus `*` for
   * every post-like entry. A key's rules add to `*`'s.
   */
  rules: Record<string, AiRule[]>;
  /** Guidance for every call: language, tone, house style. */
  instructions?: string;
  /** How much of the content is sent, in characters. */
  maxContentChars?: number;
}

/** What the assistant is shown about an entry. */
export interface AiSource {
  title: string;
  slug: string;
  link?: string;
  date?: string;
  status?: string;
  excerpt?: string;
  /** Resolved HTML (page-builder fallback included). */
  content: string;
  categories?: string[];
  tags?: string[];
}

export interface AiAnswer {
  /** Filled values keyed by rule target; a rule the model answered `null` to is absent. */
  values: Record<string, unknown>;
}

export const DEFAULT_MAX_CONTENT_CHARS = 20_000;

const SYSTEM = [
  "Tu remplis des champs d'un CMS (Strapi) à partir d'une entrée d'un site WordPress.",
  "Réponds uniquement par un objet JSON conforme au schéma fourni.",
  "Base-toi exclusivement sur le contenu fourni : n'invente ni fait, ni date, ni chiffre, ni nom.",
  "Si l'information demandée est absente du contenu, omets ce champ de la réponse.",
  "Pour un champ HTML, renvoie du HTML propre (p, h2, h3, ul, ol, li, a, strong, em, img, figure, blockquote) sans style ni script.",
].join("\n");

/** The key a rule's answer travels under — field paths make awkward JSON keys. */
const keyOf = (index: number) => `field_${index}`;

function schemaFor(rule: AiRule): Record<string, unknown> {
  const description = rule.instruction;
  // Plain types only: the widest-supported subset of JSON Schema. A field the content says
  // nothing about is simply left out of the answer.
  switch (rule.type) {
    case "number":
      return { type: "number", description };
    case "boolean":
      return { type: "boolean", description };
    case "enum":
      return rule.options?.length
        ? { type: "string", enum: [...rule.options], description }
        : { type: "string", description };
    case "string[]":
      return { type: "array", items: { type: "string" }, description };
    case "json":
      return { type: "string", description: `${description} Réponds par du JSON encodé dans une chaîne.` };
    case "html":
      return { type: "string", description: `${description} (HTML)` };
    default:
      return { type: "string", description };
  }
}

/** Build the request for a set of rules — pure, so it can be tested and cached on. */
export function buildAiRequest(
  source: AiSource,
  rules: ReadonlyArray<AiRule>,
  cfg: Pick<AiConfig, "instructions" | "maxContentChars">,
): { system: string; prompt: string; schema: Record<string, unknown> } {
  const max = cfg.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const content = source.content.length > max ? `${source.content.slice(0, max)}\n[…tronqué]` : source.content;
  const lines = [
    `Titre : ${source.title}`,
    `Slug : ${source.slug}`,
    source.link ? `Adresse : ${source.link}` : "",
    source.date ? `Date de publication : ${source.date}` : "",
    source.status ? `Statut WordPress : ${source.status}` : "",
    source.categories?.length ? `Catégories : ${source.categories.join(", ")}` : "",
    source.tags?.length ? `Étiquettes : ${source.tags.join(", ")}` : "",
    source.excerpt ? `Extrait :\n${source.excerpt}` : "",
    `Contenu (HTML) :\n${content}`,
    "",
    "Champs à remplir :",
    ...rules.map((r, i) => `- ${keyOf(i)} → champ Strapi « ${r.target} » : ${r.instruction}`),
  ].filter((l) => l !== "");
  return {
    system: cfg.instructions ? `${SYSTEM}\n\nConsignes du projet :\n${cfg.instructions}` : SYSTEM,
    prompt: lines.join("\n"),
    schema: {
      type: "object",
      properties: Object.fromEntries(rules.map((r, i) => [keyOf(i), schemaFor(r)])),
    },
  };
}

/** Turn the model's JSON back into target → value, coercing to what each rule asked for. */
export function readAiAnswer(raw: unknown, rules: ReadonlyArray<AiRule>): AiAnswer {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const values: Record<string, unknown> = {};
  rules.forEach((rule, i) => {
    let v = obj[keyOf(i)];
    if (v === null || v === undefined || v === "") return;
    if (rule.type === "json" && typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        return; // a half-formed structure is worse than none
      }
    }
    if (rule.type === "number" && typeof v === "string") v = Number(v);
    if (rule.type === "number" && (typeof v !== "number" || Number.isNaN(v))) return;
    if (rule.type === "enum" && rule.options?.length && !rule.options.includes(String(v))) return;
    values[rule.target] = v;
  });
  return { values };
}

/** Same entry, same rules, same model: same answer — no second call. */
export function aiCacheKey(model: string, request: { system: string; prompt: string; schema: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([model, request.system, request.prompt, request.schema]))
    .digest("hex")
    .slice(0, 32);
}

export interface GeminiModel {
  id: string;
  displayName: string;
  description?: string;
}

/** Overridable for a corporate proxy or gateway (and for tests). */
const API = (process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");

/** The Gemini API (generateContent) with JSON output. */
export class GeminiClient {
  private readonly apiKey: string;

  constructor(
    apiKey: string | undefined,
    private readonly retry: RetryOptions = { retries: 3 },
  ) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Gemini API key missing (set it in the AI settings or GEMINI_API_KEY)");
    this.apiKey = key;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return withRetry(async () => {
      const res = await request(`${API}${path}`, {
        method,
        headers: {
          "x-goog-api-key": this.apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.body.text();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let reason = text.slice(0, 300);
        try {
          reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? reason;
        } catch {
          /* keep the raw body */
        }
        throw new HttpStatusError(
          `Gemini ${res.statusCode}: ${reason}`,
          res.statusCode,
          parseRetryAfter(res.headers["retry-after"]),
        );
      }
      return JSON.parse(text) as T;
    }, this.retry);
  }

  /** Models this key can call generateContent on. */
  async listModels(): Promise<GeminiModel[]> {
    const out: GeminiModel[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.call<{
        models?: Array<{ name: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }>;
        nextPageToken?: string;
      }>("GET", `/models?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      for (const m of page.models ?? []) {
        if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
        out.push({ id: m.name.replace(/^models\//, ""), displayName: m.displayName ?? m.name, description: m.description });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** One JSON answer shaped by `schema`. */
  async generateJson(
    model: string,
    req: { system: string; prompt: string; schema: Record<string, unknown> },
  ): Promise<unknown> {
    const res = await this.call<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    }>("POST", `/models/${encodeURIComponent(model)}:generateContent`, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseJsonSchema: req.schema,
      },
    });
    if (res.promptFeedback?.blockReason) {
      throw new Error(`Gemini refused the request (${res.promptFeedback.blockReason})`);
    }
    const candidate = res.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text) throw new Error(`Gemini returned no answer (${candidate?.finishReason ?? "empty"})`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Gemini returned invalid JSON (${candidate?.finishReason ?? "?"})`);
    }
  }
}
