# Contributing to UniContext

Thank you for helping. UniContext is a local-first context layer for university life; read [docs/SPEC.md](docs/SPEC.md) (what we build) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (the APIs everything builds on) first.

## Setup

Requirements: Node.js 22.12+, pnpm 11.

```sh
pnpm install
pnpm build        # tsc -b over all packages, then the Web UI (Vite)
pnpm test         # vitest
pnpm lint         # eslint
pnpm format       # prettier --write
pnpm check        # build + type-check tests + lint + test
```

Tests resolve `@unicontext/*` to TypeScript sources, so `pnpm test` does not need a build. Run one file with `npx vitest run apps/cli`.

## Ground rules

- TypeScript, ESM only, `strict` with `noUncheckedIndexedAccess`. Relative imports end in `.js`. No `any` in public APIs. Validate external input with zod.
- Keep the data flow: connector -> raw store -> normalizer -> canonical model -> facts/conflicts/tasks -> context engine -> MCP / REST / CLI / Web. Normalizers read only the raw store, so a bug fix can be re-run without contacting a university.
- Never use a real university in tests or CI. Fixtures must be sanitized (no names, student IDs, tokens, cookies, real course data that identifies a person). Tests use the fake connector and the synthetic seed from `@unicontext/connector-sdk`.
- No secrets in the database, config or logs. Use the `SecretStore` and the core logger (it redacts). Do not add telemetry.
- University-specific values belong in a deployment profile (`profiles/<id>/profile.yaml`), not in core code. Product logic belongs in the product's connector.
- Writes are propose -> confirm -> execute. Do not add automatic writes to external systems, and nothing that submits work, changes enrolment or touches grades.
- UI text is Japanese, with no spaces between Japanese and alphanumerics, and no explanatory filler. Do not hand-roll replacements for standard controls.

## Adding a connector

See "Writing a connector" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): define metadata (declare `apiStability` and `testedVersion` for unofficial APIs), implement `SourceAdapter` and `Normalizer`, export `defineConnector(...)` as the package default, and run `testConnectorCompliance` in your tests. The daemon loads connectors by package name from `sources:` in `config.yaml` (see `apps/daemon/src/registry.ts`).

Connectors that use non-public APIs must follow the unofficial API policy (spec section 27): only the signed-in user's own authorized data, modest request rates, no authentication circumvention, no vendor code copied.

## Reporting security problems

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md); in particular, never publish vulnerabilities found in university or vendor services.

## Pull requests

- One logical change per PR, with tests. `pnpm check` must pass.
- Do not edit an already-shipped database migration; append `00N_<name>.ts` (see ARCHITECTURE section 3.3).
- Keep commit messages short and in the imperative ("Add deadline extractor for 次回まで").
- By contributing you agree your work is licensed under the MIT license of this repository.
