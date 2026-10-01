# @unicontext/livecampusu

LiveCampusU / LCU-Web connector (unofficial API): browser SSO login (adapter-browser), read-only
plain-HTTP replay of the student's own screens. See
[docs/connectors/livecampusu.md](../../docs/connectors/livecampusu.md).

- `src/core/` — product logic: HTTP session (serial queue, tokens, PRG, re-auth), hard-coded
  denylist, parsers, raw schemas, normalizer, sync orchestration.
- `src/auth/` — `browser-sso` strategy and the `local-account` stub.
- `src/profiles/` — deployment profiles (`shizuoka`).
