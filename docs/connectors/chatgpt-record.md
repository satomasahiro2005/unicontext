# chatgpt-record (`@unicontext/chatgpt-record`)

Spec: §22 (ChatGPT Record), §21 (Lecture model), §20 (deadline extraction), §14, §35/§36, §55.

## Purpose

Imports lecture transcripts as `Lecture` / `LectureTranscript` / `LectureSegment` entities with
timestamp citations ("ChatGPT Record 00:42:18 10/1 15:00取得"), so questions such as 「先生は試験に
ついて何て言った？」 can be answered from the lecture, and deadlines mentioned out loud become tasks.

No public ChatGPT Record API is assumed. The official paths are files: a manual import, a watched
folder, and export import. Internally everything goes through a generic `TranscriptImporter`
(format registry), so Zoom, Whisper, Teams or YouTube caption exports use the same entry point.

## Setup

Three ways in (all produce the same raw type):

1. Manual import. The CLI calls the adapter and hands the result to the engine:
   ```ts
   const res = await adapter.importFile('~/Downloads/lecture.vtt', {
     courseHint: 'データベースシステム論',
     date: '2026-10-01',
     title: '第3回',
   });
   await engine.ingest('chatgpt-record', res);
   const res2 = await adapter.importText(pastedText, { fileName: 'memo.txt' });
   ```
   Options: `courseHint`, `date` (`YYYY-MM-DD` or ISO), `title`, `importer`, `format`.
2. Watched folder (`watchDir`, default `~/University/Records`). Layout:
   `Records/<course>/<date>.vtt`, optionally `Records/2026前期/<course>/…`.
3. `sync()` scans the folder (manifest diff) on the schedule; `watch()` reacts to new files.

```yaml
sources:
  chatgpt-record:
    connector: chatgpt-record
    adapter: filesystem
    schedule: 30m
    watchDir: ~/University/Records # default
    watch: true
    extensions: [txt, md, vtt, srt, json]
    importer: chatgpt-record # value of LectureTranscript.importer (e.g. zoom)
    maxFileSizeMb: 20
    termFolderPattern: … # term folders skipped for the course hint (2026前期, R8後期 …)
    pageSize: 50
    watchDebounceMs: 1000
    watchStabilityMs: 500
```

## Auth

None. Health is `degraded` when `watchDir` does not exist (manual import still works).

## Formats (`TranscriptImporter`)

Every parser yields `{title?, recordedAt?, courseHint?, language?, segments: [{startMs, endMs?,
speaker?, text}], hasTimestamps}`; timestamps are milliseconds.

