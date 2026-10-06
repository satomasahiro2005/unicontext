# Connector policy

UniContext reads a student's own data from university systems. Several of those systems (for
example LiveCampusU) have no public API, so some connectors talk to internal web endpoints. This
policy (SPEC §27, §50, §51, §56–§60) is binding for every official connector and is the bar for
third-party ones.

## 1. What a connector may do

1. **Only the user's own, authorized data.** A connector acts as the logged-in student, with that
   student's session, and reads what the student can already see in the browser. It never reads
   other people's data, never enumerates ids, and never widens a query beyond the user's own
   courses. Public pages (syllabus, cancellation notices, portal posts) are fine, but fetch only
   what the user needs (for example syllabus entries for the user's own courses, not the whole
   catalogue).
2. **No authentication bypass.** Log in through the university's normal flow (SSO, MFA). The
   human signs in themselves in a real browser (adapter-browser), and UniContext reuses the session
   they create. Connectors must not:
   - post to hidden or disabled login forms to get around SSO or MFA (the LiveCampusU
     `local-account` strategy is a disabled stub for this reason),
   - fill passwords, one-time codes or MFA prompts automatically (adapter-browser refuses to run
     interstitial handlers on any page that has such a field),
   - reuse or forge tokens they were not issued, or defeat CSRF and transaction-token protection.

   Interstitial handlers can only dismiss screens the user has explicitly asked to skip. Today the
   only one is the Shibboleth attribute-release consent, which the user agrees to on every login.

   **Saved-password sign-in the student chose.** One exception to "no password filling", decided by
   the student on 2026-10-06 for a portal whose sessions end 60 minutes after sign-in whatever
   happens: `shizuoka-vpn-files` may type the student's **own** user name and password, which the
   student saved in the OS keychain through `unicontext login` / `unicontext secrets set`
   (`SavedCredentialsAdapter`), into the realm's normal sign-in form, and nothing else. Conditions,
   all enforced in code with tests (docs/connectors/shizuoka-vpn-files.md):
   - opt-in per source (nothing happens without saved credentials) and off with one setting;
   - only the realm's own form on the portal host over HTTPS, the normal flow (no hidden or
     disabled form, no replayed tokens); one-time codes, MFA, secondary passwords and CAPTCHAs are
     never filled or bypassed, and a "continue / other sessions" button is never pressed: they stop
     the attempt with `auth_required` and say what was seen;
   - rate-limited (one attempt per interval) and stopped for good on a wrong password, a lock-out or
     MFA until the student saves the credentials again or signs in by hand, so retries can never
     lock the account;
   - the values never leave the keychain and the form fields: not in config, the database, logs,
     traces, state files or error messages.

   Any other connector that wants the same needs the student's own decision and the same
   conditions.

3. **Read-only by default (§50).** Connectors do not change state in the source. If an endpoint
   has a side effect, it goes on a hard-coded denylist in the connector's HTTP layer, and a test
   proves the request is refused before anything is sent. Examples are marking notices read,
   ToDo flags, calendar additions, report or file exports, submissions and registration. A
   connector that drives an official web client (teams-web) installs a browser route that aborts
   every non-read request of that client (mark-read, presence, posting, joining, turning in)
   before the first navigation, with the same test obligation. Writes
   that may come later must go through propose → confirm → execute in the apps, and high-risk
   writes (§51: registration, submission, anything about grades) are never run automatically.

   **Read side effects the student accepted.** Some sources mark an item read just because it was
   viewed, with no request of its own to deny. Such a view is allowed only when the student has
   decided that the content matters more than the source's read flag, the connector exposes it as
   a documented config option the deployment can turn off, the session refuses it unless that
   option is on (with a test), and UniContext keeps its own unread state for the item until the
   student reads it in UniContext. Explicit mark-read actions stay denied. Today this is
   LiveCampusU's `openUnreadNotices` (default on: the student chose content over the unread flag;
   see docs/connectors/livecampusu.md).

4. **Polite traffic (§37).** Use the connector SDK `RateLimiter` (token bucket, Retry-After,
   exponential backoff with jitter), at most one in-flight request per session where the server
   needs it, incremental sync (lists first, details only for items that changed), and schedules
   that avoid known maintenance windows. Never poll more often than the default schedules unless
   the user asks.
5. **No vendor code.** Do not copy, bundle or redistribute the vendor's JavaScript, HTML templates
   or assets. Parse the responses instead. Product-version detection may record public facts such as
   bundled library versions or file hashes, but never the files themselves.
6. **Separate deployment specifics.** Product logic stays generic. University-specific screen ids,
   hosts and codes live in a deployment profile, inside the connector (`profiles/<university>`)
   and/or in `profiles/<university>/profile.yaml`.

## 2. Declaring risk (§27, §55, §72)

Connector metadata must state:

```ts
apiStability: 'official' | 'unofficial' | 'experimental',
risk: 'supported' | 'unsupported' | 'experimental',   // unofficial ⇒ not 'supported'
testedVersion: '<product version fingerprint>',       // required for unofficial
```

At runtime, unofficial connectors detect the product version. An untested version sets health to
`degraded` with a warning and does not fail. Unknown or missing fields in JSON responses are
recorded as schema drift (§73), so changes never break silently.

## 3. Secrets and personal data (§32, §60)

- Tokens, cookies and passwords go only to the OS keychain (`SecretStore`). They are never written
  to the database, raw payloads, config files or logs. The compliance suite checks payloads for
  credential-looking keys.
- Browser profiles that hold IdP/SSO cookies live under the per-source cache directory in the user's
  data dir. `unicontext logout <source>` (adapter `logout()`) deletes them.
- Never store the student ID or real name taken from a page header. The logger redacts the profile's
  `privacy.studentIdPattern`.
- Test fixtures are sanitized: no real names, ids, tokens or grade values. CI never contacts a real
  university (§65).

## 4. Licensing (§56–§58)

Official connectors are MIT. Third-party tools under other licenses (for example GPL) are
connected out of process through adapter-mcp, adapter-cli or adapter-rest, and are never vendored
into UniContext.

## 5. Vulnerabilities

If you find a vulnerability in a university system while building or using a connector, do not
open a public GitHub issue, and do not probe further. Report it privately to the university (and,
in Japan, through IPA/JPCERT if appropriate). See SECURITY.md once it exists. UniContext's own
vulnerabilities and connector bugs are handled separately.

## 6. Checklist for a new connector

- [ ] Reads only the user's own or public data; no enumeration.
- [ ] Logs in only through the normal flow; no credential filling (except the student-chosen,
      saved-password sign-in of §1.2) and no hidden-form login.
- [ ] Side-effecting endpoints are on a denylist, with a test.
- [ ] RateLimiter is used and schedules are sensible; one session means serialized requests.
- [ ] Metadata has `apiStability`, `risk`, `testedVersion`; version detection and drift
      detection are in place.
- [ ] Secrets go only through `ctx.secrets`; payloads and logs have no credentials or student IDs.
- [ ] Fixtures are sanitized; `testConnectorCompliance` passes; no network in tests.
- [ ] Documented in `docs/connectors/<name>.md`, including limits.
