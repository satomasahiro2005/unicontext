---
name: lecture-ingest
description: Save a university lecture into UniContext as soon as a lecture recording, transcript (ChatGPT Record or pasted text) or detailed lecture notes appear in the conversation, without waiting for the student to ask. Extracts the summary plus the deadlines, exams, preparation and to-dos the teacher actually stated.
---

# Save a lecture to UniContext

Trigger: a lecture recording or transcript, or detailed notes of one class, is in the
conversation. The student will not ask you to save it. Save it, then answer whatever they
asked (summary, questions, anything).

## Steps

1. Work out the course and the date/period from the conversation, the recording, and the
   timetable (`get_today` / `get_week` if needed). Do not ask for anything these settle.
   If the course truly cannot be told apart (two candidates that both fit), ask one short
   question; otherwise proceed.
2. Call `ingest_lecture` once with the summary, key points, and every item the teacher
   **explicitly** stated: deadlines (with the stated date/time), exams and quizzes,
   preparation for next class, to-dos, notes. Include the quoted words and the position in
   the recording when available. Pass relative dates as said (「来週の金曜」「次回」);
   UniContext resolves them.
3. If `ingest_lecture` is not available, call `record_lecture` for the summary and key
   points, then `add_deadline`, `add_task` and `add_note` for each stated item, with
   `via: "recording"` and the recording timestamp when known.
4. Report in two or three lines what was saved (course, date, counts of deadlines / to-dos
   / notes) and any item the tool reported as a duplicate, conflict or failure. If a saved
   deadline differs from the university's data, show both values with their sources.

## Rules

- Never invent a deadline. 「たぶん来週くらい」「いつもは2週間後」 is not a deadline: put it in a
  note as uncertain, or leave it out. Only a date someone stated becomes a deadline.
- Do not ask 「保存しますか？」. ChatGPT's own confirmation prompt for the write is the only
  confirmation.
- What was heard in a recording stays marked as from the recording; it never replaces what
  the LMS or the registrar system says.
- Re-running is safe: `ingest_lecture` is idempotent per lecture. If the student adds more
  of the same lecture later, call it again with the same course, date and `recordingRef`
  instead of starting a separate lecture.
