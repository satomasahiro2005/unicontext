# Mapping (`@unicontext/mapping`)

The one declarative mechanism shared by the MCP, CLI and REST adapters (SPEC §4, §28-30). A YAML
file (or an object) says **how to fetch** (`resources`), **how to normalize** (`entities`, `facts`)
and **what shape to expect** (`drift`). Everything that computes a value is a
[JSONata](https://jsonata.org) expression. The adapters only differ in the `call:` block of a
resource; fetching, fan-out, paging, `complete` handling, normalization and drift detection are
shared code.

```
resources ──(adapter-specific call)──▶ raw items ──▶ entities / facts ──▶ canonical model
```

## Using it

```ts
import {
  parseMappingSpec,
  loadMappingFile, // YAML text / object / file → validated MappingSpec
  createMappedNormalizer, // MappingSpec → Normalizer (entities, facts, drift)
  runMappedResources, // MappingSpec + ResourceCaller → SyncResult page
  createMappedAdapter,
  MappedSourceAdapter, // build a SourceAdapter around a ResourceCaller
  mappingMetadata, // MappingSpec → ConnectorMetadata (§55, experimental)
  resolveMapping, // config `mapping:` (path | shipped name | inline) → spec
} from '@unicontext/mapping';
```

`parseMappingSpec` throws `ConfigError` with every problem (unknown keys, JSONata syntax errors,
unknown canonical fields, dangling `forEach`, ...) so a bad mapping fails when it is loaded, not on
the first sync. `loadMappingFile` is synchronous because connector factories are synchronous.

A new transport only implements `ResourceCaller.call({resource, call, signal}) → {data, next?,
productVersion?, warnings?}`:

- `call` is `resource.call` with every `{{...}}` rendered,
- `data` is the parsed result (JSON) that `select` is applied to,
- `next` is the pagination hook: the rendered call that fetches the next page of this resource.

## Top level

| Key                          | Meaning                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `product`              | Mapping id and the source system name used in citations. Required.                                                                                                                                   |
| `sourceLabel`, `description` | Display name (`Canvas`) / free text.                                                                                                                                                                 |
| `version`                    | Bump when the _meaning_ changes (default `1`). The normalizer version is `<version>.<hash of entities/facts/drift>`, so editing the mapping re-normalizes stored raw items (`SyncEngine.reprocess`). |
| `defaultAuthority`           | Authority of everything from this source unless a rule overrides it (`lms`, `discussion`, ...).                                                                                                      |
| `capabilities`               | Non-empty list of canonical capabilities (`courses`, `assignments`, ...).                                                                                                                            |
| `testedVersion`              | Product version the mapping was written for (§27, §72).                                                                                                                                              |
| `resources`                  | Fetch recipes, in dependency order.                                                                                                                                                                  |
| `entities`                   | `{<sourceType>: [rule, ...]}`: raw item → 0..n canonical entities.                                                                                                                                   |
| `facts`                      | Explicit facts (value, evidence, validity) from raw items.                                                                                                                                           |
| `drift`                      | Mini schema per source type for schema drift detection (§73).                                                                                                                                        |
| `strictDrift`                | Also report fields not listed in `drift` (default `false`).                                                                                                                                          |
| `vars`                       | Named constants for expressions (`$vars.region`), e.g. a per-account web host. A source config overrides declared ones with `mappingVars: {region: us}`; undeclared names are config errors.         |

Unknown keys are errors everywhere (typos should not pass silently).

## `resources`

```yaml
resources:
  - name: courses # identifier
    call: { tool: list_courses, args: { enrollment_state: active } }
    select: '$' # JSONata on the parsed result → items (default "$")
    sourceType: canvas.course # raw item type
    externalId: '$string(id)' # JSONata on the item → stable id in the source
    updatedAt: updated_at # optional → RawItem.sourceUpdatedAt
    complete: true # full listing: unseen items of this type are marked deleted
  - name: assignments
    forEach: { resource: courses, as: course, where: 'published = true' }
    call: { tool: list_assignments, args: { course_id: '{{course.id}}' } }
    sourceType: canvas.assignment
    externalId: '$string(id)'
    attach: { courseId: 'course.id' } # stored under payload._parent
    capability: assignments # only fetched when requested
    optional: true # a failing call is a warning, not an error
```

| Key          | Notes                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `call`       | Adapter specific, templated (see below). MCP `{tool, args, paginate?}`, CLI `{args, stdin?, format?, ...}`, REST `{operation \| path, params, paginate?}`.                                                                                                                                                         |
| `select`     | The result of `call` may be an array, an object holding the array (`select: items`), or a single object (becomes one item). `undefined` means no items.                                                                                                                                                            |
| `externalId` | Must produce a string or number; items without one are skipped with a warning. Duplicate `(sourceType, externalId)` within a page are dropped.                                                                                                                                                                     |
| `complete`   | Sets `SyncResult.complete.sourceTypes` on the last page, **only** if every call of the resource succeeded (a failed fan-out child, a skipped capability or a truncated pagination withholds it, so a partial listing never deletes data). Every sync is a full relist; there is no incremental cursor.             |
| `forEach`    | Fan out: one call chain per item of an _earlier_ resource. `as` names the variable in templates and `attach`; `where` is a JSONata filter on the parent payload (e.g. only threads with replies). Nesting works to any depth; a parent's `_parent` is visible to its children (`{{assignment._parent.courseId}}`). |
| `attach`     | JSONata evaluated in the fan-out scope; results are stored in the raw payload as `_parent` so normalization stays a pure function of the stored raw item. Only for object items.                                                                                                                                   |
| `capability` | The resource is skipped when `SyncInput.capabilities` is set and does not include it.                                                                                                                                                                                                                              |
| `optional`   | Failure of a top-level resource becomes a warning (and withholds `complete`) instead of failing the sync. Failures of fan-out children are always warnings. `AuthRequiredError`, `RateLimitedError`, `OfflineError` and aborts always fail the run.                                                                |

### Templates

Inside `call`, `{{ <JSONata> }}` is evaluated against the fan-out scope (`{<as>: parentPayload}`).
A string that is exactly one placeholder keeps the evaluated type (`"{{course.id}}"` → number
`101`); inside a longer string values are stringified (`"id-{{course.id}}"`). An unresolved
placeholder is an error (never silently empty). CLI arguments additionally refuse a
whole-argument placeholder whose value starts with `-` (option injection).

### Paging and large fan-outs

`ResourceResponse.next` (set by the adapter from `call.paginate`) continues one call chain. When a
page used `maxCallsPerPage` calls (default 25) the runner returns `hasMore` with a
`nextPageToken`: JSON `{r: resource index, f: fan-out index, n?: pending call, x?: incomplete
types}`. The token survives a restart: parent items are cached per adapter instance and fetched
again if the cache is empty. Credential-like keys are stripped from payloads (see below).

## `entities`

```yaml
entities:
  canvas.assignment: # raw sourceType
    - kind: assignment # canonical kind
      key: '$string(id)' # → ctx.id(kind, key); default: the raw externalId
      when: 'published = true' # optional filter
      forEach: 'items' # optional: one entity per element ($ = element, $root = payload)
      fields:
        title: name # JSONata
        dueAt: due_at # coerced to ISO with offset (see below)
        points: 10 # numbers/booleans are constants
        platform: { const: canvas } # constant (any JSON)
        description: { expr: '$trim(body)', as: string } # explicit coercion
        courseOfferingId: { ref: courseOffering, key: '$string(_parent.courseId)' }
        instructorIds: { ref: person, keys: 'teachers.id' } # list of references
      extra: { rawState: workflow_state } # entity.extra
      ref: # provenance
        url: html_url
        authority: submission-system # literal, or { expr: "role = 'staff' ? 'a' : 'b'" }
        sourceLabel: Canvas
        sourceItemId: '$string(id)'
        location:
          { page: ..., timestamp: ..., timestampMs: ..., messageId: ..., line: ..., selector: ... }
      origin: authoritative # origin of auto-derived facts
      deriveFacts: true
```

- One raw item can yield several entities (several rules, or `forEach`). Rules whose `when` is
  falsy produce nothing.
- `fields` names are checked against the canonical schema when the mapping is loaded.
  `id`, `kind` and `extra` are set by the mapper.
- **References** produce `ctx.id(ref, key)`: the same function other mapped items use, so ids line
  up across raw types and reprocessing is idempotent. A reference whose key is empty is dropped.
- **Coercion** is driven by the canonical field type: instants become ISO-8601 with offset
  (strings that already carry an offset keep it; bare local datetimes and dates are interpreted in
  `ctx.timezone`; numbers are epoch seconds/milliseconds; other date formats are parsed by
  `Date`), local dates (`date`, `startsOn`, `endsOn`) become `YYYY-MM-DD`, numeric strings become
  numbers, scalars become one-element arrays for array fields. A value that cannot be converted is
  dropped with a warning. `{expr, as}` forces `string | number | boolean | datetime | date | array`.
- `null`/`undefined` results are dropped (the canonical schemas have no nulls).
- Every entity is validated with the canonical zod schema; an invalid one is **skipped with a
  warning** in `NormalizeOutput.warnings` (it never throws). Expression runtime errors are warnings
  too and only drop that field.
- Credential-like keys in `extra` are removed with a warning.

## `facts`

```yaml
facts:
  - sourceType: canvas.announcement
    when: '$contains(message, /\d+教室/)'
    subject: { ref: courseOffering, key: '$string(course_id)' }
    predicate: room
    value: '$match(message, /(\d+)教室/)[0].groups[0] & "教室"'
    origin: extracted # authoritative | extracted | inferred (default authoritative)
    confidence: 0.8
    evidence: message # the sentence the claim comes from
    observedAt: posted_at # validFrom / validUntil take dates too
    ref: { authority: instructor-announcement, url: html_url }
```

`value` is any JSON (undefined skips the fact). AI-produced values never come from the mapping.

## `drift`

```yaml
drift:
  canvas.course:
    id: number
    name: string
    'course_code?': 'string|null' # trailing ? = optional, | = union
    'term?': { name: string } # nested objects
    tags: [string] # array of
```

Types: `string number boolean null any date`. The result goes to `NormalizeOutput.drift`
(`missing`, `type_mismatch`, and `unknown` only with `strictDrift: true`), which the sync engine
records and uses to degrade health (§73). List the fields the mapping depends on, not every field.

## Credential guard

The runner removes keys matching `DEFAULT_SENSITIVE_KEY_PATTERN` (token, password, cookie,
authorization, api key, session id, student id, ...) from every raw payload and from `extra`
(only keys holding a non-empty string, number or object; `has_token: false` stays) and adds a
warning. Raw items never contain credentials; credentials only travel through `ctx.secrets`.

## JSONata notes

- Variables: `$root` (the whole payload, useful inside `forEach`), `$tz`, `$sourceId`,
  `$externalId`, `$vars` (the mapping's `vars` after `mappingVars`).
- Calendar functions (university profile): `$profileTerm(label, year)` maps an external term label
  ("Semester 2", "S2", "Spring", 第2学期, 後期) of an academic year onto the university's term name
  (後期) through the academic calendar, and returns nothing for a label that is not a term (an Ed
  placeholder such as "X"). `$profileTermAt(date)` gives `{year, term}` of the term containing a
  date.
- `a != b` with a missing `a` is **false** in JSONata, not true: write `$not(a = b)`.
- A path that matches one element returns the element, not a one-element array; use `select`
  with an array path or wrap with `[]` where it matters (`items[]`).
- Use single-quoted YAML scalars for expressions containing `"` or `\` (regexes).
- `$now()`/`$millis()` make normalization non-deterministic; avoid them.

## Limits

- Fetching is read-only and always a full relist (`mode` is ignored; no incremental cursors).
- One adapter call per fan-out item: very large fan-outs are slow; filter with `forEach.where`.
- Not supported: request bodies, writes (§50), per-field provenance beyond `ref`.
