# Security policy

UniContext handles credentials and personal academic data, so security reports are taken seriously. Please read this page before reporting, because three different kinds of problem are handled in three different ways.

## What to report where

| What you found                                                                                                                                                                                 | Where it goes                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A vulnerability in UniContext itself (core, daemon, CLI, MCP server, REST API, Web UI)                                                                                                         | Privately to this project, see "Reporting a UniContext vulnerability"         |
| A vulnerability in an official connector or adapter (`connectors/*`, `packages/adapter-*`), for example a token leak, a bypass of the unofficial-API guidelines, unsafe handling of a response | Privately to this project, same channel                                       |
| A vulnerability in a university or vendor service (a student portal, an LMS, Microsoft 365, any third-party service UniContext talks to)                                                       | To the service owner. Do not publish it, and do not file it as a GitHub issue |

### Do not publish vulnerabilities in university services as GitHub issues

If, while building or testing a connector, you notice a weakness in a university system or in a vendor product (broken access control, exposed data, an unauthenticated endpoint, anything that would let someone read or change data that is not theirs), do not open a public GitHub issue, pull request, discussion or commit message about it, and do not add reproduction steps, requests or captured responses to fixtures, docs or tests. Publishing it exposes real students and staff before the owner can fix it.

Instead report it to the owner: the university's IT or information security office, or the vendor's security contact. In Japan, [IPA](https://www.ipa.go.jp/security/vuln/report/) and [JPCERT/CC](https://www.jpcert.or.jp/form/) accept vulnerability reports and coordinate with vendors. If you are unsure where it belongs, send it privately to this project and we will help route it. Test only with your own account and your own data, and stop as soon as you have shown the issue exists.

Connectors may use non-public APIs (see the unofficial API policy in the spec, section 27) only for data the signed-in user is authorized to see, with modest request rates, without circumventing authentication, never for other people's data, and without copying vendor code.

## Reporting a UniContext vulnerability

Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on the repository. Please include the affected version or commit, what an attacker needs (local access, a malicious web page, a malicious MCP client), reproduction steps and the impact. Do not include real student data, real tokens or cookies in the report.

Acknowledgement goal: within a few days. Fixes for confirmed issues are released with an advisory, and you are credited unless you prefer not to be.

## Threat model and design choices

- Local only. The daemon binds to `127.0.0.1`. Requests whose `Host` is not a loopback name are rejected (DNS rebinding), and so are requests with a non-loopback `Origin`. No CORS headers are sent.
- Write endpoints need a bearer token (OS keychain entry `daemon/api-token`; a `0600` file `daemon.token` in the data directory when no keychain exists) or, for the Web UI, a CSRF token (HttpOnly SameSite=Strict cookie + header) with a same-origin `Origin`.
- Secrets. Access tokens, refresh tokens, cookies and passwords are stored only in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). They are not stored in the SQLite database, in `config.yaml` (inline secrets are rejected at load time), in backups or in JSONL exports.
- Logging. All logs pass through a redactor that removes authorization headers, cookies, tokens, passwords, API keys, session ids, JWTs, OAuth `code=` parameters and the university's student ID pattern. Logs go to stderr and `logs/unicontextd.log` in the data directory.
- Read-only by default. Writes to external systems are never automatic. Changes made by AI clients are proposals that the user confirms. Task status `submitted` can only come from the submission system or the user, and enrolment changes, assignment submission and grade-related operations are not exposed at all.
- AI never owns truth. Model-generated facts are stored only as `extracted` or `inferred`, never as authoritative, and keep the evidence sentence.
- Telemetry is off and has no opt-in code path. Crash reports are not sent anywhere.
- The database is not encrypted by default; rely on full-disk encryption. A SQLCipher seam exists but no implementation ships.
- MCP clients are not trusted to confirm writes. `correct_fact` creates a pending proposal; the user approves it through the CLI or the Web UI.

## Supported versions

Only the latest 1.x release receives security fixes.
