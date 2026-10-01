# Connectors and adapters

Adapters decide **how** UniContext connects (MCP, CLI, REST, browser, filesystem, native HTTP).
Connectors decide **what** service it connects to (SPEC §4). Every connector package exports a
`ConnectorModule` (`metadata`, `configSchema`, `createAdapter`, `createNormalizer`) that the host
registers with the sync engine (`instantiateConnector` → `SyncEngine.register`). See
[ARCHITECTURE.md §4](../ARCHITECTURE.md) for the walkthrough on writing a connector.

| Page                                                    | Package                                         | Adapter                       | Stability    | Default schedule |
| ------------------------------------------------------- | ----------------------------------------------- | ----------------------------- | ------------ | ---------------- |
| [livecampusu](livecampusu.md)                           | `@unicontext/livecampusu`                       | native HTTP + browser login   | unofficial   | 15m              |
| [syllabus](syllabus.md)                                 | `@unicontext/syllabus`                          | native HTTP (public)          | unofficial   | 1d               |
| [lcu-public-cancellations](lcu-public-cancellations.md) | `@unicontext/syllabus` (`public-cancellations`) | native HTTP (public)          | unofficial   | 15m              |
| [wordpress-portal](wordpress-portal.md)                 | `@unicontext/wordpress-portal`                  | native HTTP (WP REST)         | official     | 1h               |
| [microsoft365](microsoft365.md)                         | `@unicontext/microsoft365`                      | Graph API (PKCE)              | official     | 15m (delta)      |
| [local-files](local-files.md)                           | `@unicontext/local-files`                       | filesystem                    | official     | event            |
| [chatgpt-record](chatgpt-record.md)                     | `@unicontext/chatgpt-record`                    | filesystem / manual import    | official     | event            |
| [adapter-browser](adapter-browser.md)                   | `@unicontext/adapter-browser`                   | Playwright                    | —            | —                |
| [adapter-mcp](adapter-mcp.md)                           | `@unicontext/adapter-mcp`                       | MCP (stdio / streamable HTTP) | experimental | config           |
| [adapter-cli](adapter-cli.md)                           | `@unicontext/adapter-cli`                       | child process + JSON          | experimental | config           |
| [adapter-rest](adapter-rest.md)                         | `@unicontext/adapter-rest`                      | OpenAPI REST                  | experimental | config           |
| [mapping](mapping.md)                                   | `@unicontext/mapping`                           | YAML mapping for MCP/CLI/REST | —            | —                |

The rules every connector follows (own data only, no auth bypass, read-only, denylists, polite
rate limits) are in [CONNECTOR_POLICY.md](../../CONNECTOR_POLICY.md).

## Optional adapter capabilities

`@unicontext/connector-sdk` defines optional interfaces next to `SourceAdapter`. Hosts detect them
with type guards:

| Interface                                               | Guard                               | Host usage                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InteractiveAuthAdapter` (`login(options)`, `logout()`) | `supportsInteractiveLogin(adapter)` | `unicontext login <source>`: opens the browser for OAuth (Microsoft 365) or SSO (LiveCampusU). `authenticate()` never prompts.                       |
| `WatchableAdapter` (`watch(listener)`)                  | `isWatchable(adapter)`              | The daemon calls `watch()` once and passes every `listener.onResult(result)` to `SyncEngine.ingest(sourceId, result)` (local-files, chatgpt-record). |
| `VersionAwareAdapter` (`detectProductVersion()`)        | `isVersionAware(adapter)`           | doctor / Sources screen (§72).                                                                                                                       |

## Package entry and module selection

Every connector and adapter package exports its entry as `default` **and** as named `connector`.
The entry is either a `ConnectorModule` or a `ConnectorFactory`
(`(input: {sourceId, config, profile}) => Promise<ConnectorModule>`, type in
`@unicontext/connector-sdk`). Hosts call `resolveConnectorExport(entry, input)` to get the module.

- `adapter-mcp`, `adapter-cli`, `adapter-rest`: factory. The returned module is built from the
  source's `mapping:` config, so metadata such as `product`, capabilities and authority comes from
  the mapping. That gives `edstem` as the citation source instead of `mcp`.
- `syllabus`: factory. Set `module: public-cancellations` to get the 休講 module; any other value, or
  no value, gives the syllabus module.
- `adapter-browser`: the config-driven page-snapshot module (`startUrl`, `authenticatedUrlPattern`,
  `pages`, optional `consent.shibboleth`).
- every other connector: a plain `ConnectorModule`.

```yaml
sources:
  livecampusu: { connector: livecampusu }
  lcu-kyuko: { connector: syllabus, module: public-cancellations }
  edstem:
    {
      connector: adapter-mcp,
      enabled: false,
      command: npx,
      args: [edstem-mcp],
      mapping: edstem-mcp,
    }
```

When `connector` is not set, the source id is used as the package dir.

## Deployment profiles

University-specific values (hosts, screen ids, codes, labels) never live in product code. They come
from:

1. `profiles/<university>/profile.yaml` → `products.<product>` (read by connectors from
   `ctx.profile.products[...]`), and
2. a small deployment module inside the connector (`src/profiles/shizuoka.ts`) that the profile
   selects with `deployment: shizuoka`.
