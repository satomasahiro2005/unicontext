import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ResolvedField } from '../components/Cards';
import { Async, Badge, Empty, PageHeader, Section } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { scheduleText } from '../lib/calendar';
import { GRADE_OUTCOME_ORDER, gradeOutcomeLabel, gradeOutcomeTone } from '../lib/labels';
import type {
  CourseSummary,
  CoursesResponse,
  GradeAttempt,
  GradeCourse,
  GradePeriodTotals,
  GradesResponse,
} from '../types';

const GRADE_FILTERS = [
  { value: 'all', label: 'すべて', query: '' },
  { value: 'failed', label: '不合格だけ', query: '?failed=1' },
  ...GRADE_OUTCOME_ORDER.filter((o) => o !== 'failed').map((o) => ({
    value: o,
    label: gradeOutcomeLabel(o),
    query: `?status=${o}`,
  })),
] as const;

function credits(n: number | undefined): string {
  if (n === undefined) return '-';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function totalsText(t: GradePeriodTotals): string {
  const parts = [`修得 ${credits(t.earnedCredits)}単位`];
  if (t.failedCredits) parts.push(`不合格 ${credits(t.failedCredits)}単位`);
  for (const o of ['in_progress', 'not_graded', 'withdrawn', 'unknown'] as const)
    if (t.counts[o]) parts.push(`${gradeOutcomeLabel(o)} ${t.counts[o]}件`);
  return parts.join(' / ');
}

function courseOf(courses: readonly GradeCourse[], a: GradeAttempt): GradeCourse | undefined {
  return courses.find((c) => c.attempts.some((x) => x.id === a.id));
}

function AttemptRow({ a, course }: { a: GradeAttempt; course: GradeCourse | undefined }) {
  const notes: string[] = [];
  if (course && course.attempts.length > 1)
    notes.push(`${a.attemptNo}/${course.attempts.length}回目`);
  if (a.pendingReexam) notes.push('再試待ち');
  if (course?.earned && a.outcome === 'failed') notes.push('後に修得');
  if (course && !course.earned && course.latest.id === a.id && course.failedAttempts > 0)
    notes.push('未修得');
  if (a.markers?.length) notes.push(a.markers.map((m) => m.label ?? m.symbol).join('・'));
  return (
    <tr>
      <td>{a.subjectCode ?? ''}</td>
      <td>{a.title}</td>
      <td className="num">{credits(a.credits)}</td>
      <td>{a.evaluation || '（なし）'}</td>
      <td>
        <Badge tone={gradeOutcomeTone(a.outcome)}>{gradeOutcomeLabel(a.outcome)}</Badge>
      </td>
      <td>{a.examType ?? ''}</td>
      <td>{notes.join('、')}</td>
    </tr>
  );
}

function GradesSection() {
  const [filter, setFilter] = useState<(typeof GRADE_FILTERS)[number]['value']>('all');
  const query = GRADE_FILTERS.find((f) => f.value === filter)?.query ?? '';
  const state = useApi<GradesResponse>(`/api/v1/grades${query}`);
  return (
    <Section title="成績" id="sec-grades">
      <label className="inline-field">
        <span>表示</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          {GRADE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <Async state={state}>
        {(report) => {
          if (report.totals.attempts === 0) return <Empty />;
          const byTerm = new Map<string, GradeAttempt[]>();
          for (const a of report.attempts) {
            const key = `${a.academicYear ?? ''} ${a.term ?? ''}`.trim() || '不明';
            byTerm.set(key, [...(byTerm.get(key) ?? []), a]);
          }
          return (
            <div className="stack">
              <p className="meta">
                <span>通算 {totalsText(report.totals)}</span>
                {report.years.map((y) => (
                  <span key={y.key}>
                    {y.key}年度 {totalsText(y)}
                  </span>
                ))}
              </p>
              {report.unknownLabels.length > 0 ? (
                <p className="meta">
                  区分を判定できない評価: {report.unknownLabels.map((l) => l || '空欄').join('、')}
                  （修得にも不合格にも数えていません）
                </p>
              ) : null}
              {report.attempts.length === 0 ? <Empty /> : null}
              {report.terms
                .filter((t) => byTerm.has(t.key))
                .map((t) => (
                  <div key={t.key} className="card">
                    <header className="card-head">
                      <h3 className="card-title">{t.key.replace(/^(\d{4}) /, '$1年度 ')}</h3>
                      <span className="meta">{totalsText(t)}</span>
                    </header>
                    <div className="table-wrap">
                      <table className="grade-table">
                        <thead>
                          <tr>
                            <th>コード</th>
                            <th>科目</th>
                            <th>単位</th>
                            <th>評価</th>
                            <th>区分</th>
                            <th>試験</th>
                            <th>備考</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(byTerm.get(t.key) ?? []).map((a) => (
                            <AttemptRow key={a.id} a={a} course={courseOf(report.courses, a)} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
            </div>
          );
        }}
      </Async>
    </Section>
  );
}

function latestGrade(
  c: CourseSummary,
  grades: GradesResponse | undefined,
): GradeCourse | undefined {
  if (!grades || !c.courseCode) return undefined;
  return grades.courses.find((g) => g.subjectCode === c.courseCode);
}

export function CoursesPage() {
  usePageTitle('授業');
  const state = useApi<CoursesResponse>('/api/v1/courses');
  const grades = useApi<GradesResponse>('/api/v1/grades');
  return (
    <>
      <PageHeader title="授業" />
      <Async state={state}>
        {({ courses }) =>
          courses.length === 0 ? (
            <Empty />
          ) : (
            <ul className="plain-list stack">
              {courses.map((c) => {
                const g = latestGrade(c, grades.data);
                return (
                  <li key={c.id} className="card">
                    <header className="card-head">
                      <h2 className="card-title">
                        <Link to="/courses/$id" params={{ id: c.id }} className="course-link">
                          {c.title}
                        </Link>
                      </h2>
                      {g ? (
                        <Badge tone={gradeOutcomeTone(g.status)}>
                          {g.statusEvaluation || gradeOutcomeLabel(g.status)}
                          {g.failedAttempts > 0 ? `（不合格${g.failedAttempts}回）` : ''}
                        </Badge>
                      ) : null}
                      {c.openConflicts > 0 ? <Badge tone="bad">競合{c.openConflicts}</Badge> : null}
                    </header>
                    <p className="meta">
                      {c.courseCode ? <span>{c.courseCode}</span> : null}
                      {c.academicYear !== undefined ? (
                        <span>
                          {c.academicYear}年度{c.term ?? ''}
                        </span>
                      ) : null}
                      {c.instructors.length > 0 ? <span>{c.instructors.join('、')}</span> : null}
                    </p>
                    {c.schedule.length > 0 ? (
                      <ul className="inline-list">
                        {c.schedule.map((s, i) => (
                          <li key={i}>{scheduleText(s)}</li>
                        ))}
                      </ul>
                    ) : null}
                    <ResolvedField label="教室" value={c.room} />
                  </li>
                );
              })}
            </ul>
          )
        }
      </Async>
      <GradesSection />
    </>
  );
}
