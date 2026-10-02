# @unicontext/web

Localhost Web UI for UniContext: React 19, Vite 8, TanStack Router (code-based routes, browser history).

- `pnpm --filter @unicontext/web build` type-checks and writes `apps/web/dist` (base `/`). The daemon serves it and falls back to `index.html` for non-`/api` paths.
- `pnpm --filter @unicontext/web dev` starts Vite on 127.0.0.1:5173 and proxies `/api` and `/mcp` to `http://127.0.0.1:17878`.
- Wire types are imported type-only from `@unicontext/daemon/api-types`; no `@unicontext/*` code is bundled.
- Pure logic (dates, labels, change diffs, URL safety, grouping, week grid) lives in `src/lib` and is tested with `npx vitest run apps/web`.

## Routes

| Route                                  | Endpoints                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/`                                    | `GET /api/v1/today`                                                                                  |
| `/courses`, `/courses/$id`             | `GET /api/v1/courses`, `GET /api/v1/courses/:id`, `POST /api/v1/identity/confirm\|reject`            |
| `/assignments`                         | `GET /api/v1/assignments`                                                                            |
| `/calendar`                            | `GET /api/v1/week`                                                                                   |
| `/announcements`, `/announcements/$id` | `GET /api/v1/announcements[?unreadOnly=1]`, `GET /api/v1/announcements/:id`                          |
| `/changes`                             | `GET /api/v1/changes`                                                                                |
| `/search?q=`                           | `GET /api/v1/search?q=`                                                                              |
| `/sources`                             | `GET /api/v1/sources`, `POST /api/v1/sources/:id/sync`                                               |
| `/conflicts`                           | `GET /api/v1/conflicts`, `POST /api/v1/facts/:id/correct`                                            |
| `/settings`                            | `GET /api/v1/settings`, `/notifications`, `/proposals`, `POST /api/v1/proposals/:id/confirm\|reject` |

All screens also use `GET /api/v1/admin` (nav badges) and `GET /api/v1/source-refs/:id` (出典 panel). Writes fetch `GET /api/v1/session` and send `X-CSRF-Token`; a 403 refetches the token once.
