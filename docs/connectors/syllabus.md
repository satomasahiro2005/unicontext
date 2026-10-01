# syllabus (`@unicontext/syllabus`)

Spec: §6 (raw first), §8 (Course vs CourseOffering), §12 (authority), §14 (identity), §26 (LCU, no
university in core), §27 (unofficial API), §35/§36 (sync, daily), §37 (rate limiting), §55 (metadata).
Research: [shizuoka.md](../research/shizuoka.md) §3.

## Purpose

Reads the **public** course syllabus of a university and turns it into searchable course data: the
course (code, titles, credits, department), a course offering (year, term, teachers, timetable,
room) and a `シラバス: <科目>` document with one chunk per section (goals, content, per-session
plan, textbook, grading, office hours ...). The offering's room becomes an authoritative `room` fact
with authority `syllabus`, which ranks **below** `academic-system` in the default rules (§12), so the
syllabus never overrides the student's own LiveCampusU timetable but fills in when LCU has no room.
The identity resolver (§14) links the syllabus offering to the LCU offering by subject code, title,
teacher and timetable; nothing extra is needed as long as `courseCode` (bare 8-digit subject code),
`academicYear` and `term` are set, which this connector does.

The package is a generic connector with a **strategy** per syllabus system. The built-in strategy
`lcu-public` reads the public LiveCampusU syllabus screens (no login). The same package also exports
the 休講 connector, see [lcu-public-cancellations](lcu-public-cancellations.md).

## Setup

No credentials. Tell the connector **which courses** to read; it never crawls the whole syllabus
database (one lookup is about six requests).

```yaml
# config.yaml
sources:
  syllabus:
    connector: syllabus
    schedule: 1d # default
    deployment: shizuoka # built-in deployment profile (or set baseUrl + screens)
    # baseUrl: https://lcu.example.ac.jp/lcu-web/
    # screens: { syllabusSearch: SC_06001B00_21, syllabusDetail: SC_06001B00_22 }
    targets: # exact courses (year x faculty + subject code)
      - { year: 2026, faculty: IN-B, subjectCode: '77403030' }
      - { year: 2026, titleCode: '2250', subjectCode: '11001010', classCode: 1クラス }
      - { year: 2026, subjectCode: '77501090' } # no faculty/titleCode: searched over all titles
    searches: # bounded free searches, every hit is opened
      - { year: 2026, faculty: IN-B, subjectName: データベース, maxRows: 5 }
    unitsPerPage: 5 # targets/searches processed per sync() page
```

Instead of (or in addition to) `targets:` the host can inject the student's courses, see below.

## Config keys

| Key                                                 | Default              | Meaning                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy`                                          | `lcu-public`         | Strategy id (`registerSyllabusStrategy` adds more).                                                                                                                                                                                                                                                                                |
| `deployment`                                        | -                    | Built-in deployment profile name (`shizuoka`).                                                                                                                                                                                                                                                                                     |
| `baseUrl`                                           | profile / deployment | LCU site root, e.g. `https://.../lcu-web/`.                                                                                                                                                                                                                                                                                        |
| `screens.syllabusSearch` / `screens.syllabusDetail` | deployment           | Screen ids.                                                                                                                                                                                                                                                                                                                        |
| `titles`                                            | deployment           | `{ <year>: { <faculty code>: <form "title" value> } }`, merged over the deployment's table.                                                                                                                                                                                                                                        |
| `targets[]`                                         | `[]`                 | `{year, subjectCode, faculty? \| titleCode?, classCode?}`. `titleCode` is the search form's `title` value (2243 = 2026 情報学部); `faculty` is looked up in `titles`; without both, all titles are searched and rows are filtered by `year`. `classCode` is matched against the row's クラス (`1クラス`) or its hidden class code. |
| `searches[]`                                        | `[]`                 | `{year?, faculty?, title?, category?, subjectName?, jikanwariSubjectName?, staffName?, practitionerFlag?, semester?, term?, subjectCode?, numbering?, subjectType?, week?, period?, freeword?, maxRows=10}` (form field names of the search screen).                                                                               |
| `unitsPerPage`                                      | `5`                  | Units per `sync()` page.                                                                                                                                                                                                                                                                                                           |

Deployment settings are resolved as: explicit source config > `profile.products.syllabus` >
the named deployment (`src/profiles/shizuoka.ts`). A profile can therefore set
`products.syllabus: { deployment: shizuoka }` and the source config only needs `targets`.

### Feeding the student's courses (`targetProvider`)

`createSyllabusConnector({ targetProvider })` and the public property `SyllabusAdapter.targetProvider`
accept a function returning the student's courses; its result is merged with `targets:` (invalid
entries are ignored with a warning). The daemon wires it to the LiveCampusU timetable:

```ts
import { createSyllabusConnector, type SyllabusAdapter } from '@unicontext/syllabus';

const module = createSyllabusConnector({
  targetProvider: () =>
    lcuOfferings().map((o) => ({
      year: o.academicYear,
      subjectCode: o.courseCode,
      faculty: 'IN-B',
    })),
});
// or after instantiateConnector(...):  (instance.adapter as SyllabusAdapter).targetProvider = ...
```

## Auth

None (`authenticate()` returns `not_required`). Health is `healthy`, `degraded` after a failed run
and `failed` after three consecutive failures.

## How the `lcu-public` strategy reads a syllabus

Every step replays the server's own flow with a small cookie jar (`JSESSIONID`), manual redirect
handling and the `_csrf` of the **latest** HTML:

