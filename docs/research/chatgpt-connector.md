# Connecting a self-hosted remote MCP server to ChatGPT web (as of 2026-10-01)

Method: WebFetch/WebSearch only. The help.openai.com article returned HTTP 403 to the fetcher, so its content is known only via search-result snippets (marked [snippet]). Docs have been reorganised: "Apps SDK" pages now sit alongside "Plugins" pages, and ChatGPT's UI label is now **Plugins** (older docs say "Apps"/"Connectors"/"Settings > Connectors"). Expect UI wording drift.

## 1. Plans and where in the UI

- Developer mode: "Available to Pro, Plus, Business, Enterprise, and Education accounts on the web." Free is not listed. https://developers.openai.com/api/docs/guides/developer-mode
- Enable: Settings > Security and login > Developer mode (https://chatgpt.com/settings/security). https://developers.openai.com/plugins/deploy/connect-chatgpt ; https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- Add: ChatGPT Plugins (https://chatgpt.com/plugins) > plus button > "Create MCP App" (a developer-mode app for your remote MCP server). Created apps appear under **Drafts**. The per-app page lets you toggle tools on/off and **Refresh** to re-pull tools/descriptions/instructions. https://developers.openai.com/api/docs/guides/developer-mode
- Plus/Pro gotcha: with the toggle off, the Plugins menu shows only "Create plugin" / "Upload plugin"; after enabling Developer mode, "Create MCP App" appears (reported Sept 2026, personal Plus/Pro, Chrome/macOS). Community report, not official: https://community.openai.com/t/create-mcp-app-missing-from-plugins-menu-on-personal-chatgpt-accounts/1401436
- Business: only admins/owners can enable developer mode (Workspace Settings > Permissions & Roles > Connected Data > Developer mode / Create custom MCP connectors) and publish; admins cannot enable it per member. Enterprise/Edu: admin enables, RBAC can grant it to specific members, who then toggle at Settings > Apps > Advanced Settings. [snippet] https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Availability "can depend on account and workspace policy" (admin can disable). https://developers.openai.com/plugins/deploy/connect-chatgpt
- UNCERTAIN: third-party/snippet claims say Plus/Pro are limited to read/fetch-style connectors and "full MCP (write)" is Business/Enterprise only. The official developer-mode doc says write tools work (with confirmation) and lists Plus/Pro as eligible; I treat that doc as authoritative, but verify on a real Plus/Pro account.
- Alternative for private servers: Secure MCP Tunnel (outbound-only `tunnel-client`; needs `tunnel_id` from Platform tunnel settings + a runtime API key; in ChatGPT choose Connection = Tunnel). Plan availability not stated. https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## 2. Transport, URL, MCP features

- Transport: streamable HTTP, "typically at /mcp"; enter the URL including the path. https://developers.openai.com/apps-sdk/build/mcp-server ; https://developers.openai.com/plugins/deploy/connect-chatgpt
- The developer-mode doc says "SSE and streaming HTTP" are both supported. https://developers.openai.com/api/docs/guides/developer-mode . The older api/docs/mcp page still shows an SSE `/sse/` URL example (Replit). Use streamable HTTP; SSE is legacy (UNCERTAIN how long it persists).
- URL: public HTTPS endpoint (no localhost/private). Private alternative = Secure MCP Tunnel. OAuth endpoints must also be HTTPS (an http:// /register or /token behind an https tunnel triggered "Connector is not safe": https://community.openai.com/t/unable-to-create-connector-connector-is-not-safe-error/1362737).
- Required MCP features: tools only. Resources are optional (only for the Skills extension, `io.modelcontextprotocol/skills`). Each tool should have an action-oriented name, description, inputSchema, outputSchema ("Declare an output schema for each tool"), and safety annotations. https://developers.openai.com/apps-sdk/build/mcp-server ; https://developers.openai.com/api/docs/mcp
- Annotations: readOnlyHint ("true only when the tool cannot change state"), destructiveHint, openWorldHint. Tools without readOnlyHint are treated as write actions. https://developers.openai.com/apps-sdk/build/mcp-server ; https://developers.openai.com/api/docs/guides/developer-mode
- search/fetch: "Developer mode does not require search/fetch tools." Any tools are exposed. search/fetch (read-only, specific schemas: search -> results[{id,title,url}], fetch -> {id,title,text,url,metadata?}, each returned as both structuredContent and JSON text content) are only needed for deep research and company knowledge. Citations require a non-empty `url`. https://developers.openai.com/api/docs/guides/developer-mode ; https://developers.openai.com/api/docs/mcp
- Mixed auth supported: initialize and tools/list unauthenticated; each tool declares `securitySchemes` (noauth and/or oauth2 with scopes). https://developers.openai.com/api/docs/guides/developer-mode ; https://developers.openai.com/apps-sdk/build/auth
- After changing tool names/descriptions/schemas/annotations: redeploy, then Refresh in Plugins, start a NEW conversation. https://developers.openai.com/apps-sdk/deploy/connect-chatgpt

## 3. Authentication

Options: OAuth, No Authentication, Mixed. https://developers.openai.com/api/docs/guides/developer-mode

OAuth details (https://developers.openai.com/apps-sdk/build/auth):
- OAuth 2.1 per the MCP authorization spec. PKCE with **S256 mandatory**; if AS metadata omits `code_challenge_methods_supported` or lacks S256, the server is unsupported.
- Client registration: **CIMD (Client ID Metadata Documents) preferred** (ChatGPT's client_id is an HTTPS metadata URL; token auth `none` or `private_key_jwt`); **DCR (RFC 7591) via `registration_endpoint` still supported**; developer mode also allows static client credentials. AS metadata should set `client_id_metadata_document_supported: true`.
- Protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource`: `resource`, `authorization_servers`, `scopes_supported`.
- Unauthenticated/invalid token -> `401` with `WWW-Authenticate: Bearer resource_metadata="<url>", scope="<scope>"`; that triggers (re)auth. Per tool, errors can carry `_meta["mcp/www_authenticate"]` to trigger the auth UI.
- AS metadata (RFC 8414) at `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration` with authorization_endpoint, token_endpoint, `token_endpoint_auth_methods_supported`.
- Issuer identification (RFC 9207): set `authorization_response_iss_parameter_supported: true` and return `iss`.
- Resource indicator (RFC 8707): ChatGPT appends `resource=<your MCP URL>` to both authorize and token requests; copy it into token `aud` and validate it.
- Redirect URIs to allow: `https://chatgpt.com/connector_platform_oauth_redirect` (stable, used when issuer identification is met) or `https://chatgpt.com/connector/oauth/{callback_id}` (callback-specific otherwise). Also allow-listing the older pattern defensively is reasonable (UNCERTAIN whether still sent).
- Server must validate signature, issuer, audience, expiry, scopes on every request; never trust the model for authz.
- Not supported: client-credentials / service-account / JWT-bearer grants, customer API keys, customer mTLS certs.
- Scopes: advertise via `scopes_supported` and the 401 `scope=` challenge; per tool via securitySchemes. Exact scope-negotiation behaviour is only loosely documented (UNCERTAIN).
- Refresh tokens: docs do NOT document refresh/`offline_access` behaviour for ChatGPT (the profile-ID text says IDs persist "across token refresh", implying refresh happens). Community advice: advertise `offline_access` in `scopes_supported` and issue refresh tokens. (UNCERTAIN; source: search-result summary only.)
- Optional: `get_profile` tool with `_meta["openai/profile"]: true` for multi-account; OIDC `openid email` + UserInfo are needed only for workspace-domain restrictions.

## 4. Write-tool confirmation and publishing

- "Write actions by default require confirmation"; the user reviews tool input and may remember approve/deny per tool for the rest of that conversation. https://developers.openai.com/api/docs/guides/developer-mode
- Anything lacking `readOnlyHint: true` is a write. Mark pure reads with readOnlyHint to avoid prompts.
- Developer mode is labelled "elevated risk" (prompt injection, model mistakes on writes, malicious MCPs).
- Personal-only use: no publishing/review needed; Drafts apps work immediately and can be refreshed freely. Published plugins go through continuous review and need new versions for tool changes. https://developers.openai.com/plugins/deploy/connect-chatgpt . Only admins/owners can publish in Business/Enterprise.
- A server-side safety scan runs at connector creation ("Connector is not safe" false positives; triggered by tool descriptions mentioning "personal information"/"no authentication" or http OAuth endpoints; OpenAI said a fix was in progress, Dec 2025). https://community.openai.com/t/unable-to-create-connector-connector-is-not-safe-error/1362737

## 5. Gotchas

- Cloudflare Tunnel: nothing in the official docs excludes it. Reports: "Error creating connector / Request timeout" with a working Cloudflare-tunnelled server (Nov 2025; OpenAI acknowledged Feb 2026, no resolution documented) https://community.openai.com/t/error-creating-connector-request-timeout-for-public-https-mcp-server-cloudflare-tunnel/1367105 ; OAuth with Named Tunnel + custom domain stalled before /token because the app did not trust X-Forwarded-* (Quick Tunnel worked) https://github.com/Waishnav/devspace/issues/113 . Action: trust proxy headers so issuer/redirect/resource URLs are the public https origin; keep `/.well-known/*`, `/mcp`, `/register`, `/token`, `/authorize` reachable (no Cloudflare Access/WAF/bot challenge in front).
- Streaming: load balancer/CDN must not buffer SSE/streaming HTTP. https://developers.openai.com/apps-sdk/deploy/troubleshooting
- Verify with MCP Inspector first ("If ChatGPT cannot connect, verify the public HTTPS endpoint").
- 401 must include `WWW-Authenticate` or ChatGPT will not restart OAuth. Dynamically registered clients must stay valid (persist DCR clients).
- Timeouts / response size / tool-count limits: NOT documented in any fetched official page (unknown). Only guidance: keep calls fast ("sluggish when tool calls take longer than a few hundred ms"), return concise structuredContent.
- Outputs must match the advertised outputSchema.
- Tool metadata is cached; Refresh + new chat after changes.
