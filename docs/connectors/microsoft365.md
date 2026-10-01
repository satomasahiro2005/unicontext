# Microsoft 365 connector (`@unicontext/microsoft365`)

Reads a user's Microsoft 365 account through Microsoft Graph (spec §24, §25): calendar, Outlook mail, OneDrive file metadata and Teams (teams, channels and, optionally, channel posts). Read-only. Official API (`apiStability: official`, `risk: supported`), plain `fetch` through the SDK `createHttpClient` (no Graph SDK).

|                         |                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Package                 | `@unicontext/microsoft365` (`connectors/microsoft365`)                                                      |
| Product / sourceLabel   | `microsoft365` / "Microsoft 365"                                                                            |
| Default authority       | `collaboration` (calendar events: `calendar`; instructor posts: `instructor-announcement`)                  |
| Adapter                 | native (Graph REST)                                                                                         |
| Capabilities            | `courses`, `announcements`, `messages`, `materials`, `calendar`, `files` (limited by the enabled resources) |
| Default schedule        | `15m` (delta polling)                                                                                       |
| Extra adapter interface | `InteractiveAuthAdapter` (`login()` / `logout()`)                                                           |

## Setup

1. Register an app in your tenant (see [Registering the app in Entra ID](#registering-the-app-in-entra-id)) and copy its Application (client) ID.
2. Add the source to `config.yaml` (example below) with that `clientId`.
3. Log in once: the host calls `adapter.login()` (CLI `unicontext login <source>` / Web UI). A browser window opens, you sign in (MFA included) and consent; the tokens are stored in the OS keychain through the SecretStore (`<sourceId>/oauth`). Afterwards `authenticate()` is non-interactive and refreshes the access token with the refresh token.
4. The sync engine runs `sync()` on the schedule; every resource uses delta queries.

```yaml
sources:
  m365:
    connector: microsoft365
    clientId: 00000000-0000-0000-0000-000000000000 # your own app registration (public client)
    schedule: 15m
    # tenant: shizuoka.ac.jp          # default: profile.products.microsoft365.tenant|tenantHint, else "organizations"
    # authority: https://login.microsoftonline.com
    # scopes: "User.Read Calendars.Read Mail.Read Files.Read.All Team.ReadBasic.All Channel.ReadBasic.All"
    resources:
      calendar: true
      mail: true
      drive: true
      teams: true
      channelMessages: false # true adds ChannelMessage.Read.All (needs tenant admin consent)
    calendar: { pastDays: 30, futureDays: 180 }
    mail: { folder: inbox, maxItems: 1000, pastDays: 90 }
    drive: { maxItems: 2000 }
```

### Config keys

| Key                                   | Default                                                                                      | Meaning                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientId`                            | none (required to log in)                                                                    | Application (client) ID of your own Entra app registration. No client secret: this is a public client.                                                                                                    |
| `tenant`                              | `profile.products.microsoft365.tenant`, then `...tenantHint`, then `organizations`           | Tenant id or verified domain used in the authority URL.                                                                                                                                                   |
| `authority`                           | `https://login.microsoftonline.com`                                                          | Login authority base URL (sovereign clouds).                                                                                                                                                              |
| `graphBaseUrl`                        | `https://graph.microsoft.com/v1.0`                                                           | Graph base URL.                                                                                                                                                                                           |
| `scopes`                              | `User.Read Calendars.Read Mail.Read Files.Read.All Team.ReadBasic.All Channel.ReadBasic.All` | Delegated scopes (string or list). `offline_access openid profile` are always added; `ChannelMessage.Read.All` is added only when `resources.channelMessages` is true. Changing scopes needs a new login. |
| `loginHint`                           | none                                                                                         | UPN passed to the sign-in page.                                                                                                                                                                           |
| `resources.calendar/mail/drive/teams` | `true`                                                                                       | Toggle a resource.                                                                                                                                                                                        |
| `resources.channelMessages`           | `false`                                                                                      | Read channel posts and replies (admin consent needed).                                                                                                                                                    |
| `calendar.pastDays` / `futureDays`    | `30` / `180`                                                                                 | Calendar window of `calendarView/delta`.                                                                                                                                                                  |
| `mail.folder`                         | `inbox`                                                                                      | Well-known folder name or folder id.                                                                                                                                                                      |
| `mail.maxItems`                       | `1000`                                                                                       | Cap on messages stored by an initial/full run.                                                                                                                                                            |
| `mail.pastDays`                       | `90`                                                                                         | Initial/full runs only look at mail received in the last N days.                                                                                                                                          |
| `drive.maxItems`                      | `2000`                                                                                       | Cap on drive items stored by an initial/full run.                                                                                                                                                         |

Credentials never go into `config.yaml`; the config loader rejects keys that look like secrets.

## Registering the app in Entra ID

Microsoft Graph calls need an application registration: UniContext is a "native app" using Authorization Code + PKCE with a loopback redirect (RFC 8252). Every user registers their own app, so nothing is shared and no secret exists.

1. Sign in at <https://entra.microsoft.com> with your university account, then open **Identity > Applications > App registrations > New registration**. At Shizuoka University students can register apps (user setting "Users can register applications: Yes" was observed on 2026-10-01).
2. Name it (for example `UniContext (personal)`). **Supported account types**: "Accounts in this organizational directory only" (single tenant). Leave the redirect URI empty for now and register.
3. **Authentication > Add a platform > Mobile and desktop applications**, add the redirect URI `http://127.0.0.1` (the connector uses `http://127.0.0.1:<random port>/callback`; Microsoft ignores the port for loopback redirects). If the portal refuses `127.0.0.1`, add it through **Manifest** (`replyUrlsWithType` / `publicClient.redirectUris`) or register `http://localhost`. Under **Advanced settings** set **Allow public client flows** to **Yes**.
4. **API permissions > Add a permission > Microsoft Graph > Delegated permissions**:
   - `User.Read`, `Calendars.Read`, `Mail.Read`, `Files.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`
   - optional: `ChannelMessage.Read.All` (channel posts; always requires **admin consent**)
   - `offline_access`, `openid`, `profile` are requested automatically.
     Do not add application permissions and do not create a client secret.
5. **Overview**: copy **Application (client) ID** into `sources.<id>.clientId`. The tenant is resolved from the profile (`tenantHint: shizuoka.ac.jp`) or `tenant:`.
6. Run the login. On the consent screen you either accept (user consent allowed) or see **"Need admin approval"** (the tenant restricts user consent).

### If consent is blocked (admin approval required)

Whether students may consent to delegated permissions at Shizuoka University is unknown (the user-consent setting could not be read: HTTP 401 in the Entra admin center). `ChannelMessage.Read.All` always needs an administrator. The connector detects this and does not fail silently:

- OAuth errors `AADSTS65001`, `AADSTS90094`, `AADSTS90095`, `consent_required`, "admin approval" and `access_denied`, as well as Graph `403 Authorization_RequestDenied` / "Insufficient privileges", produce `AuthResult.status = auth_required` and health `auth_required` with a Japanese and English message that tells the user that tenant admin consent is required.
- Options: (a) ask the administrator for approval (Entra "admin consent workflow" lets you send a request from the consent screen); (b) lower the scope list (for example `Files.Read` instead of `Files.Read.All`, drop `Mail.Read`) with `scopes:` so that only low-risk permissions are requested; (c) fall back to the **browser adapter** for Outlook on the web and Teams web (`adapter: browser`), which reads the pages with the user's own session and needs no app registration.
- A 403 on one optional resource during a sync (typically channel messages) does not fail the run: that resource is skipped, a `warnings` entry is returned and health becomes `degraded`. Only when every enabled resource is refused does `sync()` throw `AuthRequiredError` (health `auth_required`).

## Authentication

- Authorization Code + PKCE (S256), system browser, loopback redirect, via `@unicontext/auth` (`authorizeWithPkce`). Endpoints: `<authority>/<tenant>/oauth2/v2.0/authorize|token`.
- Tokens are stored as JSON in the SecretStore (`secretKey(sourceId, 'oauth')`) by `OAuthTokenStore`; `getAccessToken` refreshes with the refresh token. They are never written to the database, raw payloads, logs or entities. Pre-authenticated OneDrive `@microsoft.graph.downloadUrl` values are removed from raw drive items.
- `authenticate()`: no stored tokens (or no `clientId`) gives `auth_required`; tokens present or refreshable give `authenticated` with the account from the id token claims (`preferred_username`), never a token. If the token endpoint is unreachable while refreshing, the credentials are kept and `sync()` reports the network error.
- `login(options)` accepts `openBrowser`, `loginHint`, `timeoutMs`, `signal`. If the browser shows "Need admin approval" the user never returns to the loopback and the timeout result carries the admin-consent message. `logout()` deletes the stored tokens.

## Raw types

Payloads are the Graph JSON unmodified (only `@microsoft.graph.downloadUrl` is dropped); the connector adds a non-secret `_context` object where Graph lacks the parent ids. Each type has a zod schema (`GraphSchemas`) used for schema-drift detection (§73).

| Raw type               | `externalId`                       | Source                                      | Notes                                                            |
| ---------------------- | ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `graph.event`          | event id                           | `/me/calendarView/delta`                    | `Prefer: outlook.timezone="UTC"` so start/end are UTC            |
| `graph.message`        | message id                         | `/me/mailFolders/{folder}/messages/delta`   | `$select` incl. body; `Prefer: outlook.body-content-type="text"` |
| `graph.driveItem`      | item id                            | `/me/drive/root/delta`                      | metadata only                                                    |
| `graph.team`           | team id                            | `/me/joinedTeams`                           | full list every run                                              |
| `graph.channel`        | `<teamId>/<channelId>`             | `/teams/{id}/channels`                      | `_context: {teamId}`                                             |
| `graph.channelMessage` | `<teamId>/<channelId>/<messageId>` | `/teams/{id}/channels/{cid}/messages/delta` | `_context: {teamId, channelId, selfUserId}`                      |

## Mapping (raw to canonical)

| Raw                                                                            | Canonical entities                                                                                                                                                                                                                                                                                                                                | Authority / provenance                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `graph.event`                                                                  | `calendarEvent`: title (subject), `startsAt`/`endsAt` as ISO from Graph `{dateTime, timeZone}` (UTC `Z`; other zones converted; all-day events become local midnights in the profile timezone), `location`, `allDay`, `description` (bodyPreview), `url` (webLink), `category`. Cancelled events produce nothing.                                 | `calendar`; `ref.url` = webLink                              |
| `graph.message`                                                                | `thread` (id from `conversationId`, title = subject without Re:/Fwd:, platform `outlook`) + `message` (author, plain-text body, `sentAt`, `url`, `extra.fromAddress`)                                                                                                                                                                             | default `collaboration`; `ref.location.messageId`, `ref.url` |
| `graph.driveItem`                                                              | `document` (title = name, mimeType, path from `parentReference.path` + name, url, sizeBytes, hash, modifiedAt) + `material` (`ppt/pptx/key/...` = `slides`, `pdf` = `handout`, else `other`). Folders are skipped.                                                                                                                                | default `collaboration`                                      |
| `graph.team`                                                                   | `courseOffering`: for 「yyyy年度（科目・クラス名等）」 `academicYear` and `title` (subject, class marker such as 「1クラス」 goes to `extra.className`); otherwise title = displayName. `extra.teamId`, `extra.teamName`. IdentityResolver can link it to the LiveCampusU offering.                                                               | default                                                      |
| `graph.channel`                                                                | `thread` (platform `teams`, `courseOfferingId` = the team's offering)                                                                                                                                                                                                                                                                             | default                                                      |
| `graph.channelMessage`                                                         | top-level post by someone other than the signed-in user: `announcement` (scope `course`, importance from Graph `high`/`urgent`, title = subject or first line). Replies and own posts: `message` in the channel thread (`isQuestion` when the text ends with ？/?). HTML is stripped. System event messages and deleted messages produce nothing. | announcements: `instructor-announcement`; messages: default  |
| announcement text matching 「教室を…に変更」「…教室に変更」「…教室で行います」 | `Fact` on the team's offering: predicate `room`, value e.g. `11教室`, origin `extracted`, confidence 0.6, evidence = the sentence                                                                                                                                                                                                                 | `instructor-announcement`                                    |

The conflict engine then compares this `room` hint with the academic system's room (conflict policy applies; the hint never silently wins).

Known heuristic: any top-level post by another user is treated as an announcement, including a student's question. Graph does not tell the connector who is an instructor; the post is still scoped to the course and cited as `instructor-announcement`.

## Sync behaviour

- Delta per resource: the `@odata.deltaLink` of each resource is stored in `cursor.extra.deltaLinks` (`calendar`, `mail`, `drive`, `channelMessages/<teamId>/<channelId>`), together with `meId` (the signed-in user id, used to tell own posts apart) and the calendar window. The engine persists the last page's cursor in `sync_state`.
- Paging: `@odata.nextLink` is followed through `hasMore` / `nextPageToken`. The token is JSON that carries the remaining work (resource queue, current link, collected delta links), because the engine re-sends the old cursor on every page. One `sync()` call may issue several Graph requests (up to about 200 items).
- `@removed` entries (and drive `deleted`, channel message `deletedDateTime`) become `deletions`.
- `mode: 'full'` ignores stored delta links and restarts every resource. A delta link that Graph rejects (HTTP 410/400) is restarted once with a warning.
- `complete` is declared for `graph.team` and `graph.channel` every run (full list), and for event/message/driveItem when the resource was enumerated from scratch without hitting a cap. So teams you left, deleted events etc. disappear.
- The calendar delta link is bound to its `startDateTime`/`endDateTime`; the connector re-baselines (fresh window) when the window is older than 14 days or ends in less than 30 days.
- Initial/full mail is limited to `mail.pastDays` and `mail.maxItems`; drive to `drive.maxItems`. When a cap is hit the run still walks to the delta link (so later runs are incremental) and returns a warning; older items are not stored.
- Channel messages: `/messages/delta` first; if Graph answers 400/404/405/501 the connector lists `/messages` (+ `/messages/{id}/replies`) without a delta link.
- Rate limiting: every request goes through `ctx.rateLimiter` (token bucket); HTTP 429/503 honour `Retry-After`; 5xx is retried with backoff.
- Failure handling: 401 gives `AuthRequiredError`; 403 skips that resource with a warning; if nothing succeeded the run fails (`auth_required` when every refusal was a permission error).

### Health

`healthy`; `auth_required` (no tokens, refresh failure, no `clientId`, or consent blocked); `degraded` (the last run skipped a resource or hit a cap; the message lists the skipped resources); `failed` for unexpected authentication errors. Network and rate-limit errors are mapped by the sync engine (`offline`, `rate_limited`).

## Change notifications (optional, §24)

The default is local-first delta polling every 15 minutes. Graph can additionally push change notifications, but only to a public HTTPS URL, which a local daemon does not have. `GraphChangeNotifications` (exported) implements the connector side so a host that does have an endpoint (a tunnel such as Cloudflare Tunnel, or a small relay) can opt in:

```ts
const hooks = new GraphChangeNotifications({
  sourceId: 'm365',
  clientState, // generateClientState(); keep it in the SecretStore
  getAccessToken: () => tokenStore.getAccessToken(oauthConfig),
  trigger: (sourceId) => scheduler.trigger(sourceId), // SyncScheduler.trigger -> normal incremental (delta) sync
});
const sub = await hooks.createSubscription(
  subscriptionResource('mail'),
  'https://hooks.example.com/graph',
);
// renew before expiry: if (hooks.needsRenewal(sub)) await hooks.renew(sub);
// in the HTTP handler for POST /graph:
const { response } = await hooks.handleWebhook({
  query: url.searchParams,
  body: await readJson(req),
});
```

- `handleWebhook` echoes `validationToken` (text/plain 200), rejects notifications whose `clientState` differs (401), calls `trigger(sourceId)` once per call and answers 202. `lifecycleEvent: missed` triggers a sync; `reauthorizationRequired` is returned in `accepted` so the host can renew. `validateNotification` is the same check without side effects.
- Notifications carry no data we rely on: the delta query stays the source of truth, so a lost notification only delays a change until the next poll.
- Lifetimes are short (Teams channel messages 60 minutes, mail/events about 3 days), so the host must renew. Some resources (for example channel messages) may require application permissions for subscriptions; the connector does not request them.
- The daemon does not wire this by default (no server).

## Limits and known issues

- OneDrive: metadata only in v1 (no content download, no text extraction). SharePoint sites other than the user's OneDrive are not read.
- Calendar events outside the configured window are not synced; recurring events are returned as occurrences by `calendarView`.
- Mail: only the configured folder; bodies are plain text; attachments are not downloaded.
- Teams: only joined teams; chats (1:1/group) are not read; channel posts need `ChannelMessage.Read.All` plus admin consent. Delta for channel messages is only offered for some tenants; the fallback re-lists recent messages.
- The Shizuoka tenant (`e0d7dc00-4621-4fe0-90b1-df7b1b40b351`, domain `shizuoka.ac.jp`, managed namespace, MFA mandatory) allows app registration; the user-consent policy is unverified (docs/research/shizuoka.md section 5). Try the login once; if it asks for admin approval, use the fallback above.
- Scope changes (for example enabling `channelMessages`) require a new login.
