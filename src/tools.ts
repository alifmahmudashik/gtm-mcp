import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { gtmRequest, googleAccessToken, type Query } from "./google.js";

const CHARACTER_LIMIT = 25_000;

type Scope = "root" | "account" | "container" | "workspace";
interface Verb { method: "GET" | "POST" | "PUT" | "DELETE"; id: boolean; verb?: string; body?: boolean; readOnly?: boolean; destructive?: boolean; note?: string }

const crud = (extra: Record<string, Verb> = {}, opts: { revert?: boolean } = {}): Record<string, Verb> => ({
  list: { method: "GET", id: false, readOnly: true },
  get: { method: "GET", id: true, readOnly: true },
  create: { method: "POST", id: false, body: true },
  update: { method: "PUT", id: true, body: true, note: "Send the full entity plus query.fingerprint from a fresh get." },
  delete: { method: "DELETE", id: true, destructive: true },
  ...(opts.revert ? { revert: { method: "POST", id: true, verb: "revert", note: "Undo workspace changes to this entity." } as Verb } : {}),
  ...extra,
});

interface Resource {
  tool: string;
  title: string;
  scope: Scope;            // which ids the parent path needs
  segment: string;         // collection path segment
  actions: Record<string, Verb>;
  about: string;
}

const RESOURCES: Resource[] = [
  { tool: "gtm_account", title: "GTM Accounts", scope: "root", segment: "accounts",
    actions: { list: crud().list, get: crud().get, update: crud().update },
    about: "GTM accounts the signed-in Google user can access." },
  { tool: "gtm_container", title: "GTM Containers", scope: "account", segment: "containers",
    actions: crud({
      lookup: { method: "GET", id: false, verb: "lookup", readOnly: true, note: "query.destinationId = GTM-XXXX / G-XXXX / AW-XXXX, to find a container by public id." },
      snippet: { method: "GET", id: true, verb: "snippet", readOnly: true, note: "Install snippet for a web container." },
      move_tag_id: { method: "POST", id: true, verb: "move_tag_id", note: "query: tagId, copySettings, copyTermsOfService, copyUsers, allowUserPermissionFeatureUpdate" },
      combine: { method: "POST", id: true, verb: "combine", note: "query: containerId (source), settingSource, allowUserPermissionFeatureUpdate" },
    }),
    about: "Web, server, iOS, Android, AMP containers. create body: {name, usageContext:['web'|'server'|...], domainName?, notes?}." },
  { tool: "gtm_workspace", title: "GTM Workspaces", scope: "container", segment: "workspaces",
    actions: crud({
      status: { method: "GET", id: true, verb: "getStatus", readOnly: true, note: "Pending changes and merge conflicts." },
      sync: { method: "POST", id: true, verb: "sync", note: "Pull latest live changes into the workspace." },
      quick_preview: { method: "POST", id: true, verb: "quick_preview", note: "Compile the workspace and return errors." },
      create_version: { method: "POST", id: true, verb: "create_version", body: true, note: "body: {name, notes}. Prefer gtm_publish_workspace to also publish." },
      resolve_conflict: { method: "POST", id: true, verb: "resolve_conflict", body: true, note: "body: {changeStatus, entity...}" },
    }),
    about: "Workspaces hold unpublished changes. Most edits happen here." },
  { tool: "gtm_tag", title: "GTM Tags", scope: "workspace", segment: "tags", actions: crud({}, { revert: true }),
    about: "Tags. create body example: {name, type:'html'|'gaawe'|'googtag'|..., parameter:[{type:'template',key:'html',value:'...'}], firingTriggerId:['2147479553'], blockingTriggerId?:[], tagFiringOption?:'oncePerEvent'}." },
  { tool: "gtm_trigger", title: "GTM Triggers", scope: "workspace", segment: "triggers", actions: crud({}, { revert: true }),
    about: "Triggers. create body example: {name, type:'customEvent', customEventFilter:[{type:'equals', parameter:[{type:'template',key:'arg0',value:'{{_event}}'},{type:'template',key:'arg1',value:'purchase'}]}]}." },
  { tool: "gtm_variable", title: "GTM Variables", scope: "workspace", segment: "variables", actions: crud({}, { revert: true }),
    about: "User-defined variables. create body example: {name, type:'v', parameter:[{type:'integer',key:'dataLayerVersion',value:'2'},{type:'template',key:'name',value:'ecommerce.value'}]}." },
  { tool: "gtm_built_in_variable", title: "GTM Built-in Variables", scope: "workspace", segment: "built_in_variables",
    actions: {
      list: { method: "GET", id: false, readOnly: true },
      create: { method: "POST", id: false, note: "Enable built-ins: query.type = array of types e.g. ['pageUrl','clickText']." },
      delete: { method: "DELETE", id: false, destructive: true, note: "Disable built-ins: query.type = array of types." },
      revert: { method: "POST", id: false, verb: "revert", note: "query.type = a single built-in type." },
    },
    about: "Enable/disable built-in variables (Page URL, Click Text, ...). Uses query.type, never resource_id." },
  { tool: "gtm_folder", title: "GTM Folders", scope: "workspace", segment: "folders",
    actions: crud({
      entities: { method: "POST", id: true, verb: "entities", readOnly: true, note: "List tags/triggers/variables in a folder (API uses POST)." },
      move_entities: { method: "POST", id: true, verb: "move_entities_to_folder", body: true, note: "body: {tag:[...], trigger:[...], variable:[...]} full entities; query: tagId[], triggerId[], variableId[]." },
    }, { revert: true }),
    about: "Folders for organising tags, triggers and variables." },
  { tool: "gtm_template", title: "GTM Custom Templates", scope: "workspace", segment: "templates", actions: crud({}, { revert: true }),
    about: "Custom templates (tag/variable/client templates). create body: {name, templateData:'<.tpl export text>'}." },
  { tool: "gtm_client", title: "GTM Server Clients", scope: "workspace", segment: "clients", actions: crud({}, { revert: true }),
    about: "Clients in a server-side (sGTM) container, e.g. GA4 client." },
  { tool: "gtm_transformation", title: "GTM Server Transformations", scope: "workspace", segment: "transformations", actions: crud({}, { revert: true }),
    about: "Transformations in a server-side container (augment/exclude/allow event data)." },
  { tool: "gtm_zone", title: "GTM Zones", scope: "workspace", segment: "zones", actions: crud({}, { revert: true }),
    about: "Zones (container sub-regions with their own boundaries/type restrictions)." },
  { tool: "gtm_gtag_config", title: "GTM Google Tag Configs", scope: "workspace", segment: "gtag_config", actions: crud(),
    about: "Google tag configuration (legacy gtag config entities)." },
  { tool: "gtm_environment", title: "GTM Environments", scope: "container", segment: "environments",
    actions: crud({ reauthorize: { method: "POST", id: true, verb: "reauthorize", body: true, note: "Regenerates the environment's authorization code." } }),
    about: "Preview/live/latest/custom environments." },
  { tool: "gtm_version", title: "GTM Container Versions", scope: "container", segment: "versions",
    actions: {
      get: { method: "GET", id: true, readOnly: true },
      update: crud().update,
      delete: crud().delete,
      undelete: { method: "POST", id: true, verb: "undelete" },
      publish: { method: "POST", id: true, verb: "publish", note: "Makes this version live. query.fingerprint optional." },
      set_latest: { method: "POST", id: true, verb: "set_latest" },
      live: { method: "GET", id: false, verb: "live", readOnly: true, note: "Currently published version." },
      latest: { method: "GET", id: false, verb: "latest", readOnly: true, note: "Latest (unpublished) version." },
    },
    about: "Container versions. To make one: gtm_workspace create_version, then publish here (or use gtm_publish_workspace)." },
  { tool: "gtm_version_header", title: "GTM Version Headers", scope: "container", segment: "version_headers",
    actions: {
      list: { method: "GET", id: false, readOnly: true, note: "query.includeDeleted optional." },
      latest: { method: "GET", id: false, verb: "latest", readOnly: true },
    },
    about: "Lightweight version list (id, name, counts) without bodies. Use this before gtm_version get." },
  { tool: "gtm_destination", title: "GTM Destinations", scope: "container", segment: "destinations",
    actions: {
      list: crud().list,
      get: crud().get,
      link: { method: "POST", id: false, verb: "link", note: "query: destinationId (public id e.g. G-XXXX), allowUserPermissionFeatureUpdate." },
    },
    about: "Destinations (GA4 / Ads / etc.) linked to a container." },
  { tool: "gtm_user_permission", title: "GTM User Permissions", scope: "account", segment: "user_permissions", actions: crud(),
    about: "Account/container access for users. Changes access for real people: double-check emailAddress and permission levels." },
];

