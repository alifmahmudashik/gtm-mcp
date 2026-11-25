/**
 * Minimal OAuth 2.1 authorization server for the Claude connector flow.
 * Claude <-> this server: DCR + auth code + PKCE. This server <-> Google: standard web OAuth.
 * Only emails in ALLOWED_EMAILS can complete sign-in.
 */
import express, { type Router } from "express";
import crypto from "node:crypto";
import { GOOGLE_SCOPES, config, db, encrypt, randomToken, sha256 } from "./config.js";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 60 * 60 * 24 * 30;

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const oauthError = (res: express.Response, status: number, error: string, desc?: string) =>
  res.status(status).json({ error, error_description: desc });

export function oauthRouter(): Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(express.json());

  // ---- Discovery ----
  const protectedResource = (_req: express.Request, res: express.Response) =>
    res.json({
      resource: `${config.baseUrl}/mcp`,
      authorization_servers: [config.baseUrl],
      bearer_methods_supported: ["header"],
    });
  r.get("/.well-known/oauth-protected-resource", protectedResource);
  r.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  r.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer: config.baseUrl,
      authorization_endpoint: `${config.baseUrl}/authorize`,
      token_endpoint: `${config.baseUrl}/token`,
      registration_endpoint: `${config.baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    })
  );

  // ---- Dynamic client registration (public clients, PKCE) ----
  r.post("/register", async (req, res) => {
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every(u => typeof u === "string")) {
      return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of strings");
    }
    const client_id = randomToken(16);
    const { error } = await db().from("mcp_clients").insert({
      client_id,
      client_name: String(req.body?.client_name ?? "MCP client").slice(0, 200),
      redirect_uris: uris,
    });
    if (error) return oauthError(res, 500, "server_error", error.message);
    res.status(201).json({
      client_id,
      client_name: req.body?.client_name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // ---- Authorize: validate, stash, bounce to Google ----
  r.get("/authorize", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const { data: client } = await db().from("mcp_clients").select("*").eq("client_id", q.client_id ?? "").maybeSingle();
    const c = client as { redirect_uris: string[] } | null;
    if (!c || !q.redirect_uri || !c.redirect_uris.includes(q.redirect_uri)) {
      return res.status(400).send("Unknown client or redirect_uri");
    }
    if (q.response_type !== "code" || !q.code_challenge || q.code_challenge_method !== "S256") {
      return res.status(400).send("Requires response_type=code with PKCE S256");
    }
    const id = randomToken(24);
    await db().from("oauth_pending").insert({
      id,
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      state: q.state ?? null,
      code_challenge: q.code_challenge,
      scope: q.scope ?? null,
      resource: q.resource ?? null,
    });
    const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    g.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: `${config.baseUrl}/api/oauth/google/callback`,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: id,
    }).toString();
    res.redirect(g.toString());
  });

  // ---- Google callback: exchange, allow-list, mint our own code ----
  r.get("/api/oauth/google/callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error || !code || !state) return res.status(400).send(`Google sign-in failed: ${error ?? "missing code"}`);

    const { data: pendingRow } = await db().from("oauth_pending").select("*").eq("id", state).maybeSingle();
    const p = pendingRow as null | { client_id: string; redirect_uri: string; state: string | null; code_challenge: string };
    if (!p) return res.status(400).send("Sign-in session expired. Start the connection again from Claude.");
    await db().from("oauth_pending").delete().eq("id", state);

    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: `${config.baseUrl}/api/oauth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const tok = (await tokRes.json()) as {
      access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string;
    };
    if (!tokRes.ok || !tok.access_token) return res.status(400).send(`Google token exchange failed: ${tok.error}`);

    const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const info = (await ui.json()) as { email?: string; email_verified?: boolean };
    const email = info.email?.toLowerCase();
    if (!email || !info.email_verified || !config.isEmailAllowed(email)) {
      return res.status(403).send("This Google account is not allowed to use this server.");
    }
    if (!tok.refresh_token) {
      return res.status(400).send("Google returned no refresh token. Remove the app at myaccount.google.com/permissions and reconnect.");
    }

    const { data: user, error: uErr } = await db().from("users").upsert({
      email,
      google_refresh_token_enc: encrypt(tok.refresh_token),
      google_access_token_enc: encrypt(tok.access_token),
      google_access_expires_at: iso((tok.expires_in ?? 3600) * 1000),
    }, { onConflict: "email" }).select("id").single();
    if (uErr || !user) return res.status(500).send(`Could not save user: ${uErr?.message}`);

    const ourCode = randomToken(32);
    await db().from("auth_codes").insert({
      code_hash: sha256(ourCode),
      user_id: (user as { id: string }).id,
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      expires_at: iso(10 * 60_000),
    });
    const back = new URL(p.redirect_uri);
    back.searchParams.set("code", ourCode);
    if (p.state) back.searchParams.set("state", p.state);
    res.redirect(back.toString());
  });

  // ---- Token endpoint ----
  async function issue(userId: string, clientId: string) {
    const access = randomToken(32);
    const refresh = randomToken(32);
    await db().from("tokens").insert([
      { token_hash: sha256(access), kind: "access", user_id: userId, client_id: clientId, expires_at: iso(ACCESS_TTL_S * 1000) },
      { token_hash: sha256(refresh), kind: "refresh", user_id: userId, client_id: clientId, expires_at: iso(REFRESH_TTL_S * 1000) },
    ]);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "mcp" };
  }

  r.post("/token", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body as Record<string, string | undefined>;
    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.code_verifier || !b.client_id) return oauthError(res, 400, "invalid_request");
      const h = sha256(b.code);
      const { data } = await db().from("auth_codes").select("*").eq("code_hash", h).maybeSingle();
      const row = data as null | { user_id: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: string };
      await db().from("auth_codes").delete().eq("code_hash", h); // single use
      if (!row || Date.parse(row.expires_at) < Date.now() || row.client_id !== b.client_id) {
        return oauthError(res, 400, "invalid_grant", "Code is invalid or expired");
      }
      if (b.redirect_uri && b.redirect_uri !== row.redirect_uri) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
      const challenge = crypto.createHash("sha256").update(b.code_verifier).digest("base64url");
      if (challenge !== row.code_challenge) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return res.json(await issue(row.user_id, row.client_id));
    }
    if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) return oauthError(res, 400, "invalid_request");
      const h = sha256(b.refresh_token);
      const { data } = await db().from("tokens").select("*").eq("token_hash", h).eq("kind", "refresh").maybeSingle();
      const row = data as null | { user_id: string; client_id: string; expires_at: string };
      if (!row || Date.parse(row.expires_at) < Date.now()) return oauthError(res, 400, "invalid_grant", "Refresh token invalid or expired");
      await db().from("tokens").delete().eq("token_hash", h); // rotate
      return res.json(await issue(row.user_id, row.client_id));
    }
    oauthError(res, 400, "unsupported_grant_type");
  });

  return r;
}

/** Resolve a bearer token to the user it was issued for. */
export async function verifyBearer(token: string): Promise<{ userId: string; clientId: string; expiresAt: number } | null> {
  const { data } = await db().from("tokens").select("*").eq("token_hash", sha256(token)).eq("kind", "access").maybeSingle();
  const row = data as null | { user_id: string; client_id: string; expires_at: string };
  if (!row || Date.parse(row.expires_at) < Date.now()) return null;
  return { userId: row.user_id, clientId: row.client_id, expiresAt: Math.floor(Date.parse(row.expires_at) / 1000) };
}
