import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { oauthRouter, verifyBearer } from "./oauth.js";
import { registerTools } from "./tools.js";

export function createServer(userId: string): McpServer {
  const server = new McpServer({ name: "gtm-mcp-server", version: "1.0.0" });
  registerTools(server, { userId });
  return server;
}

/** Bearer auth: 401 + WWW-Authenticate pointing at the resource metadata, as the MCP auth spec requires. */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
  const auth = m ? await verifyBearer(m[1]) : null;
  if (!auth) {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: "unauthorized" });
  }
  (req as Request & { gtmUserId?: string }).gtmUserId = auth.userId;
  next();
}

export function createApp() {
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: allowedHosts() });
  app.use(oauthRouter());

  // Stateless: a fresh McpServer per request, bound to the authenticated user.
  app.all("/mcp", requireAuth, (req, res) => {
    const userId = (req as Request & { gtmUserId?: string }).gtmUserId as string;
    const perRequest = toNodeHandler(createMcpHandler(() => createServer(userId)));
    void perRequest(req, res, req.body);
  });

  app.get("/", (_req, res) => res.type("text").send("gtm-mcp-server: connect via /mcp"));
  return app;
}

function allowedHosts(): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1"]);
  try { hosts.add(new URL(config.baseUrl).host); } catch { /* BASE_URL unset in tests */ }
  if (process.env.VERCEL_URL) hosts.add(process.env.VERCEL_URL);
  return [...hosts];
}

// Default export so Vercel's zero-config Express detection (which may pick src/app.ts as the
// entrypoint instead of api/index.ts) still gets a valid handler.
export default createApp();
