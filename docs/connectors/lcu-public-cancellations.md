# lcu-public-cancellations (`@unicontext/syllabus`, module `public-cancellations`)

Spec: §6, §13/§46 (change events -> notifications), §14 (identity), §26, §27, §35/§36, §55.
Research: [shizuoka.md](../research/shizuoka.md) §2.

## Purpose

The public 休講案内 screen of LiveCampusU (`SC_90002szu_01` at Shizuoka, no login) lists the
cancellations of the **whole university**. The connector polls it every 15 minutes and produces:

- an `announcement` for **every** row (`category: 休講`, title `休講: 科目 (クラス) 10/1 3・4限`;
  `scope: course` + `importance: high` for the user's courses, otherwise `scope: other` +
  `importance: low` so other people's cancellations stay searchable but do not crowd Today), and
- for rows that belong to **the user's courses** only: a cancelled `classSession` plus a
  source-local `courseOffering` the identity resolver links to the LCU offering. The status change
  flows through the normal `class_status` fact and ChangeEvent, so notifications (§46) fire.

Rows that disappear from the page are marked deleted (the page is a full listing).

## Setup

```yaml
sources:
  lcu-kyuko:
    connector: syllabus
    module: public-cancellations
    schedule: 15m # default
    deployment: shizuoka # or baseUrl + screens.publicCancellations
    # baseUrl: https://lcu.example.ac.jp/lcu-web/
    # screens: { publicCancellations: SC_90002szu_01 }
    courses: # the user's courses; matched by title (and class)
      - { title: データベースシステム論 }
      - { title: 外国史概論, classCode: 人文専門１A }
    matchThreshold: 0.85 # min. titleSimilarity (@unicontext/identity)
```

| Key                                                    | Default | Meaning                                                                                                                                           |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment`, `baseUrl`, `screens.publicCancellations` | -       | Same resolution as the syllabus connector: config > `profile.products['lcu-public-cancellations']` (then `products.syllabus`) > named deployment. |
| `courses[]`                                            | `[]`    | `{title, classCode?}`. `classCode` is the class label printed on the page (`情`, `理２`, `人文専門１A`), compared loosely (NFKC, contains).       |
| `matchThreshold`                                       | `0.85`  | Minimum `titleSimilarity(page title, course title)`.                                                                                              |

The host can feed the courses instead of (or in addition to) `courses:`:
`createCancellationsConnector({ courseProvider })` or the public property
`CancellationsAdapter.courseProvider` (e.g. the titles of the LCU timetable offerings). Matching is
done by the **adapter** and stored in the raw payload (`matched`), so changing the course list
re-normalizes the affected rows and the normalizer stays pure.

## Auth

None. Health: `healthy` / `degraded` (failed run) / `failed` (3 consecutive failures).

## Parsing

- `table.c-table` with exactly the columns 授業科目, 休講日, 時限, 担当教員 (anything else is a layout
  change and fails the run instead of silently producing nothing).
- 授業科目 is `<科目名> (<クラス名>)`; the class is the **last top-level parenthesis**, so
  `数学Ⅲ（微分積分Ｂ） (理２)` and `教育の原理 (教（Ｃ組）)` split correctly.
- 休講日 is `MM/DD` without a year. The year is chosen so the date is nearest to the page footer
  `YYYY年MM月DD日HH:MM現在` (also `時点`): previous, same or next calendar year, which handles the
  December/January rollover. The footer is also the items' `sourceUpdatedAt` (JST by profile
  timezone) and the announcement's `publishedAt`. Without a footer the current date is used (warning).
- 時限 `3・4` -> period 2 (LCU pair index, see [syllabus](syllabus.md#time-slots)); the printed text
  stays in the title/body.
- Duplicate rows (same course, class, date, period) are merged (teachers combined).

## Raw type

| Type                     | externalId                                 | Payload                                                                                                                                                    |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lcu.publicCancellation` | `<科目名>\|<クラス>\|<YYYY-MM-DD>\|<時限>` | `{title, courseTitle, className?, dateText: "10/01", date: "2026-10-01", period: "3・4", periodIndex?, instructors[], matched?: {title, classCode?}, url}` |

`complete: { sourceTypes: ['lcu.publicCancellation'] }` is set on every run.

## Mapping

| Raw         | Canonical                       | Notes                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every row   | `announcement`                  | `category: 休講`; matched row → `scope: course`, `importance: high`; other rows → `scope: other`, `importance: low`; `publishedAt` = page timestamp; `courseOfferingId` for matched rows.                                                                                    |
| matched row | `courseOffering` (source-local) | title, `academicYear` (profile term containing the date, else April rollover), instructors, one slot (weekday of the date, period). One offering per (title, class, weekday, period). Linked to the LCU offering by the identity resolver (title, teacher, year, timetable). |
| matched row | `classSession`                  | `date`, `period`, `startsAt/endsAt` from the profile periods, `status: cancelled`, `note`. Auto-fact `class_status` with authority `academic-system` (the source's default).                                                                                                 |

All entities carry `ref.url` = the public screen URL.

## Schedule, stability

`defaultSchedule: 15m`, `defaultAuthority: academic-system`, `sourceLabel: 休講案内`,
`apiStability: unofficial`, `risk: unsupported`, `testedVersion: lcu-web public 2026-10`.

## Limits and known issues

- Supplementary lectures and room changes are not on this page (research §2).
- Without a course list (`courses` / target provider) nothing is matched, so no row reaches the
  Today view; configure the course list (the daemon can feed it from the LCU offerings).
- The class label on the page (`情`, `理２`) is a university-specific class group, not the LCU
  `クラス` (`1クラス`); matching therefore relies on the title, with `classCode` optional.