| Format  | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.txt`  | Lines prefixed by `[hh:mm:ss]`, `hh:mm:ss`, `mm:ss`, `Speaker 1 (00:01:23):`, or the two-line `Speaker 1  00:01:23` + text layout; optional `話者:`/`先生:` speaker labels; non-timestamped lines continue the previous segment (a file with no timestamps at all becomes one segment per line at 0, `hasTimestamps: false`). Header lines before the text: `[course: …]`, `授業:`/`科目:`/`講義:`, `title:`/`タイトル:`, `date:`/`日時:`, `language:`                                                                                                                                                                 |
| `.md`   | Same line forms; headings are skipped and the first one is the title; list bullets, quotes and `**bold**` are stripped; YAML-like front matter (`course:`, `date:` …)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `.vtt`  | WebVTT cues, `<v Name>` voice tags (Zoom-style `Name: text` cues are split when most cues have the prefix), `Language:` header, `NOTE`/`STYLE` blocks and cue markup ignored                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `.srt`  | numbered cues with `00:00:01,000`, list dashes and tags stripped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `.json` | generic heuristic: root array or the first array of objects found under `segments`, `transcript`, `utterances`, `results`, `items`, `captions`, `entries`, `cues`, … (nested up to 3 levels); text from `text`/`content`/`transcript`/`words[]`; start from `startMs`/`start_ms`/`start`/`start_time`/`begin`/`offset`/`timestamp`, end from `endMs`/`end`/`end_time`/`duration`; bare numbers are seconds (Whisper) unless they are integers above 86400 (then milliseconds); `"hh:mm:ss"` strings accepted; `speaker`/`speaker_name`/`name`/`role`; root metadata `title`, `language`, `course`, `recordedAt`/`date` |

Add a format with `new TranscriptImporter().register({id, extensions, importer?, parse})`.

### recordedAt, course hint, title

- `recordedAt`: explicit `date` option, else the content metadata (header/front matter/JSON field),
  else the file name (`2026-10-01 10-40`, `2026-10-01_10-40`, `20261001_1040`, `2026-10-01T10:40`,
  `2026年10月1日 10時40分`; date only = 00:00 local), else the file mtime (pasted text: now). A
  date-only option keeps the time of day the content/file name knows for the same day.
- Course hint: `courseHint` option, else a header line, else the folder under `watchDir`
  (term folders such as `2026前期` are skipped).
- Title: `title` option, else the content title, else the file name without extension.

## Raw type

`transcript.file` — externalId `<rootKey>:<relativePath>` for files under `watchDir`,
`file:<sha256(path)[0,16]>` for other imported files, `text:<sha256(text)[0,16]>` for pasted text:

```json
{
  "fileName": "2026-10-01 10-40.vtt",
  "format": "vtt",
  "title": "第3回",
  "recordedAt": "2026-10-01T01:40:00.000Z",
  "courseHint": "データベースシステム論",
  "language": "ja",
  "durationMs": 3725000,
  "hash": "<sha256>",
  "hasTimestamps": true,
  "importer": "chatgpt-record",
  "segments": [{ "startMs": 1000, "endMs": 4000, "speaker": "先生", "text": "…" }]
}
```

No absolute paths are stored in the payload.

## Mapping (raw → canonical)

Authority `transcript`, source label `ChatGPT Record`.

| Canonical                             | From                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `courseOffering` (when a hint exists) | source-local offering: `title` = hint, `academicYear` (year in the hint, else the profile term, else the April–March rule), `term` 前期/後期 only when the profile's term definition names it; id keyed by the normalized hint and the year. The identity resolver links it to the LCU/Teams offering |
| `lecture`                             | `date` = local date of `recordedAt` in `ctx.timezone`, `title`, `courseOfferingId`, `extra.period` (timetable period inferred from `recordedAt` and the profile periods, 20 minutes early allowed). Id keyed by (course, date); without a course by the transcript                                    |
| `lectureTranscript`                   | `lectureId`, `courseOfferingId`, `title`, `language`, `recordedAt`, `durationMs`, `importer` (payload `importer`: config value / format importer / option), `extra {format, fileName}`                                                                                                                |
| `lectureSegment`                      | `ordinal`, `startMs`, `endMs`, `speaker`, `text`; `ref.location {timestampMs, timestamp "HH:MM:SS"}` (omitted for transcripts without timestamps)                                                                                                                                                     |
| fact `deadline`                       | see below                                                                                                                                                                                                                                                                                             |

The context engine joins the `Lecture` to the `ClassSession` of the same offering and date
(identity-expanded `courseOfferingId` + `lecture.date`, §21), so the segments appear in
`lecture()`, `classReview()` and transcript search once the offering is linked.

### Deadlines (§20)

Segments are grouped into sentence-sized blocks per speaker (so a phrase split across caption cues
is found), then `extractDeadlines` from `@unicontext/task-engine` runs with `reference = recordedAt`
and `timezone = ctx.timezone`. Each distinct (`dueAt`, `phrase`) yields a `FactInput`:

- `subject` = lecture id, `predicate` = `deadline`, `origin` = `extracted`, `confidence` from the rule,
  `evidence` = the sentence, `observedAt` = `recordedAt`,
  `producer` = `{type: 'rule', id: 'ja-deadline-rules'}`.
- `value` = `{dueAt, phrase, rule, courseOfferingId?, timestampMs?, timestamp?}` — the position is
  kept in the value because the engine stores one SourceReference per (raw item, subject,
  predicate), i.e. all deadline facts of one lecture share one `ref.location`.
- `ref.location` = `{timestampMs, timestamp}` of the segment containing the phrase.

`TaskEngine.derive()` turns these into `extracted` tasks (merged into an assignment task when it
restates the same due date).

## Schedule

`defaultSchedule: 30m` (folder scan with manifest) plus `watch()` and manual import.

## Limits and known issues

- The offering built from a hint has title, year and (usually) term as evidence, scoring at most
  0.60 in `scoreOfferingMatch` against the 0.75 auto-link threshold; the link to the LCU/Teams
  offering is therefore `suggested` until confirmed (`identity.confirm`) or the resolver is tuned.
- Relative expressions such as 「次回まで」 are resolved without the next class time (the connector
  does not know the timetable of other sources); they fall back to the extractor's default.
- Files are decoded as utf-8 (BOM stripped), UTF-16 by BOM, otherwise Shift_JIS.
- `importFile` of a file inside `watchDir` records it in the manifest, so the explicit options are
  not overwritten by the next scan until the file changes.
- Speaker labels in `.txt`/`.md` are recognised only for roles (`先生`, `講師`, `Student`…),
  `Speaker N`, latin names and Japanese names with `さん`/`先生`; anything else stays in the text.
- Very long single-line JSON transcripts are read into memory (limit `maxFileSizeMb`, default 20).