const ALL_ACTIONS = [...new Set(RESOURCES.flatMap(r => Object.keys(r.actions)))] as [string, ...string[]];

function buildPath(r: Resource, v: Verb, a: { account_id?: string; container_id?: string; workspace_id?: string; resource_id?: string }): string {
  const need = (name: string, val?: string) => {
    if (!val) throw new Error(`${name} is required for ${r.tool}. List the parent collection first to find it.`);
    return encodeURIComponent(val);
  };
  const parts: string[] = [];
  if (r.scope !== "root") parts.push("accounts", need("account_id", a.account_id));
  if (r.scope === "container" || r.scope === "workspace") parts.push("containers", need("container_id", a.container_id));
  if (r.scope === "workspace") parts.push("workspaces", need("workspace_id", a.workspace_id));
  parts.push(r.segment);
  let path = parts.join("/");
  if (v.id) path += "/" + need("resource_id", a.resource_id);
  if (v.verb) path += ":" + v.verb; // custom verbs are always ':verb' appended to the collection or item path
  return path;
}

// Keep list output small: GTM entities can carry huge parameter blobs.
const COMPACT_KEYS = new Set([
  "path", "accountId", "containerId", "workspaceId", "tagId", "triggerId", "variableId", "folderId", "templateId",
  "clientId", "transformationId", "zoneId", "environmentId", "containerVersionId", "name", "type", "publicId",
  "fingerprint", "parentFolderId", "paused", "domainName", "usageContext", "description", "tagManagerUrl",
  "deleted", "numTags", "numTriggers", "numVariables", "emailAddress", "accountAccess", "containerAccess",
]);
const compact = (x: unknown) => Array.isArray(x)
  ? x.map(i => (i && typeof i === "object" ? Object.fromEntries(Object.entries(i).filter(([k]) => COMPACT_KEYS.has(k))) : i))
  : x;

