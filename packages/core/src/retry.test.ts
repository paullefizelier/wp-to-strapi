import { describe, expect, it, vi } from "vitest";
import { HttpStatusError, parseRetryAfter, withRetry } from "./retry.js";

const noSleep = { sleep: async () => {} };

describe("withRetry", () => {
  it("returns the first success without waiting", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { retries: 3, ...noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient statuses and gives back the eventual success", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 3) throw new HttpStatusError("boom", 503);
      return "ok";
    };
    expect(await withRetry(fn, { retries: 3, ...noSleep })).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry what the server answered deliberately", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new HttpStatusError("unauthorized", 401);
    };
    await expect(withRetry(fn, { retries: 5, ...noSleep })).rejects.toThrow("unauthorized");
    expect(calls).toBe(1);
  });

  it("retries dropped sockets", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return "ok";
    };
    expect(await withRetry(fn, { retries: 2, ...noSleep })).toBe("ok");
  });

  it("gives up after the configured number of attempts", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new HttpStatusError("still down", 502);
    };
    await expect(withRetry(fn, { retries: 2, ...noSleep })).rejects.toThrow("still down");
    expect(calls).toBe(3); // the first try plus two retries
  });

  it("honours Retry-After instead of its own backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new HttpStatusError("slow down", 429, 1500);
      return "ok";
    };
    await withRetry(fn, { retries: 2, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1500]);
  });

  it("backs off exponentially and reports each retry", async () => {
    const seen: Array<{ attempt: number; reason: string }> = [];
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 4) throw new HttpStatusError("nope", 500);
      return "ok";
    };
    const waits: number[] = [];
    await withRetry(fn, {
      retries: 3,
      baseDelayMs: 100,
      sleep: async (ms) => void waits.push(ms),
      onRetry: (attempt, _ms, reason) => seen.push({ attempt, reason }),
    });
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(seen[0]?.reason).toBe("HTTP 500");
    expect(waits[0]).toBeLessThan(waits[1]!);
    expect(waits[1]).toBeLessThan(waits[2]!);
  });
});

describe("parseRetryAfter", () => {
  it("reads a delay in seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
  });
  it("reads an HTTP date", () => {
    const soon = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(soon)).toBeGreaterThan(3000);
  });
  it("ignores nonsense", () => {
    expect(parseRetryAfter("later")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
