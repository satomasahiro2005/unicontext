# local-files (`@unicontext/local-files`)

Spec: §23 (Local files), §14 (identity), §6 (raw first), §35/§36 (sync, schedule), §55 (metadata).

## Purpose

Watches the folders where the student keeps course files (default `~/University`), extracts text
and metadata, and stores them as `Document` / `DocumentChunk` / `Material` entities so slides,
handouts and notes are searchable (FTS5) and show up in the course and lecture views. The course
is inferred from the folder name; the identity resolver then relates that folder-based course to
the LCU/Teams offering (§14).

Nothing leaves the machine: the connector only reads local files. Absolute paths are stored in
`Document.path`/`url` (the user's own machine) but never in titles.

## Setup

1. Put course files under a root, e.g. `~/University/2026前期/データベースシステム論/第3回.pdf`.
2. Add the source to `config.yaml` (no credentials are needed).
3. `unicontext sync local-files` (or let the daemon run it; it also calls `watch()` for live updates).

```yaml
sources:
  local-files:
    connector: local-files
    adapter: filesystem
    schedule: 30m # default; watch() gives immediate updates on top
    roots: # "~" is expanded by core; default: ~/University
      - ~/University
      - ~/Documents/lectures
    include: [] # globs; empty = everything
    exclude: ['.*', node_modules, '~$*', '*.tmp', '*.crdownload', '*.part', Thumbs.db, desktop.ini]
    maxFileSizeMb: 50 # larger files are listed as metadata only
    chunkSize: 1200 # characters per DocumentChunk
    chunkOverlap: 120
    courseFolderDepth: 1 # which non-term folder below the root is the course
    termFolderPattern: '^(?:(?:(?:19|20)\d{2}|[RrＲ令]和?\s?\d{1,2})…)$' # default shown abridged
    watch: true
    pageSize: 50 # files per sync page
    watchDebounceMs: 1000
    watchStabilityMs: 500 # awaitWriteFinish threshold
```

All keys are optional. Glob syntax: `*` (no `/`), `**` (any depth), `?`, case-insensitive. A pattern
without `/` matches a file name (include) or any path segment (exclude, so `node_modules` prunes
the folder); a pattern with `/` is matched against the path below the root.

## Auth

None (`authenticate()` returns `not_required`). Health is `healthy` when every root exists,
`degraded` ("Root directory not found") otherwise.

## Sync behaviour

- `initial` and `full` re-extract every file. `incremental` diffs against a manifest.
- Manifest: `path -> {size, mtimeMs, hash(sha256)}`, persisted as `manifest.json` in
  `ctx.cacheDir` (in memory when no cacheDir; not in the sync cursor). A file whose size and mtime
  are unchanged is skipped without being read; if they differ the content hash is checked, so a
  `touch` or a re-save with identical content emits nothing.
- Removed files become explicit `deletions` (the engine soft-deletes the raw item and its
  entities). `complete` is never set, because unchanged files are intentionally not re-sent.
- Files of a root that is currently unreachable (unplugged drive) are kept, not deleted; files of
  a root that was removed from the config are deleted.
- Large sets are paged (`pageSize`, `hasMore` / `nextPageToken`); the first page also carries the
  deletions and warnings. One corrupt file is a warning (the file is still listed with
  `note`), never a failed sync.
- `watch(listener)` (WatchableAdapter): chokidar on the roots (`ignoreInitial`, `awaitWriteFinish`),
  events are debounced (`watchDebounceMs`, via the injected Clock) into one `SyncResult` with the
  changed items and deletions and handed to `listener.onResult` (the daemon feeds it to
  `SyncEngine.ingest`). Sync and watch share the manifest and are serialized.

## Extraction

| Type                                                                         | How                                                                                                    | Payload                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| PDF                                                                          | `unpdf` `extractText` per page                                                                         | `pages: [{page, text}]`                   |
| DOCX                                                                         | `mammoth.extractRawText`                                                                               | `text`                                    |
| PPTX                                                                         | `jszip`: slide order from `presentation.xml`, `<a:t>` text per slide, title placeholder, speaker notes | `slides: [{slide, title?, text, notes?}]` |
| txt, md, csv, json, yaml, source code (`py js ts java c cpp go rs sh sql …`) | utf-8, BOM stripped; UTF-16 by BOM; Shift_JIS fallback                                                 | `text`                                    |
| html / htm                                                                   | tags, scripts, styles removed, entities decoded, `<title>` first                                       | `text`                                    |
| png jpg jpeg gif webp heic                                                   | `image-size` dimensions, `exifr` DateTimeOriginal                                                      | `image: {width, height, takenAt?}`        |
| anything else (mp4, m4a, xlsx, …)                                            | metadata only                                                                                          | –                                         |

`extractPptx`, `pptxSlidePaths` and `relTargets` are exported: `get_document` (context-engine
`render/pptx.ts`) reuses the slide text and reads the slide's `ppt/media/*` images itself. Files
inside a configured root can be opened by path through `get_document` (a path outside the roots is
refused).

Extracted text is capped at 2,000,000 characters per file; `Document.text` at 100,000 (the chunks
cover the whole text).

## Raw type

`file.document` (externalId `<rootKey>:<relativePath>`, `rootKey` = first 8 hex chars of
sha256 of the absolute root):

```json
{
  "root": "/home/u/University",
  "relativePath": "2026前期/データベースシステム論/第3回.pdf",
  "name": "第3回.pdf",
  "ext": "pdf",
  "mimeType": "application/pdf",
  "size": 12345,
  "mtime": "2026-10-01T00:00:00.000Z",
  "hash": "<sha256>",
  "pages": [{ "page": 1, "text": "…" }],
  "courseFolder": "データベースシステム論",
  "termFolder": "2026前期"
}
```

`text`, `slides`, `image`, `note` are present depending on the type. The course folder is the
`courseFolderDepth`-th folder below the root that does not match `termFolderPattern` (default:
`2026`, `2026年度`, `2026前期`, `2026-1`, `2026_後期`, `R8後期`, `令和8年度`, `前期`/`後期`); the first
matching folder is kept as `termFolder`.

## Mapping (raw → canonical)

Authority: `local-file` (source label `ローカルファイル`). No facts are derived.

| Canonical                                            | From                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `courseOffering` (when a course folder exists)       | `title` = folder name; `academicYear` from the term folder (`2026前期`, `R8後期`=2026) or a year in the folder name; `term` 前期/後期 when the term folder says so. Id = `ctx.id('courseOffering', normalizeCourseTitle(folder), year)`                                          |
| `document`                                           | `title` = file name; `mimeType`, `path` (absolute), `url` (`file://`), `sizeBytes`, `contentHash`, `text`, `pageCount` (PDF pages / PPTX slides), `modifiedAt`, `courseOfferingId`; `extra`: `relativePath`, `ext`, `lectureDate`, `courseFolder`, `termFolder`, `note`, `image` |
| `documentChunk`                                      | page-aware for PDF (`page`), slide-aware for PPTX (`page` = slide number, `heading` = slide title or `Slide N`, notes appended), heading-aware for Markdown, plain otherwise; `ordinal`; `ref.location.page`                                                                     |
| `material` (course known)                            | `materialKind`: pptx/ppt/key → `slides`, pdf → `handout`, mp4/m4a/mov/mp3/wav… → `recording`, source code → `code`, else `other`; linked to the document, the offering and the lecture (if any)                                                                                  |
| `lecture` (course known and a date in the file name) | `date` from `2026-10-01`, `20261001`, `2026年10月1日` or `10月1日` (year from the academic year / file mtime); lets the context engine attach the material to that day's class session                                                                                           |

`document.extra.lectureDate` carries the same date hint even without a course.

## Schedule

`defaultSchedule: 30m` (cheap diff) plus `watch()` for immediate updates. The engine's periodic
`full` run (weekly) re-extracts everything.

## Limits and known issues

- Identity linking: the folder-based offering only has title, year and (sometimes) term as
  evidence, which scores at most 0.60 in `scoreOfferingMatch`; the auto-link threshold is 0.75, so
  the link to the LCU/Teams offering is created as `suggested` and needs `identity.confirm` (or a
  resolver change) before the slides appear in that course's lecture view.
- Scanned PDFs without a text layer yield empty pages (no OCR). Password-protected PDFs and
  corrupt files produce a warning and a metadata-only document.
- `.doc`, `.ppt`, `.xls`, Keynote files are metadata only. PPTX text inside grouped shapes is
  included; text in embedded charts/SmartArt is not.
- Files above `maxFileSizeMb` get a metadata-only document with a size/mtime based `hash`.
- The first sync of a very large tree reads every file once (hashing + extraction); later runs
  only stat files.
- Symbolic links to folders are not followed.
