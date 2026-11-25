import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  get baseUrl() { return need("BASE_URL").replace(/\/$/, ""); }, // e.g. https://gtm-mcp.alifmahmud.com
  get googleClientId() { return need("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return need("GOOGLE_CLIENT_SECRET"); },
  /** ALLOWED_EMAILS: comma-separated list, or "*" to allow any Google account. */
  get allowedEmails() {
    return need("ALLOWED_EMAILS").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  },
  isEmailAllowed(email: string) {
    const list = this.allowedEmails;
    return list.includes("*") || list.includes(email.toLowerCase());
  },
};

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
  "https://www.googleapis.com/auth/tagmanager.delete.containers",
  "https://www.googleapis.com/auth/tagmanager.publish",
  "https://www.googleapis.com/auth/tagmanager.manage.accounts",
  "https://www.googleapis.com/auth/tagmanager.manage.users",
  "https://www.googleapis.com/auth/tagmanager.readonly",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: ReturnType<typeof createClient<any>> | undefined;
export function db() {
  _db ??= createClient<any>(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  return _db;
}

// ---- small crypto helpers ----
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// AES-256-GCM for Google tokens at rest. TOKEN_ENC_KEY = 32 bytes, base64 (openssl rand -base64 32)
function key(): Buffer {
  const k = Buffer.from(need("TOKEN_ENC_KEY"), "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
  return k;
}
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(blob: string): string {
  const b = Buffer.from(blob, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
