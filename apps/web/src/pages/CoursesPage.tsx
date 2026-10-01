import { Link } from '@tanstack/react-router';
import { ResolvedField } from '../components/Cards';
import { Async, Badge, Empty, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { scheduleText } from '../lib/calendar';
import type { CoursesResponse } from '../types';

export function CoursesPage() {
  usePageTitle('授業');
  const state = useApi<CoursesResponse>('/api/v1/courses');
  return (
    <>
      <PageHeader title="授業" />
      <Async state={state}>
        {({ courses }) =>
          courses.length === 0 ? (
            <Empty />
          ) : (
            <ul className="plain-list stack">
              {courses.map((c) => (
                <li key={c.id} className="card">
                  <header className="card-head">
                    <h2 className="card-title">
                      <Link to="/courses/$id" params={{ id: c.id }} className="course-link">
                        {c.title}
                      </Link>
                    </h2>
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
              ))}
            </ul>
          )
        }
      </Async>
    </>
  );
}
