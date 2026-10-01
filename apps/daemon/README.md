# @unicontext/daemon

`unicontextd`: the long-running local process (spec §34-§36, §41).

It loads `config.yaml` and the university profile, wires `createUniContext`, registers the enabled sources, runs the sync scheduler and the notification engine, and serves on **127.0.0.1 only**:

- REST API `/api/v1/*` (Fastify), see `src/api-types.ts` for the wire types
- the Web UI (`apps/web/dist`, SPA fallback)
- MCP over streamable HTTP at `/mcp` (stateless, one server per request)

```
unicontextd [--port 17878] [--data-dir DIR] [--config FILE] [--dev] [--no-keychain] [--no-scheduler]
```

`--dev` runs the synthetic Shizuoka seed through the fake connector (clock anchored at 2026-10-01 09:30 JST, in-memory secrets, temp data dir). Nothing contacts a university.

## Security

- Bind address is fixed to `127.0.0.1`; `Host` must be `localhost`, `127.0.0.1` or `[::1]` (DNS rebinding), `Origin` if present must be loopback. No CORS headers.
- Writes (`POST`) need `Authorization: Bearer <token>`. The token is created on first start and kept in the OS keychain (`daemon/api-token`); with no keychain it is a `0600` file `daemon.token` in the data directory. The Web UI instead uses `GET /api/v1/session` (HttpOnly SameSite=Strict cookie `uc_csrf` + `X-CSRF-Token` header) and a same-origin `Origin`.
- Logs go to stderr and `logs/unicontextd.log`, always through the core redactor (§60). No telemetry (§61).
- Single instance: `unicontextd.lock` in the data directory (pid + port, stale locks are recovered).

## Loading connectors (`src/registry.ts`)

The daemon never imports connector packages statically. For each enabled entry under `sources:` it resolves a package name and imports it dynamically:

| config                                                                   | package                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| key `livecampusu`, `microsoft365`, `files`, `syllabus`, `chatgpt-record` | `@unicontext/<name>` (`files` -> `local-files`)                   |
| `connector: <short>`                                                     | alias table, else `@unicontext/<short>`                           |
| `connector: "@scope/pkg"`                                                | that package (third-party, resolved from the config/data dir too) |
| `adapter: mcp \| cli \| rest \| browser`                                 | `@unicontext/adapter-<kind>`                                      |
| `adapter: filesystem`                                                    | `@unicontext/local-files`                                         |
| role names from the profile (`academic: {product: livecampusu}`)         | the product's package                                             |

A package must export a `ConnectorModule` (`defineConnector(...)`) as `default` or `connector`, **or** a (possibly async) factory `({sourceId, config, profile}) => ConnectorModule` (the shape the generic adapter packages use, because they need the source's `command`/`url`). A missing, broken or mis-exporting package marks that source `failed` with an actionable message (`GET /api/v1/sources`, `unicontext doctor`); the daemon keeps running.

## Service install

`unicontext service install|uninstall|status` uses `src/service.ts`: launchd LaunchAgent (macOS), a hidden wscript launcher in the Startup folder (Windows, no Task Scheduler), `systemd --user` unit (Linux).

## Exports

`startDaemon`, `createRuntime` (shared by the CLI and the MCP stdio server), `createRestServer`, `DaemonClient`, `installService` and friends, `loadConnectorModule`, token/lock helpers and the `api-types` subpath (types only).
