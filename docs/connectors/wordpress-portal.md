# wordpress-portal (`@unicontext/wordpress-portal`)

Spec: §6, §12 (authority), §35/§36, §37 (rate limiting), §55. Research: [shizuoka.md](../research/shizuoka.md) §4.

## Purpose

A small, generic connector for university portals built on WordPress (the Shizuoka 学生教務ポータル
runs WordPress 5.2). It reads the public REST API (`<site>/wp-json/wp/v2/`) and the PDFs linked from
posts and from watched pages (faculty pages with 時間割 / 期末試験時間割 / 行事予定表 PDFs), and
stores them as university announcements, documents (searchable text per page) and handout materials.
The REST API is documented and public, so the connector is `apiStability: official`.

## Setup

No credentials.

```yaml
sources:
  portal:
    connector: wordpress-portal
    schedule: 1h # default
    deployment: shizuoka # built-in: baseUrl + label; or set baseUrl explicitly
    # baseUrl: https://portal.example.ac.jp/site/
    # label: 学生教務ポータル            # citation name, overrides the deployment label
    perPage: 20 # 1-100
    maxPages: 10 # post pages per run
    # categories: [1]                   # only these category ids
    pdf:
      followLinksInPosts: true # download PDFs linked from new/changed posts
      watchPages: # pages whose PDF links are watched on every run
        - https://wwp.shizuoka.ac.jp/acad-affairs-portal/student_e/inf # 情報学部 (example)
      maxSizeMb: 20
```

Which faculty page to watch depends on the student, so the Shizuoka deployment lists
`student_e/inf` only as an example (`shizuokaPortal.exampleWatchPages`); it is not applied
automatically. Settings are resolved as: source config > `profile.products['wordpress-portal']`
(`{deployment, baseUrl, label}`) > named deployment (`src/profiles/shizuoka.ts`).

| Key                                | Default | Meaning                                                                            |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `deployment` / `baseUrl` / `label` | -       | Site selection and display name.                                                   |
| `perPage`                          | `20`    | Posts per REST page.                                                               |
| `maxPages`                         | `10`    | Max pages per run (a warning is emitted and no `complete` for posts when cut).     |
| `categories`                       | all     | Category ids passed as `categories=` to `/posts`.                                  |
| `pdf.followLinksInPosts`           | `true`  | Follow `.pdf` links in post content.                                               |
| `pdf.watchPages`                   | `[]`    | Pages fetched each run (conditional GET with `If-None-Match`/`If-Modified-Since`). |
| `pdf.maxSizeMb`                    | `20`    | Larger PDFs are skipped (never retried).                                           |

The PDF text engine is injectable: `createWordpressPortalConnector({ pdfExtractor })` (default:
`unpdf`, text layer only, no OCR).

## Auth

None (`authenticate()` returns `not_required`).

## Sync behaviour

- **Posts:** WordPress 5.2 has no `modified_after`, so the request is
  `GET /posts?per_page=&page=&orderby=modified&order=desc&_fields=id,date,date_gmt,modified,modified_gmt,link,title,excerpt,content,categories`
  and paging stops at the first post whose `modified_gmt` is <= the cursor's `lastModified`.
  `X-WP-TotalPages` ends the listing (WordPress answers 400 `rest_post_invalid_page_number` past
  the end, handled too). Cursor: `{ lastModified, extra: { known, watch } }`.
- **Complete:** `initial`/`full` runs that read the whole listing set `complete` for `wp.post`, so
  deleted/unpublished posts are retired; incremental runs never do. `wp.category` is always `complete`
  (full list from `/categories`). `wp.pdf` is never `complete`: an older version stays available.
- **PDFs:** a PDF is downloaded only when its URL is new (`known` URL map in the cursor). A changed
  URL (the Shizuoka files are named by hash) is a new `wp.pdf` item; a re-uploaded file under the
  same URL is not detected. PDFs that are too large, not PDFs, or answer 4xx are remembered as
  skipped and not retried; 5xx/transient errors are retried next run. Requests go through the
  shared rate limiter, one at a time.
- Category names are resolved from `/categories` and added to the post payload as `categoryNames`
  (the only addition to the REST object); a renamed category shows up when the post is next fetched.

## Raw types

| Type          | externalId  | Payload                                                                                                                                        |
| ------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `wp.post`     | post id     | REST object (requested `_fields`) + `categoryNames?`                                                                                           |
| `wp.category` | category id | `{id, name, slug, parent, count, link}`                                                                                                        |
| `wp.pdf`      | PDF URL     | `{url, title (link text), foundOn, size, sha256, lastModified?, pages: [{page, text}]}`; the bytes are the raw item's blob (`application/pdf`) |

## Mapping

| Raw           | Canonical       | Notes                                                                                                                                                                                                                                                                                                                  |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wp.post`     | `announcement`  | `title` decoded from HTML entities, `body` = plain text of `content` (+ a `リンク:` list of non-PDF links), `publishedAt` = `date_gmt`+Z (site-local `date` as fallback), `category` = category names joined with `、`, `importance: high` when the title contains `【重要】`, `scope: university`, `url` = post link. |
| `wp.pdf`      | `document`      | `mimeType application/pdf`, `url`, `sizeBytes`, `contentHash` = sha256, `text`, `pageCount`, `modifiedAt` (Last-Modified), `extra.kind` = `timetable` / `exam-timetable` / `calendar` (from the link text: R8時間割 / 期末試験時間割 / 行事予定表), `extra.foundOn`.                                                   |
|               | `documentChunk` | One per non-empty page, `page`, `ref.location.page`.                                                                                                                                                                                                                                                                   |
|               | `material`      | `materialKind: handout`, linked to the document.                                                                                                                                                                                                                                                                       |
| `wp.category` | -               | Names only (resolved into posts).                                                                                                                                                                                                                                                                                      |

All entities have `ref.url` and `ref.authority = university-portal`; `ref.sourceLabel` is the
configured/deployment label (e.g. 学生教務ポータル).

**Authority:** `university-portal` is not one of the strings in `KNOWN_AUTHORITIES` /
`default-rules.yaml`, which is fine (authority is a free-form string and this connector emits no
facts, only announcements and documents). It would rank with the "default" list only if a rule
mentioned it. No foundation change is needed.

## Metadata

`defaultSchedule: 1h`, `apiStability: official`, `risk: supported`, `defaultAuthority:
university-portal`, `sourceLabel: 大学ポータル` (overridden per source by `label`), capabilities
`announcements`, `materials`, `files`.

## Limits and known issues

- No OCR: scanned PDFs yield empty pages (the document is still stored). Extraction failures are warnings.
- Posts older than `maxPages * perPage` are not fetched on the first run.
- Two posts modified in the same second as the cursor after a run are missed (`<=` comparison).
- Only `a[href$=".pdf"]` links are followed (not iframes/embeds, not links without the extension).
- Protected posts (`content.protected`) are stored as returned (the API hides their content).
