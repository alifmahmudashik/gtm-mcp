/**
 * In-process self-check: connects a client to the server over an in-memory transport,
 * with global fetch stubbed (fake Supabase user row + fake GTM API) so no network or secrets are needed.
 * Run: npm run smoke
 */
import { strict as assert } from "node:assert";
import crypto from "node:crypto";

process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64");
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
process.env.GOOGLE_CLIENT_ID = "cid";
process.env.GOOGLE_CLIENT_SECRET = "sec";
process.env.BASE_URL = "https://gtm-mcp.example.com";
process.env.ALLOWED_EMAILS = "me@example.com";

const { encrypt } = await import("../src/config.js");
const { createServer } = await import("../src/app.js");
const { Client } = await import("@modelcontextprotocol/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");

const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  if (url.includes("fake.supabase.co")) {
    return json({
      id: "u1", email: "me@example.com",
      google_refresh_token_enc: encrypt("r"), google_access_token_enc: encrypt("ACCESS"),
      google_access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
  }
  if (url.startsWith("https://tagmanager.googleapis.com/")) {
    const h = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined, auth: h.get("authorization") ?? undefined });
    if (url.includes(":quick_preview")) return json({ compilerError: false });
    if (url.includes(":create_version")) return json({ containerVersion: { path: "accounts/1/containers/2/versions/9", containerVersionId: "9" } });
    if (url.includes("versions/9:publish")) return json({ containerVersion: { containerVersionId: "9", name: "v" } });
    if (url.includes("/tags") && !url.includes("tags/")) return json({ tag: [{ name: "GA4", tagId: "5", type: "gaawe", fingerprint: "f", parameter: [{ big: "x".repeat(500) }] }] });
    if (url.includes("tags/404")) return json({ error: { message: "nope" } }, 404);
    return json({ ok: true });
  }
  return realFetch(input, init);
}) as typeof fetch;

const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer("u1").connect(st);
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(ct);

const { tools } = await client.listTools();
const names = tools.map(t => t.name);
console.error(`${names.length} tools:`, names.join(", "));
for (const n of ["gtm_account", "gtm_container", "gtm_workspace", "gtm_tag", "gtm_trigger", "gtm_variable", "gtm_built_in_variable",
  "gtm_folder", "gtm_template", "gtm_client", "gtm_transformation", "gtm_zone", "gtm_gtag_config", "gtm_environment", "gtm_version",
  "gtm_version_header", "gtm_destination", "gtm_user_permission", "gtm_publish_workspace", "gtm_api_request", "gtm_auth_status"]) {
  assert.ok(names.includes(n), `missing tool ${n}`);
}

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
const last = () => calls[calls.length - 1];
const txt = (r: { content?: unknown }) => ((r.content as { text: string }[])[0]).text;

// list tags: URL, auth header, compact output strips parameter blobs
let r = await call("gtm_tag", { action: "list", account_id: "1", container_id: "2", workspace_id: "3" });
assert.ok(!r.isError, txt(r));
assert.equal(last().url, "https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags");
assert.equal(last().auth, "Bearer ACCESS");
assert.ok(!txt(r).includes("xxxx"), "compact list should drop parameter blobs");
assert.ok(txt(r).includes("GA4"));

// verbs
await call("gtm_workspace", { action: "status", account_id: "1", container_id: "2", resource_id: "3" });
assert.ok(last().url.endsWith("/accounts/1/containers/2/workspaces/3:getStatus"), last().url);
await call("gtm_tag", { action: "revert", account_id: "1", container_id: "2", workspace_id: "3", resource_id: "5" });
assert.ok(last().url.endsWith("/workspaces/3/tags/5:revert") && last().method === "POST", last().url);
await call("gtm_version", { action: "live", account_id: "1", container_id: "2" });
assert.ok(last().url.endsWith("/containers/2/versions:live"), last().url);
await call("gtm_version_header", { action: "latest", account_id: "1", container_id: "2" });
assert.ok(last().url.endsWith("/containers/2/version_headers:latest"), last().url);
await call("gtm_container", { action: "lookup", account_id: "1", query: { destinationId: "GTM-ABC" } });
assert.ok(last().url.endsWith("/accounts/1/containers:lookup?destinationId=GTM-ABC"), last().url);
await call("gtm_built_in_variable", { action: "create", account_id: "1", container_id: "2", workspace_id: "3", query: { type: ["pageUrl", "clickText"] } });
assert.ok(last().url.endsWith("/built_in_variables?type=pageUrl&type=clickText") && last().method === "POST", last().url);
await call("gtm_account", { action: "list" });
assert.ok(last().url.endsWith("/tagmanager/v2/accounts"), last().url);

// create / update bodies
await call("gtm_tag", { action: "create", account_id: "1", container_id: "2", workspace_id: "3", body: { name: "t", type: "html" } });
assert.equal(last().body, JSON.stringify({ name: "t", type: "html" }));
await call("gtm_tag", { action: "update", account_id: "1", container_id: "2", workspace_id: "3", resource_id: "5", body: { name: "t2" }, query: { fingerprint: "f" } });
assert.ok(last().method === "PUT" && last().url.endsWith("tags/5?fingerprint=f"), last().url);

// error paths
r = await call("gtm_tag", { action: "create", account_id: "1", container_id: "2", workspace_id: "3" });
assert.equal(r.isError, true, "create without body must error");
r = await call("gtm_tag", { action: "get", account_id: "1", container_id: "2" , resource_id: "5" });
assert.equal(r.isError, true, "missing workspace_id must error");
assert.ok(/workspace_id is required/.test(txt(r)), txt(r));
r = await call("gtm_tag", { action: "get", account_id: "1", container_id: "2", workspace_id: "3", resource_id: "404" });
assert.equal(r.isError, true);
assert.ok(/Not found \(404\)/.test(txt(r)), txt(r));

// raw passthrough rejects absolute URLs
r = await call("gtm_api_request", { method: "GET", path: "https://evil.example/x" });
assert.equal(r.isError, true, "absolute URL must be rejected");

// publish workflow
r = await call("gtm_publish_workspace", { account_id: "1", container_id: "2", workspace_id: "3", name: "n", notes: "x" });
assert.ok(!r.isError, txt(r));
assert.ok(calls.some(c => c.url.endsWith("versions/9:publish")), "publish call missing");

await client.close();
console.error("Smoke test passed");
