import { config, db, decrypt, encrypt } from "./config.js";

export const GTM_BASE = "https://tagmanager.googleapis.com/tagmanager/v2";

export class GtmApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function hint(status: number, detail: string): string {
  switch (status) {
    case 400: return `GTM rejected the request (400): ${detail}. Check ids and the body shape (GTM API v2 resource representation).`;
    case 401: return "Google rejected the stored credentials. Reconnect the connector in Claude to re-authorize.";
    case 403: return `Permission denied (403): ${detail}. The Google account may lack access to this account/container, or the Tag Manager API is not enabled in the Google Cloud project.`;
    case 404: return `Not found (404): ${detail}. List the parent collection to get valid ids.`;
    case 409: return `Conflict (409): ${detail}. The fingerprint is stale: re-get the entity and retry with the new fingerprint, or sync the workspace.`;
    case 429: return "GTM API quota exceeded (429). Wait a minute and retry.";
    default: return `GTM API error ${status}: ${detail}`;
  }
}

/** Returns a valid Google access token for the user, refreshing (and persisting) when needed. */
export async function googleAccessToken(userId: string): Promise<string> {
  const { data, error } = await db().from("users").select("*").eq("id", userId).single();
  if (error || !data) throw new GtmApiError(401, "User not found. Reconnect the connector in Claude.");
  const row = data as Record<string, string | null>;
  const exp = row.google_access_expires_at ? Date.parse(row.google_access_expires_at) : 0;
  if (row.google_access_token_enc && exp - Date.now() > 60_000) return decrypt(row.google_access_token_enc);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: decrypt(row.google_refresh_token_enc as string),
      grant_type: "refresh_token",
    }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) {
    throw new GtmApiError(401, `Google token refresh failed (${j.error ?? res.status}). Reconnect the connector in Claude.`);
  }
  await db().from("users").update({
    google_access_token_enc: encrypt(j.access_token),
    google_access_expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
  }).eq("id", userId);
  return j.access_token;
}

export type Query = Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;

export async function gtmRequest(
  userId: string,
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown; signal?: AbortSignal } = {}
): Promise<unknown> {
  const token = await googleAccessToken(userId);
  const url = new URL(`${GTM_BASE}/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  const timeout = AbortSignal.timeout(45_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new GtmApiError(504, "GTM API did not respond within 45 seconds. Retry, or narrow the request.");
    }
    throw e;
  }
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = (json as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 300);
    throw new GtmApiError(res.status, hint(res.status, detail));
  }
  return json ?? { ok: true };
}
