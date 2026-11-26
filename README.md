# gtm-mcp-server

Google Tag Manager MCP server for Claude's custom-connector flow. Vercel + Supabase, allow-listed Google accounts (`ALLOWED_EMAILS` = comma-separated list, or `*` for any account).

## Tools (21)
One tool per GTM API v2 resource with an `action` argument (list/get/create/update/delete/revert + resource-specific verbs):
`gtm_account, gtm_container, gtm_workspace, gtm_tag, gtm_trigger, gtm_variable, gtm_built_in_variable, gtm_folder, gtm_template, gtm_client, gtm_transformation, gtm_zone, gtm_gtag_config, gtm_environment, gtm_version, gtm_version_header, gtm_destination, gtm_user_permission`
plus `gtm_publish_workspace` (preview -> create version -> publish), `gtm_api_request` (raw v2 passthrough) and `gtm_auth_status`.
Web and server-side (sGTM) containers are both covered (clients, transformations, zones).

## Deploy
1. **Supabase**: run `supabase/schema.sql` in the SQL editor. Copy the project URL and service-role key.
2. **Google Cloud** (project `analyticsbyte-511122`): enable **Tag Manager API**. On the existing Web OAuth client (or a new one) add redirect URI `https://gtm-mcp.alifmahmud.com/api/oauth/google/callback`. Add the Tag Manager scopes to the consent screen (they are sensitive scopes; fine for a published app used by your own account).
3. **Vercel**: import the repo, add env vars from `.env.example` (`openssl rand -base64 32` for `TOKEN_ENC_KEY`), add domain `gtm-mcp.alifmahmud.com`.
4. **Claude**: Settings > Connectors > Add custom connector > `https://gtm-mcp.alifmahmud.com/mcp` > Connect > pick your Google account.

## Dev
`npm run typecheck` type-checks; `npm run smoke` runs an in-process test with the GTM API and Supabase stubbed. `npm run dev` serves on :3000.

## Notes
- With `ALLOWED_EMAILS=*`, each person signs in with their own Google account and only reaches their own GTM accounts; their tokens are stored per user. An unverified Google app is capped at 100 users.
- Google refresh/access tokens are AES-256-GCM encrypted at rest; Claude only ever holds this server's own tokens (1h access, 30d rotating refresh).
- Updates need the entity's current `fingerprint` (pass as `query.fingerprint`); a 409 means re-get and retry.
- Expired rows in `tokens`/`auth_codes`/`oauth_pending` are harmless; cleanup SQL is at the bottom of the schema.