```
GET  <base>SC_06001B00_21/init        -> 302 -> GET SC_06001B00_21     (cookie + csrf)
POST <base>SC_06001B00_21/search      -> 302 -> GET SC_06001B00_21     (#dataTable01 rows, tr[_index])
POST <base>SC_06001B00_21/linkselect  -> 302 -> GET SC_06001B00_22     (syllabus detail)
```

- The body is `application/x-www-form-urlencoded; charset=UTF-8` with all search fields
  (`title, category, jikanwariSubjectName, staffName, practitionerFlag, semester, term,
subjectCode, numbering, subjectName, subjectType, week, period, freeword, _csrf`).
- There is no fixed URL for one syllabus: the detail depends on the session's last search, so
  every detail is "search, then linkselect"; after a detail screen the flow starts again with
  `init`. Requests are strictly serialized per session (one at a time, also through the shared
  `RateLimiter`), and `;jsessionid=` URL rewriting and the server's error screen (new session, one
  retry) are handled. Redirects leaving the configured origin abort the request.
- Rows are deduplicated by `科目コード | クラス | タイトル` (the same subject listed under several
  departments is one entry with all categories).

### Time slots

`曜日・時限` is printed as `木3・4`. LCU numbers 45-minute units and prints them in pairs
(`1・2`, `3・4`, ... `13・14`). **Convention used by all LCU-related connectors:**
`ScheduleSlot.period` is the pair index (`1・2` -> 1, `3・4` -> 2, ... `13・14` -> 7) and
`dayOfWeek` is 0 = Sunday (`木` -> 4). The printed text is kept in
`courseOffering.extra.slots[].rawPeriod` and `extra.rawSchedule`. Start/end times come from the
profile's `academicCalendar.periods` (period 2 = 10:20-11:50 for Shizuoka) when defined.
Entries like 集中 / 時間割外 have no slot.

## Raw types

| Type             | externalId                               | Payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syllabus.entry` | `<subjectCode>\|<class>\|<title>` (NFKC) | `{strategy, url, title, titleCode?, year?, subjectCode, className, categories[], row{<column>: text}, detail{...}}`; `detail` holds numbering, name/nameEn, className, instructors (+En), department, laboratory, coInstructors, grade, campus, semester, termSpan, dayPeriod, slots[], room, requirement, credits, keywords[], goals, content, planNote, plan[{no,content}], prerequisites, textbook, references, preparation, evaluation, officeHours, message, activeLearning[], practicalExperience[], teacherTraining, delivery[], onlineDetail and `extra` (unknown labels/sections). |

## Mapping

| Raw              | Canonical        | Notes                                                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syllabus.entry` | `course`         | `courseCode` = subject code, `title`, `titleEn`, `credits`, `department` (所属). Id keyed by subject code.                                                                                                                                                                                              |
|                  | `courseOffering` | `courseCode`, `academicYear` (from `2026年度`), `term` (開講学期), `title`, `instructorNames` (+ 分担教員), `schedule` (slots + profile times), `room` (教室), `url`; `extra`: className, rawSchedule, slots, termSpan, categories, grade, campus, requirement, delivery, officeHours, unmapped labels. |
|                  | fact `room`      | Auto-derived from `courseOffering.room`, `origin: authoritative`, authority `syllabus` (default authority of the source).                                                                                                                                                                               |
|                  | `document`       | `シラバス: <科目>`, text of all sections, `courseOfferingId`.                                                                                                                                                                                                                                           |
|                  | `documentChunk`  | One per section (概要, キーワード, 授業の目標, 学修内容, 授業計画, 受講要件, テキスト, 参考書, 予習・復習, 成績評価の方法・基準, オフィスアワー, ...), `heading`, `ref.location.selector` = heading.                                                                                                    |

All entities carry `ref.url` (the public syllabus search entry point) and authority `syllabus`.
Schema drift (`detectSchemaDrift`) is returned for the payload; an unrecognizable detail screen
fails the lookup, and a run where every lookup fails throws (health `degraded`).

## Schedule and sync behaviour

- Metadata: `defaultSchedule: 1d`, `apiStability: unofficial`, `risk: unsupported`,
  `testedVersion: lcu-web public 2026-10` (screen-id based; there is no version string).
- `initial` / `incremental` / `full` all re-read the target list (syllabi change rarely; the raw
  store's content hash drops unchanged entries). Pages of `unitsPerPage` units.
- `complete: { sourceTypes: ['syllabus.entry'] }` is set on the last page **only** when the unit
  list is non-empty and every unit succeeded and found rows; otherwise (empty list, failed or empty
  lookup, ignored invalid target) no entry is retired.
- No `productVersion` is reported (no version is exposed by the public screens).

## Limits and known issues

- About six HTTP requests per syllabus (init, search, linkselect, each with its redirect), rate limited.
  Keep `targets` to the student's own courses.
- The search `title` code changes every academic year; the Shizuoka table covers 2022-2026 and can be
  extended in `titles` (config/profile) or `registerDeployment`.
- `linkselect` replays the result form's hidden inputs (`viewRowIndexArray` is sent as printed,
  empty); if a deployment requires it filled, the detail lookup fails and shows up as a warning.
- The English/Japanese toggle is not used: the Japanese page is parsed. Course/department names
  differ per teacher (`所属`), so `course.department` may flip between classes of one subject.
- `changeTitle` (category options) is not used.
