/**
 * Thin fetch helpers that send the Strapi admin JWT (already stored in
 * localStorage by the admin panel) and point at the plugin's admin routes.
 */

const BASE = "/wp-import";

function authHeader(): Record<string, string> {
  try {
    const raw =
      window.sessionStorage.getItem("jwtToken") ||
      window.localStorage.getItem("jwtToken");
    if (!raw) return {};
    // Strapi stores the token JSON-stringified with quotes.
    const token = raw.replace(/^"|"$/g, "");
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function eventsUrl(): string {
  return `${BASE}/events`;
}
