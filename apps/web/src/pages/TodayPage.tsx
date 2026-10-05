import { TimezoneProvider, useAdmin, useTimezone } from '../components/AppContext';
import {
  AnnouncementRow,
  ChangeRow,
  ClassCard,
  CourseLink,
  MaterialRow,
  TaskRow,
} from '../components/Cards';
import { Citations } from '../components/Citations';
import { ConflictBanner } from '../components/ConflictBanner';
import { Async, Empty, PageHeader, Section } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { formatDateJa, formatShort, formatTimeRange } from '../lib/dates';
import { sortByDue, sortClasses } from '../lib/sort';
import type { NextActionSummary, PreparationItem, TodayContext } from '../types';

export function TodayPage() {
  usePageTitle('今日');
  const state = useApi<TodayContext>('/api/v1/today', { pollMs: 60_000 });
  const admin = useAdmin();
  return (
    <>
      <PageHeader title="今日">
        <button
          type="button"
          onClick={() => {
            void state.refetch();
            void admin.refetch();
          }}
        >
          更新
        </button>
      </PageHeader>
      <Async state={state}>
        {(today) => (
          <TimezoneProvider value={today.timezone}>
            <TodayBody today={today} />
          </TimezoneProvider>
        )}
      </Async>
    </>
  );
}

function TodayBody({ today }: { today: TodayContext }) {
  const tz = today.timezone;
  const classes = sortClasses(today.classes);
  // document chunks are an indexing detail, not something the student needs to read
  const changes = today.changes.filter((c) => c.entityKind !== 'documentChunk');
  const unsubmitted = sortByDue(
    today.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress'),
  );
  const deadlines = sortByDue(today.deadlines);
  return (
    <>
      <p className="date-line">
        <strong>{formatDateJa(today.date, tz)}</strong>
        <span className="meta">{formatShort(today.generatedAt, tz)}時点</span>
      </p>
      <ConflictBanner count={today.conflicts.length} />
      {today.next ? <NextCard next={today.next} /> : null}

      <Section title="今日の授業" count={classes.length}>
        {classes.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {classes.map((c) => (
              <ClassCard key={c.sessionId} item={c} />
            ))}
          </div>
        )}
      </Section>

      <Section title="重要な変更" count={changes.length}>
        {changes.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {changes.map((c) => (
              <ChangeRow key={c.id} item={c} />
            ))}
          </div>
        )}
      </Section>

      <Section title="締切" count={deadlines.length}>
        {deadlines.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {deadlines.map((d) => (
              <TaskRow key={d.taskId} item={d} />
            ))}
          </div>
        )}
      </Section>

      <Section title="未提出" count={unsubmitted.length}>
        {unsubmitted.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {unsubmitted.map((t) => (
              <TaskRow key={t.taskId} item={t} />
            ))}
          </div>
        )}
      </Section>

      <Section title="授業準備" count={today.preparation.length}>
        {today.preparation.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {today.preparation.map((p) => (
              <Preparation key={p.sessionId} item={p} />
            ))}
          </div>
        )}
      </Section>

      <Section title="大学からのお知らせ" count={today.importantAnnouncements.length}>
        {today.importantAnnouncements.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {today.importantAnnouncements.map((a) => (
              <AnnouncementRow key={a.id} item={a} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Preparation({ item }: { item: PreparationItem }) {
  const tz = useTimezone();
  const time = formatTimeRange(item.startsAt, undefined, tz);
  return (
    <article className="card">
      <header className="card-head">
        <h3 className="card-title">
          <CourseLink course={item.course} />
        </h3>
        {time ? <span className="meta">{time}</span> : null}
      </header>
      {item.materials.length > 0 ? (
        <div className="subsection">
          <h4>資料</h4>
          <div className="stack">
            {item.materials.map((m) => (
              <MaterialRow key={m.id} item={m} />
            ))}
          </div>
        </div>
      ) : null}
      {item.dueBeforeClass.length > 0 ? (
        <div className="subsection">
          <h4>授業前の締切</h4>
          <div className="stack">
            {item.dueBeforeClass.map((d) => (
              <TaskRow key={d.taskId} item={d} />
            ))}
          </div>
        </div>
      ) : null}
      {item.announcements.length > 0 ? (
        <div className="subsection">
          <h4>お知らせ</h4>
          <div className="stack">
            {item.announcements.map((a) => (
              <AnnouncementRow key={a.id} item={a} />
            ))}
          </div>
        </div>
      ) : null}
      <Citations citations={item.citations} />
    </article>
  );
}

/** The one thing to do now, decided by UniContext (the student does not have to prioritise). */
function NextCard({ next }: { next: NextActionSummary }) {
  const top = next.top;
  if (!top) {
    return (
      <article className="card next-card">
        <p className="meta">{next.line}</p>
      </article>
    );
  }
  return (
    <article className={next.urgent ? 'card next-card urgent' : 'card next-card'}>
      <header className="card-head">
        <h3 className="card-title">今やること</h3>
        {top.dueAt ? <span className="meta">締切 {top.dueText}</span> : null}
      </header>
      <p className="next-what">{top.what}</p>
      <p className="meta">
        {top.why}
        {top.course ? ` / ${top.course.title}` : ''}
      </p>
      {top.link ? (
        <p>
          <a href={top.link.url} target="_blank" rel="noreferrer">
            {top.link.label ? `${top.link.label}で開く` : '開く'}
          </a>
        </p>
      ) : null}
      {next.then.length > 0 ? (
        <ol className="next-then">
          {next.then.map((t) => (
            <li key={t.what}>
              {t.what}
              <span className="meta">
                {' '}
                {t.dueText}
                {t.course ? ` / ${t.course}` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {!next.coverageTrusted ? <p className="meta">締切を取れていない情報源があります</p> : null}
      <Citations citations={top.citations} />
    </article>
  );
}
