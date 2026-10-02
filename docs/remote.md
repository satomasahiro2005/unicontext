# Using UniContext from ChatGPT and claude.ai (read-only remote MCP)

UniContext normally answers only on `127.0.0.1`. ChatGPT on the web and claude.ai cannot reach
that, so the daemon can run a second, **read-only** listener that a Cloudflare named tunnel
publishes at a public https hostname (for example `https://uc.nemut.ai`). Research behind the
design: [research/chatgpt-connector.md](research/chatgpt-connector.md).

```
ChatGPT / claude.ai ──https──▶ Cloudflare ──tunnel──▶ cloudflared (this PC)
                                                         │
                                                         ▼
                              unicontextd remote listener 127.0.0.1:17879
                              ├─ /.well-known/*  OAuth metadata (RFC 9728, RFC 8414)
                              ├─ /register /authorize /token /revoke   OAuth 2.1 AS
                              └─ /mcp            read-only MCP (streamable HTTP)

unicontextd local listener 127.0.0.1:17878 (REST, Web UI, full MCP) — never in the tunnel
```

## What is exposed, and what is not

- **Tools**: only read tools (`get_today`, `get_week`, `get_course`, `get_deadlines`,
  `get_assignments`, `get_tasks`, `search`, `get_source`, `get_conflicts`, `prepare_for_class`,
  `review_class`, `get_recent_changes`, `get_announcements`, `get_announcement`, `search_syllabus`, `get_syllabus`, `get_credit_summary`, …).
  Every tool carries `readOnlyHint: true` and an output schema. The propose-only tools
  (`correct_fact`, `propose_pace_slot`) are **not registered** on this surface, so a call to them
  fails as an unknown tool. `get_source` returns the citation and the facts it supports, but no raw
  source payloads.
- **Not exposed**: the REST admin API, the Web UI, proposals/confirmation, task status changes, sync,
  login, settings. They live on the local listener (`daemon.port`), which the tunnel config never
  maps.
- **Who can connect**: a client must finish OAuth 2.1, and every authorization shows a page on
  `uc.nemut.ai/authorize` that only proceeds after you type **your UniContext passphrase**.
  Five wrong passphrases lock approvals for 15 minutes (doubling up to 24 hours); the lock is stored
  on disk and applies to every address. Bursts are also rate limited per client address.
- **Tokens**: access tokens live 1 hour, refresh tokens 30 days (renewed on use, rotated every
  time; replaying an old refresh token revokes the whole grant). Tokens and client secrets are
  stored only as SHA-256 hashes; the passphrase as scrypt. Tokens are bound to the resource
  `https://<host>/mcp` (RFC 8707) and checked on every request.
- **Audit log**: every remote tool call (time, client id and name, tool, ok/error, duration,
  client address — never arguments or results) and every OAuth event (register, authorize, token,
  refresh, revoke, failed unlock, lockout) is appended to `<data dir>/logs/remote-audit.jsonl`.

## 1. Configure UniContext

Add to `config.yaml` (Windows: `%LOCALAPPDATA%\unicontext\config.yaml`):

```yaml
remote:
  enabled: true
  publicUrl: https://uc.nemut.ai # the public origin, no path
  # port: 17879                  # remote listener, 127.0.0.1 only
  # accessTokenTtl: 1h
  # refreshTokenTtl: 30d
  # trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] # whose X-Forwarded-* are believed
  # extraRedirectUris: []        # e.g. http://localhost:6274/oauth/callback for MCP Inspector
```

Set the passphrase you will type when approving a connection (at least 12 characters; it is
asked twice and not echoed):

```
unicontext remote set-passphrase
```

Restart the daemon (`unicontext daemon stop` then `unicontext daemon start`, or restart the
service) and check:

```
unicontext remote status
```

The issuer, metadata URLs and the token audience always come from `remote.publicUrl`. Requests
are accepted only when their Host is that hostname and, for an https `publicUrl`, when the trusted
tunnel says the client used https (`X-Forwarded-Proto: https`). `X-Forwarded-*` and
`CF-Connecting-IP` are believed only from `trustedProxies` (the local cloudflared); anything else
gets a 421/403.

### Course planning (syllabus catalog)

`search_syllabus` / `get_syllabus` search the public syllabus of whole faculties, not only your
own courses, once the syllabus source has a `catalog` (details:
[connectors/syllabus.md](connectors/syllabus.md)):

```yaml
sources:
  syllabus:
    catalog:
      faculties: [IN-B, LA-S] # 情報学部 + 全学教育科目（静岡）
      terms: [current, next] # e.g. on 2026-10-01: 2026 後期 and 2027 前期 (if published)
      detailsPerRun: 30 # detail pages opened per daily run; the rest stay list-only until later runs
```

It runs daily, one request per second at most. `get_credit_summary` uses the LiveCampusU data you
already sync (enrolments and grades) plus the term cap from the profile (`registration.creditCap`).

## 2. Create the Cloudflare tunnel

Needs a Cloudflare account with the zone (`nemut.ai`) and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```
cloudflared tunnel login                        # once, opens the browser
cloudflared tunnel create unicontext            # prints the tunnel UUID and writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns unicontext uc.nemut.ai
unicontext remote tunnel-config --tunnel unicontext \
  --credentials-file ~/.cloudflared/<UUID>.json --write ~/.cloudflared/unicontext.yml
cloudflared tunnel --config ~/.cloudflared/unicontext.yml run unicontext
```

