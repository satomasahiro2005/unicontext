import type { AttendanceOverview, UniContext } from '@unicontext/context-engine';
import { formatShortJa } from '@unicontext/core';
import { z } from 'zod';
import type { EnvelopeOptions } from './envelope.js';

/*
 * get_attendance: the attendance counts (出席・欠席・遅刻・早退・公欠) the academic system
 * publishes for each course of this term, as it states them. Raw numbers with their source and
 * time; UniContext does not know a course's attendance rule, so nothing here says whether the
 * student is in danger — that is in the syllabus (get_syllabus 成績評価).
 */

export const GET_ATTENDANCE_TOOL = {
  title: '出欠',
  description:
    '今学期の科目ごとの出欠（出席・欠席・遅刻・早退・公欠の回数と公開状況）を、学務情報システムが公開している数値そのまま返す。「何回休んだ？」「出席は足りてる？」に使う。course を渡すとその1科目だけ。回数は取得時点（asOf）のもので、coverage に最終同期の時刻と、出欠を取り込めていない科目・情報源の状態が入る。出欠の行がない科目や coverage.complete が false のときは、そのことを伝え、回数を推測しない。UniContext は科目ごとの出席の基準（何回欠席で不可など）を持たないので、危ないかどうかは断定せず、基準はシラバスの成績評価（get_syllabus）で確かめる。 / Attendance counts the academic system publishes per course this term (attended, absent, late, early leave, excused, published state), exactly as stated. Pass course for one course. Counts are as of `asOf`; coverage says when the academic system was last synced and which courses have no row. Never guess a missing count and never judge whether the student is at risk: the attendance rule is in the syllabus.',
} as const;

export const getAttendanceShape = {
  course: z
    .string()
    .min(1)
    .optional()
    .describe(
      '1科目だけ見るとき: 科目の id、または科目名・科目コードの一部。省略すると今学期の全科目 / One course (id, title or code); omit for every course of this term',
    ),
};

/** What to quote and what not to conclude, from the overview. */
export function attendanceHint(o: AttendanceOverview, tz: string): string {
  const parts: string[] = [];
  const shown = o.courses.filter((c) => c.attendance);
  if (shown.length > 0)
    parts.push(
      `出欠の数値は学務情報システムの公開値そのままです。各科目の asOf（${shown
        .map((c) => formatShortJa(new Date(c.attendance?.asOf ?? o.generatedAt), tz))
        .filter((v, i, a) => a.indexOf(v) === i)
        .join('・')}）時点のものと伝えてください。`,
    );
  if (o.coverage.note) parts.push(`${o.coverage.note}。`);
  parts.push(
    '欠席が何回までなら大丈夫かは科目の基準次第でUniContextには分かりません。危ないとも大丈夫とも断定せず、基準はシラバスの成績評価で確かめるよう伝えてください。',
  );
  return parts.join('');
}

export function getAttendance(
  uc: UniContext,
  args: { course?: string | undefined },
  courseId: (input: string | undefined) => string | undefined,
): { data: AttendanceOverview; options: EnvelopeOptions } {
  const id = courseId(args.course);
  const data = uc.context.attendanceOverview(id ? { courseOfferingId: id } : {});
  return { data, options: { hint: attendanceHint(data, uc.timezone) } };
}