/** Shrink a response to CHARACTER_LIMIT by returning fewer list items; says so and points at page_token. */
function render(data: unknown): string {
  let text = JSON.stringify(data, null, 1);
  if (text.length <= CHARACTER_LIMIT || !data || typeof data !== "object") return text.length <= CHARACTER_LIMIT * 4 ? text : text.slice(0, CHARACTER_LIMIT * 4) + "\n…[truncated; fetch a narrower resource]";
  const obj = { ...(data as Record<string, unknown>) };
  const arrKey = Object.keys(obj).find(k => Array.isArray(obj[k]));
  if (!arrKey) return text.slice(0, CHARACTER_LIMIT * 4) + "\n…[truncated]";
  let items = obj[arrKey] as unknown[];
  const total = items.length;
  while (items.length > 1 && text.length > CHARACTER_LIMIT) {
    items = items.slice(0, Math.ceil(items.length / 2));
    text = JSON.stringify({ ...obj, [arrKey]: items, _note: `Showing ${items.length} of ${total} items on this page; response size limit reached. Use compact=true or fetch single items with action=get.` }, null, 1);
  }
  return text;
}

type Auth = { userId: string };

export function registerTools(server: McpServer, auth: Auth) {
  const run = (method: string, path: string, query: Query | undefined, body: unknown, signal: AbortSignal) =>
    gtmRequest(auth.userId, method, path, { query, body, signal });

  const text = (data: unknown) => ({ content: [{ type: "text" as const, text: render(data) }] });

  for (const r of RESOURCES) {
    const actionNames = Object.keys(r.actions);
    const actionDocs = actionNames.map(n => {
      const v = r.actions[n];
      return `  - ${n}${v.note ? `: ${v.note}` : ""}${v.destructive ? " (destructive)" : ""}`;
    }).join("\n");
    const scopeIds = {
      root: "no ids needed for list",
      account: "account_id",
      container: "account_id + container_id",
      workspace: "account_id + container_id + workspace_id",
    }[r.scope];

    server.registerTool(
      r.tool,
      {
        title: r.title,
        description: `${r.about}

Scope ids: ${scopeIds}. Use gtm_account list, gtm_container list and gtm_workspace list to discover them. Updates need the entity's current fingerprint (query.fingerprint) from a fresh get.

Actions:
${actionDocs}

List results are compact by default (names, ids, fingerprint); set compact=false for full bodies, or action=get for one entity. Paginate with page_token.`,
        inputSchema: z.strictObject({
          action: z.enum(actionNames as [string, ...string[]]).describe(`One of: ${actionNames.join(", ")}`),
          account_id: z.string().optional().describe("GTM account id, e.g. '6012345678'"),
          container_id: z.string().optional().describe("GTM container id (numeric, not GTM-XXXX), e.g. '12345678'"),
          workspace_id: z.string().optional().describe("Workspace id, e.g. '3'"),
          resource_id: z.string().optional().describe(`Id of the ${r.title.replace("GTM ", "").toLowerCase()} entity for get/update/delete/revert and verb actions`),
          body: z.record(z.string(), z.unknown()).optional().describe("Request body for create/update/verb actions (GTM API v2 resource JSON)"),
          query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional()
            .describe("Extra query params, e.g. {fingerprint:'123'} or {type:['pageUrl','clickText']}"),
          page_token: z.string().optional().describe("pageToken from a previous list response's nextPageToken"),
          compact: z.boolean().default(true).describe("For list: return only identifying fields. Set false for full bodies"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async (args, ctx) => {
        const v = r.actions[args.action];
        if (!v) throw new Error(`Unsupported action '${args.action}' for ${r.tool}. Valid: ${actionNames.join(", ")}`);
        if (v.body && args.body === undefined) throw new Error(`${r.tool} ${args.action} needs a body.`);
        const path = buildPath(r, v, args);
        const query: Query = { ...(args.query ?? {}), ...(args.page_token ? { pageToken: args.page_token } : {}) };
        const data = await run(v.method, path, query, v.body || v.method === "PUT" || (v.method === "POST" && args.body !== undefined) ? args.body : undefined, ctx.mcpReq.signal);
        if (args.action === "list" && args.compact && data && typeof data === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(data)) out[k] = Array.isArray(val) ? compact(val) : val;
          return text(out);
        }
        return text(data);
      }
    );
  }

  // ---- One-shot workflow: workspace -> version -> (optionally) live ----
  server.registerTool(
    "gtm_publish_workspace",
    {
      title: "Create version and publish workspace",
      description: `Create a container version from a workspace and optionally publish it live, in one call.
Runs quick_preview first and stops if the workspace has compile errors. Set publish=false to only create the version.
Example: "Publish workspace 3 as 'Add GA4 purchase tag'" -> account_id, container_id, workspace_id=3, name, notes, publish=true.`,
      inputSchema: z.strictObject({
        account_id: z.string(), container_id: z.string(), workspace_id: z.string(),
        name: z.string().min(1).describe("Version name"),
        notes: z.string().optional().describe("Version notes / change description"),
        publish: z.boolean().default(true).describe("Publish the new version live (default true)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const base = `accounts/${encodeURIComponent(a.account_id)}/containers/${encodeURIComponent(a.container_id)}`;
      const ws = `${base}/workspaces/${encodeURIComponent(a.workspace_id)}`;
      const preview = (await run("POST", `${ws}:quick_preview`, undefined, undefined, ctx.mcpReq.signal)) as { compilerError?: boolean };
      if (preview.compilerError) {
        return { isError: true, content: [{ type: "text" as const, text: `Workspace has compiler errors; not versioned.\n${render(preview)}` }] };
      }
      const created = (await run("POST", `${ws}:create_version`, undefined, { name: a.name, notes: a.notes ?? "" }, ctx.mcpReq.signal)) as {
        containerVersion?: { path?: string; containerVersionId?: string }; compilerError?: boolean; syncStatus?: unknown;
      };
      const ver = created.containerVersion;
      if (!ver?.path) return { isError: true, content: [{ type: "text" as const, text: `No version created (likely merge conflicts or no changes).\n${render(created)}` }] };
      if (!a.publish) return text({ created: ver });
      const published = (await run("POST", `${ver.path}:publish`, undefined, undefined, ctx.mcpReq.signal)) as { containerVersion?: unknown };
      return text({ created: ver.containerVersionId, published: (compact([published.containerVersion]) as unknown[])[0] });
    }
  );

  // ---- Raw escape hatch ----
  server.registerTool(
    "gtm_api_request",
    {
      title: "Raw GTM API v2 request",
      description: `Call any Tag Manager API v2 endpoint directly, for anything the resource tools don't cover.
path is relative to https://tagmanager.googleapis.com/tagmanager/v2/, e.g. 'accounts/123/containers/456/workspaces/7/tags'.
Custom verbs are part of the path, e.g. 'accounts/123/containers/456/versions/9:publish'.`,
      inputSchema: z.strictObject({
        method: z.enum(["GET", "POST", "PUT", "DELETE"]),
        path: z.string().min(1).refine(p => !p.includes(".."), "Path must not contain ..").regex(/^(?!\/|https?:)[A-Za-z0-9_\-/:.%]+$/, "Relative API path only, e.g. accounts/123/containers/456"),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a, ctx) => text(await run(a.method, a.path, a.query, a.body, ctx.mcpReq.signal))
  );

  // ---- Identity ----
  server.registerTool(
    "gtm_auth_status",
    {
      title: "Who am I connected as",
      description: "Show the Google account behind this connection and the GTM accounts it can reach. Use to confirm which Google user is active.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_a, ctx) => {
      const token = await googleAccessToken(auth.userId);
      const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token}` }, signal: ctx.mcpReq.signal });
      const info = (await ui.json()) as { email?: string };
      const accounts = (await run("GET", "accounts", undefined, undefined, ctx.mcpReq.signal)) as { account?: unknown[] };
      return text({ google_user: info.email, accounts: compact(accounts.account ?? []) });
    }
  );
}

export { RESOURCES, ALL_ACTIONS };