`unicontext remote tunnel-config` without `--write` prints the config. It maps only
`uc.nemut.ai → http://127.0.0.1:<remote.port>` and ends with a catch-all `http_status:404`; the
local admin port is never part of it. To run the tunnel in the background on Windows,
`cloudflared service install` uses `%USERPROFILE%\.cloudflared\config.yml`, so write the config
there instead (`--write %USERPROFILE%\.cloudflared\config.yml`).

Do **not** put Cloudflare Access, a WAF managed challenge or Bot Fight Mode in front of this
hostname: ChatGPT and claude.ai call `/.well-known/*`, `/register`, `/token` and `/mcp` from
their servers and cannot solve challenges. The OAuth layer above is the access control.

Check from anywhere:

```
curl https://uc.nemut.ai/.well-known/oauth-protected-resource
curl -i https://uc.nemut.ai/mcp -X POST     # 401 with WWW-Authenticate: Bearer resource_metadata="..."
```

Optional: test with MCP Inspector (`npx @modelcontextprotocol/inspector`), adding its callback
(`http://localhost:6274/oauth/callback`) to `remote.extraRedirectUris` while you test and removing
it afterwards.

## 3. Add it to ChatGPT (developer mode)

Needs Plus, Pro, Business, Enterprise or Edu on the web (Business/Enterprise: an admin must allow
developer mode).

1. Settings → Security and login → **Developer mode** on (https://chatgpt.com/settings/security).
2. Open https://chatgpt.com/plugins → **+** → **Create MCP App**.
3. URL: `https://uc.nemut.ai/mcp`. Authentication: **OAuth**. Leave client ID/secret empty —
   ChatGPT registers itself (Client ID Metadata Document or Dynamic Client Registration).
4. ChatGPT opens `uc.nemut.ai/authorize`: check the client name and that the scope says
   読み取りのみ, type your passphrase, press **許可**.
5. The app appears under Drafts. Start a **new** chat and enable it there. All tools are read-only,
   so ChatGPT does not ask for write confirmations.

After a UniContext update that changes tools, press **Refresh** on the app page and start a new
chat (ChatGPT caches tool metadata).

## 4. Add it to claude.ai

1. Settings → Connectors → **Add custom connector**.
2. URL: `https://uc.nemut.ai/mcp`. Leave the OAuth client ID/secret under Advanced empty (claude.ai
   uses Dynamic Client Registration; its callback `https://claude.ai/api/mcp/auth_callback` is on
   the allowlist).
3. **Connect** → the same passphrase page → **許可**.

## 5. Revoke access

```
unicontext remote clients                 # registered clients, last use, active grants
unicontext remote revoke <clientId>       # that client's tokens stop working immediately
unicontext remote revoke --all --yes      # everyone
```

Revocation works while the daemon is running (it re-reads its state file on the next request).
The app has to be authorized again (with the passphrase) to reconnect. To switch the endpoint off
completely, stop cloudflared and/or set `remote.enabled: false` and restart the daemon. Changing the
passphrase (`unicontext remote set-passphrase`) does not revoke existing grants; run
`remote revoke --all` too if you think the passphrase leaked.

## Allowed redirect URIs

- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://chatgpt.com/connector/oauth/<callback id>`
- `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
- anything listed in `remote.extraRedirectUris` (exact match)

Client ID Metadata Documents (an https `client_id`) are fetched only from
`remote.clientMetadataHosts` (default `chatgpt.com`, `openai.com`, `claude.ai`, `claude.com`,
`anthropic.com` and their subdomains), without following redirects, 5 s timeout, 64 KiB max.
Such clients may use `none` or `private_key_jwt` (verified against the document's `jwks`/`jwks_uri`).

## Endpoints and protocol details

| Endpoint                                                              | Notes                                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource[/mcp]`                     | `resource`, `authorization_servers`, `scopes_supported: [unicontext.read, offline_access]`           |
| `GET /.well-known/oauth-authorization-server`, `openid-configuration` | S256 only, `authorization_response_iss_parameter_supported`, `client_id_metadata_document_supported` |
| `POST /register`                                                      | RFC 7591; `none`, `client_secret_post`, `client_secret_basic`; at most 100 clients                   |
| `GET/POST /authorize`                                                 | consent page with passphrase; responses carry `iss` (RFC 9207)                                       |
| `POST /token`                                                         | `authorization_code` (PKCE S256, `resource` must match) and `refresh_token` (rotating)               |
| `POST /revoke`                                                        | RFC 7009                                                                                             |
| `POST /mcp`                                                           | Bearer token; 401 + `WWW-Authenticate: Bearer resource_metadata="…", scope="unicontext.read"`        |

Unknown requested scopes are ignored (the grant is always `unicontext.read`, plus `offline_access`
if asked). Refresh tokens are issued even without `offline_access`, because ChatGPT's refresh
behaviour is undocumented.

## Troubleshooting

- **421 misdirected_request**: the Host is not the `publicUrl` hostname (typo in `publicUrl`, or a
  tunnel `httpHostHeader` override).
- **403 https_required**: the request did not come through the tunnel (or `trustedProxies` does not
  include the address cloudflared connects from).
- **ChatGPT "Connector is not safe" / timeout**: see the research notes; check that the metadata URLs
  above answer over https and that no Cloudflare challenge is in front.
- **Locked**: wait until the time shown on the page (`unicontext remote status` shows it too).
