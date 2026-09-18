/** Status codes worth trying again: rate limiting and transient server/proxy failures. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Undici/Node network failures that are not the server saying "no". */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface RetryOptions {
  /** Extra attempts after the first. 0 disables retrying. */
  retries: number;
  /** Base delay in ms; doubles each attempt. */
  baseDelayMs?: number;
  /** Called before each wait, for logging. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/** `Retry-After` is either a delay in seconds or an HTTP date. */
export function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function describe(err: unknown): { retryable: boolean; reason: string; waitMs?: number } {
  if (err instanceof HttpStatusError) {
    return {
      retryable: RETRYABLE_STATUS.has(err.status),
      reason: `HTTP ${err.status}`,
      waitMs: err.retryAfterMs,
    };
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code && RETRYABLE_CODES.has(code)) return { retryable: true, reason: code };
  const cause = (err as { cause?: NodeJS.ErrnoException })?.cause?.code;
  if (cause && RETRYABLE_CODES.has(cause)) return { retryable: true, reason: cause };
  return { retryable: false, reason: (err as Error)?.message ?? "unknown error" };
}

/**
 * Retry a request with exponential backoff.
 *
 * A migration is thousands of requests long: one rate-limited response or one dropped socket
 * should not end it. Anything the server answers deliberately — 401, 404, a validation error —
 * is not retried, because repeating it would only be slower.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  const wait = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const { retryable, reason, waitMs } = describe(err);
      if (!retryable || attempt >= opts.retries) throw err;
      attempt += 1;
      // Jitter keeps parallel workers from retrying in lockstep.
      const backoff = waitMs ?? base * 2 ** (attempt - 1) * (1 + Math.random() * 0.2);
      opts.onRetry?.(attempt, Math.round(backoff), reason);
      await wait(Math.round(backoff));
    }
  }
}
