# adapter-browser (`@unicontext/adapter-browser`)

The last-resort adapter (SPEC §31). A human logs in once in a real browser window. The session is
kept in a persistent browser profile, and connectors reuse it. UniContext never types passwords or
MFA codes.

## Pieces

| Export                                                | Purpose                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserSession`                                      | Persistent Playwright context per source. `login()` opens a visible window and waits for the human. `refresh()` re-runs the flow headless through the stored IdP/SSO cookies and never prompts. After success, the service cookies are exported to the `SecretStore` under `<sourceId>/browser-cookies`. |
| `CookieJar`, `parseSetCookie`                         | Replay the exported cookies over plain HTTP (Node fetch) and follow `Set-Cookie` rotations.                                                                                                                                                                                                              |
| `InterstitialHandler`, `runInterstitials`             | Pluggable handlers for meaningless screens during login.                                                                                                                                                                                                                                                 |
| `shibbolethConsentHandler()`                          | Accepts the Shibboleth IdP attribute-release consent (送信属性の選択 / Information Release).                                                                                                                                                                                                             |
| `BrowserSourceAdapter` / `createBrowserSourceAdapter` | Generic `SourceAdapter` that scrapes an authenticated page (`scrape({page, input})`). Use it only when no HTTP API exists.                                                                                                                                                                               |
| `playwrightDriver()`                                  | Default driver: `playwright-core` with an installed Chrome (`channel: chrome`), then Edge. No browser download needed.                                                                                                                                                                                   |
| `FakeBrowserDriver`                                   | Scripted in-memory browser for tests.                                                                                                                                                                                                                                                                    |

## Setup

1. Install Google Chrome or Microsoft Edge. You do not need `npx playwright install`. To use a
   different browser, set `browser.executablePath` or `browser.channel` in the source config of the
   connector that uses it.
2. Run `unicontext login <source>` (the host calls the adapter's `login()`). Sign in, including
   MFA, in the window that opens. The window closes once the logged-in page is detected.
3. Later syncs use the exported cookies. When the service session expires, connectors call
   `refresh()`. If the IdP asks for a password or MFA again, the result is `auth_required` and the
   health screen asks for `unicontext login <source>` again.

The profile directory is `<cacheDir>/browser-profile`. Without a cacheDir it is
`<data dir>/cache/<sourceId>/browser-profile` (`defaultProfileDir`). It contains the browser's own
cookie store (IdP and Entra SSO), protected by your OS user account. Exported service cookies are
stored only in the OS keychain (§32). `logout()` removes both.

### Shared profiles and page-only sessions

- One queue per profile directory for the whole process: Chrome cannot open a profile twice, so
  sessions of different sources on the same directory (teams-web reuses the LiveCampusU profile,
  which already holds the Microsoft sign-in) run one after another.
- `cookieUrls: []` exports nothing. Connectors that read only inside the page (teams-web) use it,
  so no service cookie ever reaches the keychain.
- `launch` passes extra launch options (`serviceWorkers: 'block'`, a fixed `viewport`), and
  `prepareContext(context)` runs on every new context before the first navigation (teams-web
  installs its read-only request route there).

## Interstitial handlers

Handlers form a narrow allow-list:

- The runner never calls a handler on a page with a password, one-time-code or MFA field
  (`hasCredentialField`). That page is reported as "needs human".
- A handler returns `handled`, `not_applicable` or `needs_human`. In headless `refresh()`,
  `needs_human` becomes `auth_required`.
- Handlers only click, check or select. They never fill in text.

### Shibboleth attribute-release consent

The user asked for this screen to be skipped. It appears on every LiveCampusU login and gives the
user no meaningful choice (see `docs/research/shizuoka.md` §1.2, §1.8). The handler acts only when
all of these hold:

- host is in `hosts` (default `['idp.shizuoka.ac.jp']`, configurable),
- path matches `/idp/profile/SAML2/(Redirect|POST|POST-SimpleSign)/SSO`,
- the title or body has 送信属性の選択, Information Release, 属性送信 or Attribute Release,
- the form has `_eventId_proceed`,
- the page has no credential field.

When those hold, it checks `_shib_idp_consentOptions = _shib_idp_rememberConsent` if that option
exists and clicks 同意 (`_eventId_proceed`). It never clicks 拒否 (`_eventId_AttributeReleaseRejected`).

The real consent form was not captured during research, so the field names come from the Shibboleth
IdP v4/v5 defaults. If the university's form differs, the handler does nothing (`not_applicable`),
and the login falls back to the human pressing 同意.

## Limits

- Browser automation is slower and more fragile than HTTP. Connectors should use it only for the
  login and do data access over HTTP, as LiveCampusU does.
- The Entra/IdP SSO lifetime decides how long headless `refresh()` keeps working. That lifetime is
  not observed for Shizuoka yet.
- Tests use `FakeBrowserDriver`. No real browser runs in CI.
