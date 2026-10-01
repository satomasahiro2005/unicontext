import { useParams } from '@tanstack/react-router';
import { enc } from '../api';
import { TimezoneProvider } from '../components/AppContext';
import {
  AnnouncementRow,
  ChangeRow,
  ClassCard,
  MaterialRow,
  ResolvedField,
  TaskRow,
} from '../components/Cards';
import { Citations } from '../components/Citations';
import { ConflictBanner } from '../components/ConflictBanner';
import { ConflictSummary } from '../components/ConflictCard';
import { PendingLinks } from '../components/PendingLinks';
import { Async, Badge, Empty, PageHeader, Section } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { scheduleText } from '../lib/calendar';
import { formatDateJa } from '../lib/dates';
import { sortByDue } from '../lib/sort';
import type { CourseContext } from '../types';

export function CourseDetailPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const state = useApi<CourseContext>(id ? `/api/v1/courses/${enc(id)}` : null);
  usePageTitle(state.data?.course.title ?? '授業');
  return (
    <>
      <PageHeader title={state.data?.course.title ?? '授業'} />
      <Async state={state}>
        {(course) => (
          <TimezoneProvider value={course.timezone}>
            <CourseBody course={course} onChanged={() => void state.refetch()} />
          </TimezoneProvider>
        )}
      </Async>
    </>
  );
}

function CourseBody({ course, onChanged }: { course: CourseContext; onChanged: () => void }) {
  const tz = course.timezone;
  return (
    <>
      <ConflictBanner count={course.conflicts.length} />
      <div className="card">
        <p className="meta">
          {course.course.courseCode ? <span>{course.course.courseCode}</span> : null}
          {course.instructors.length > 0 ? <span>{course.instructors.join('、')}</span> : null}
        </p>
        {course.schedule.length > 0 ? (
          <ul className="inline-list">
            {course.schedule.map((s, i) => (
              <li key={i}>{scheduleText(s)}</li>
            ))}
          </ul>
        ) : null}
        <ResolvedField label="教室" value={course.room} />
        {course.sources.length > 0 ? (
          <ul className="plain-list">
            {course.sources.map((s) => (
              <li key={s.id} className="source-line">
                <code>{s.sourceId ?? s.id}</code>
                <Citations citations={s.citations} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Section title="今後の授業" count={course.upcomingClasses.length}>
        {course.upcomingClasses.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {course.upcomingClasses.map((c) => (
              <div key={c.sessionId}>
                <h3 className="day-heading">{formatDateJa(c.date, tz)}</h3>
                <ClassCard item={c} />
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="講義" count={course.recentLectures.length}>
        {course.recentLectures.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {course.recentLectures.map((l, i) => (
              <article className="card" key={l.lectureId ?? `${l.date}-${i}`}>
                <header className="card-head">
                  <h3 className="card-title">{l.title ?? formatDateJa(l.date, tz)}</h3>
                  <span className="meta">{formatDateJa(l.date, tz)}</span>
                </header>
                <p className="meta">
                  {l.slides.length > 0 ? <Badge>スライド{l.slides.length}件</Badge> : null}
                  {l.recordings.length > 0 ? <Badge>録画{l.recordings.length}件</Badge> : null}
                  {l.transcript.length > 0 ? <Badge>講義録{l.transcript.length}件</Badge> : null}
                  {l.questions.length > 0 ? <Badge>質問{l.questions.length}件</Badge> : null}
                </p>
                <Citations citations={l.citations} />
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section title="資料" count={course.materials.length}>
        {course.materials.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {course.materials.map((m) => (
              <MaterialRow key={m.id} item={m} />
            ))}
          </div>
        )}
      </Section>

      <Section title="お知らせ" count={course.announcements.length}>
        {course.announcements.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {course.announcements.map((a) => (
              <AnnouncementRow key={a.id} item={a} />
            ))}
          </div>
        )}
      </Section>

      <Section title="締切" count={course.deadlines.length}>
        {course.deadlines.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {sortByDue(course.deadlines).map((d) => (
              <TaskRow key={d.taskId} item={d} />
            ))}
          </div>
        )}
      </Section>

      <Section title="変更" count={course.changes.length}>
        {course.changes.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {course.changes.map((c) => (
              <ChangeRow key={c.id} item={c} />
            ))}
          </div>
        )}
      </Section>

      <Section title="競合" count={course.conflicts.length}>
        {course.conflicts.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {course.conflicts.map((c) => (
              <ConflictSummary key={c.id} item={c} />
            ))}
          </div>
        )}
      </Section>

      <Section title="紐付けの確認" count={course.pendingLinks.length}>
        <PendingLinks links={course.pendingLinks} onChanged={onChanged} />
      </Section>
    </>
  );
}
