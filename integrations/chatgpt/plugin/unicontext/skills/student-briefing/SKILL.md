---
name: student-briefing
description: Run an unattended check for a ChatGPT scheduled task - the hourly 学生生活ウォッチャー or the morning 起きたらやること - from UniContext plus, read-only, Google Calendar and Gmail when connected, and produce either a short push-notification text or the morning list, or nothing at all. Use when a scheduled task or its prompt names this skill.
---

# Scheduled check

This runs with nobody watching. The student reads only the notification. Their phone
buzzing for nothing teaches them to ignore it, so silence is the default.

## Tools

Read-only only. Never call a UniContext write tool here (`ingest_lecture`, `add_*`,
`record_lecture`, `retract_addition`, `open_announcement`, `set_course_condition`,
`add_session_rule`): a write waits for approval and pauses the task.

UniContext, use the first that exists, in this order:

- Watcher: `get_attention_required` → `get_student_state` → `get_briefing` (kind `check`)
  → `get_today` + `get_deadlines` (days: 2) + `get_recent_changes`.
- Morning: `get_student_state` → `get_briefing` (kind `morning`) → `get_today` +
  `get_deadlines` (days: 2) + `get_tasks`.

If the tool returns notification text and a `nothingImportant` (or equivalent) flag,
follow it for the UniContext side: when it says nothing is important, UniContext adds
nothing; otherwise use its text, shortened if needed.

If every UniContext tool fails (not connected, authorization expired, server down), that
is itself worth one notification, but only once per day: 「UniContextに接続できません。
ChatGPTのプラグイン画面で再接続してください」.

## Google Calendar and Gmail (when the connectors are available)

Strictly read-only. Never mark mail as read, reply, send, draft, label, archive or trash,
and never create or change a calendar event. Never copy what you find into UniContext
(`add_note`, `add_deadline`, … from mail or calendar contents): storing it is a future
`ingest_external_signal`, not this task. If a connector is missing or fails, say
「取得できていない」 for that source and go on with the rest.

- **Calendar = time facts**: appointments that are not classes (interviews, travel,
  meetings). A calendar entry with the same time and title as a UniContext class is the
  same class: show it once, with UniContext's room.
- **Gmail = new information.** Judge by sender, subject and content, never by labels or
  categories. Pick up only: the university or a teacher (休講, 教室変更, 締切変更, 課題),
  hiring (interview or schedule changes), and urgent security notices (account compromise,
  suspicious login). Ignore ads, newsletters, campus-wide general notices and routine
  GitHub notifications.
- 「情報がない」 means the source was read and has nothing. 「取得できていない」 means it could not
  be read (connector unavailable, error, UniContext coverage gap or `sourceHealth` bad).
  Never turn the second into the first.

## Effective schedule

Class items carry `effectiveSchedule.status` (`attending`, `not_attending`, `unknown`) and
`effectiveSchedule.reason`, plus `rawSchedule` (what the academic system timetable says).
Day views list sessions that do not apply to the student in `notAttending` (for example
「Aグループの日なので本人(B)は授業なし」).

- Never present a `not_attending` class as today's class and never notify about it.
- `unknown` (depends on the group and the group is not known): say 「班で変わります」. In
  the morning run ask once which group the student is in; the watcher does not ask.
- `rawSchedule` differing from the effective value (another day or room) is the student's
  group applied, not a conflict: say the effective one, optionally 「時間割では月曜」.
  Only `effectiveSchedule.conflicts` (sources disagreeing about the group or the date) is a
  conflict: show both values with their sources, do not adopt one.

## What counts as "needs action now" (watcher)

Notify only if waiting for the next normal check (the next morning briefing) would hurt.

- An unsubmitted deadline within 24 hours, or an overdue one that is still unsubmitted.
- A class the student attends (`attending`) starting within the next 90 minutes, with
  its room; a calendar appointment starting soon.
- 休講 or 教室変更 for today or tomorrow that is new since the last run.
- A new exam, quiz or deadline in the next 7 days that appeared since the last run.
- Progress behind plan (a planned task or study slot missed) when the tool reports it.
- A mail that fits the Gmail list above and changes what the student must do today or
  tomorrow, or an urgent security notice.
- A source whose data could not be fetched, when it hides deadlines due within 48 hours
  (say 「取得できていない」, do not guess).

Everything else (new materials, ordinary announcements, deadlines a week away already
reported) is not a reason to notify. 0:00-6:59: only a deadline within 3 hours and
today's 休講 / 教室変更.

`get_attention_required` items carry `attentionId` (stable id), `severity`, `firstSeenAt`,
`lastChangedAt`, `nextEscalationAt`, `recommendedAction` and `sourceHealth`. Use
`attentionId` to recognise the same item across runs; `severity` and `nextEscalationAt` to
decide whether to notify again; `recommendedAction` for the "what to do now" part; and
`sourceHealth` to say 「取得できていない」 when a source the item relies on is unhealthy.

## Output

### Watcher

- Nothing to report: output nothing at all. No 「通知なし」, no greeting, no 「問題ありません」.
- Something to report: for each item 1 to 3 sentences: what happened, when, what to do
  now. Most urgent first, at most 4 items, a short source at the end of each. No headings,
  no advice, no emoji. Example:

  ```
  13:00 情報処理演習が教室変更になりました。共通A201へ（根拠: 学務情報システム 10/5 11:02取得）
  データベース第3回レポートが今日23:59締切で未提出です。まず課題文を開いて設問を読む（根拠: LMS 10/5 08:12取得）
  ```

- Merge the same event seen in several sources (a 休講 in UniContext and in Gmail) into
  one item that cites all of them.
- Do not repeat an item already notified, unless it escalated (`severity` rose, a
  `nextEscalationAt` passed, 「今日」 became 「3時間以内」), changed, or reached a stage the
  student has still not acted on.

### Morning

The very first line, before any heading, is one single action to do right now. Then these
four headings, in this order, one action per line with time and place, a source line at
the end:

```
まず今やること
時間が決まっている今日の予定
今日中に終えること
近いうちに注意すること
```

Break big work into small concrete steps that start in five minutes. Calendar items go
under 「時間が決まっている今日の予定」 together with the classes the student attends. A day
with no class, appointment or urgent matter: the single line `通知なし`. No greeting,
encouragement, advice or emoji.

Never invent a deadline or a time. If two sources disagree, show both values.
