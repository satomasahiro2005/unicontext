# adapter-rest (`@unicontext/adapter-rest`)

`RESTSourceAdapter` for services with an **OpenAPI** document (SPEC §30). It parses the document
into an operation catalog, executes `GET` operations named by a YAML [mapping](mapping.md) and
normalizes the JSON into canonical entities. It can also draft a mapping skeleton from the
catalog (the "tool candidates" of §30).

Stability: `apiStability: experimental`, `risk: experimental`. Default schedule `15m`; product and
capabilities come from the mapping.

## Read-only

Only `GET` operations are executed (SPEC §50). A mapping that names a `POST`/`PUT`/`PATCH`/
`DELETE` operation fails with `PolicyViolationError` before any request is made, and `health()`
reports such mappings as `degraded`. Request bodies are never sent.

## Setup

```yaml
# config.yaml
sources:
  lms:
    adapter: rest
    url: https://lms.example.ac.jp/api/v1 # base URL (default: servers[0].url of the document)
    openapi: ./lms-openapi.yaml # path | http(s) URL | inline JSON/YAML text | inline object
    auth:
      type: bearer # none | bearer | header | basic
      secret: lms-token # SecretStore entry "<sourceId>/lms-token"
    headers: { Accept-Language: ja } # optional literal, non-secret headers
    healthPath: /me # optional GET requested by health()
    timeoutMs: 30000
    mapping: ./lms-mapping.yaml # path | inline | name of a shipped mapping
    schedule: 15m
```

1. Put the token in the SecretStore (`secretKey('lms', 'lms-token')`).
2. Generate a starting point: `suggestMappingYaml(await adapter.catalog(), {id: 'lms'})`
   (see below), then add `entities:` rules.
3. Run a sync. Rate limiting and retries come from `createHttpClient` with the context's
   `RateLimiter` (§37): 429/503 honour `Retry-After`, 5xx are retried with backoff.

## Config keys

| Key          | Meaning                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`        | Base URL; path prefixes (`/v1`) are kept. Required unless the document has an absolute `servers[0].url` (or Swagger `host`+`basePath`).                                                               |
| `openapi`    | OpenAPI 3.x or Swagger 2.0, JSON or YAML. A URL is fetched **without** the API credentials. Optional: a resource can use `call.path` instead of `call.operation`.                                     |
| `auth.type`  | `none`; `bearer` (`Authorization: Bearer <secret>`); `header` (`<auth.header or X-API-Key>: <prefix><secret>`); `basic` (the secret holds `user:password`). `auth.prefix` overrides the value prefix. |
| `headers`    | Literal non-secret headers; credential-looking names are rejected.                                                                                                                                    |
| `healthPath` | Path requested by `health()` (non-2xx → `degraded`).                                                                                                                                                  |
| `timeoutMs`  | Per request (default 30000).                                                                                                                                                                          |
| `mapping`    | See [mapping](mapping.md).                                                                                                                                                                            |

The secret is read from `ctx.secrets` for every request and never appears in raw payloads, logs
or errors.

## Resource `call`

```yaml
call:
  operation: listAssignments # operationId (or the synthesized id) from the catalog
  # path: /courses                    # alternative: a literal GET path, no OpenAPI needed
  params: # templated; path/query/header per the operation's parameters
    courseId: '{{course.id}}'
    state: [active, invited] # arrays: repeated keys (explode) or comma separated per the spec
  paginate: { type: cursor, param: cursor, next: next_cursor }
```

Undeclared parameter names are sent as query parameters. Path values are percent-encoded.

| `paginate.type`                             | Behaviour                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `link-header` (`rel`, default `next`)       | Follows `Link: <url>; rel="next"`; a link to another origin is refused.                                                              |
| `cursor` (`param`, `next`)                  | `next` is JSONata on the body; its value is sent as query parameter `param` until it is empty.                                       |
| `page` (`param`, `start`, `size?`, `items`) | Counts pages from `start`; stops at an empty page or one shorter than `size`. `items` is JSONata for the page's items (default `$`). |

## Operation catalog and suggestions

```ts
const adapter = new RESTSourceAdapter({...});
await adapter.catalog();
// [{operationId, method, path, summary, description, tags, parameters: [{name, in, required,
//   schema, explode}], responseSchema, hasRequestBody, deprecated}]

buildOperationCatalog(doc);        // same, from a parsed document
suggestMapping(catalog, {id, product, defaultAuthority}); // {spec, skipped}
suggestMappingYaml(catalog, {id}); // YAML with a header comment and "# skipped ..." notes
```

- Local `$ref`s (parameters, schemas, path items) are resolved; circular schemas are cut with
  `{type: object, "x-circular": "#/..."}`; path-level parameters are merged; operation ids are
  synthesized (`GET /courses/{courseId}/announcements` → `getCoursesByCourseIdAnnouncements`).
- `suggestMapping` considers `GET` operations only: those without required parameters become
  resources (`select` points at the array in the response schema, `externalId` at an `id`-like
  property); `GET /things/{thingId}/children` becomes a fan-out over the list of `/things`; the
  rest are reported in `skipped` with the reason. Capabilities are guessed from names and tags.
  The skeleton has no `entities`: it says what _can_ be fetched, you decide what it means.

## Health

`healthy` when the document loads, every mapped operation exists and is GET, and `healthPath`
(if set) answers 2xx (`detectedVersion` = `info.version`). `degraded` for missing / non-GET
operations or a failing `healthPath`; `offline` for network errors; `auth_required` for a missing
secret or HTTP 401; `failed` when the document cannot be read.

## Raw types and mapping

The raw types and the canonical mapping come entirely from your mapping file; the package ships no
service-specific mapping. [mapping.md](mapping.md) is the reference, and
`packages/adapter-rest/test/fixtures/lms-mapping.yaml` (courses by Link-header pagination,
assignments by cursor pagination, fan-out per course) is a working example. Unknown product versions (`info.version` not in `testedVersion`) make the source
`degraded` (§72).

## Limits and known issues

- GET only; no request bodies, cookies or OAuth flows (use `bearer`/`header`/`basic` with a stored
  token). Cookie parameters are rejected.
- External `$ref`s are not resolved; unresolved ones stay as `{ $ref }` / `x-unresolved`.
- Responses must be JSON (an empty body or HTTP 204 yields no items).
- Every sync is a full relist; there is no ETag / `If-Modified-Since` support yet.
