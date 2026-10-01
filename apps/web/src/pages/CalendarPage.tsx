import { TimezoneProvider } from '../components/AppContext';
import { ChangeRow, ClassCard, TaskRow } from '../components/Cards';
import { ConflictBanner } from '../components/ConflictBanner';
import { Async, Empty, PageHeader, Section } from '../components/ui';
import { useApi, useMediaQuery, usePageTitle } from '../hooks';
import { buildWeekGrid } from '../lib/calendar';
import { dayKey, formatDateJa, formatMonthDay } from '../lib/dates';
import { sortByDue, sortClasses } from '../lib/sort';
import { periodLabel } from '../lib/text';
import type { WeekContext } from '../types';

export function CalendarPage() {
  usePageTitle('カレンダー');
  const state = useApi<WeekContext>('/api/v1/week', { pollMs: 60_000 });
  return (
    <>
      <PageHeader title="カレンダー" />
      <Async state={state}>
        {(week) => (
          <TimezoneProvider value={week.timezone}>
            <WeekBody week={week} />
          </TimezoneProvider>
        )}
      </Async>
    </>
  );
}

function WeekBody({ week }: { week: WeekContext }) {
  const tz = week.timezone;
  const narrow = useMediaQuery('(max-width: 700px)');
  const today = dayKey(new Date(), tz);
  return (
    <>
      <p className="meta">
        {formatMonthDay(week.from, tz)}–{formatMonthDay(week.to, tz)}
      </p>
      <ConflictBanner count={week.conflicts.length} />

      <Section title="時間割">
        {narrow ? <WeekList week={week} today={today} /> : <WeekTable week={week} today={today} />}
      </Section>

      <Section title="試験" count={week.exams.length}>
        {week.exams.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {sortByDue(week.exams).map((d) => (
              <TaskRow key={d.taskId} item={d} />
            ))}
          </div>
        )}
      </Section>

      <Section title="締切" count={week.deadlines.length}>
        {week.deadlines.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {sortByDue(week.deadlines).map((d) => (
              <TaskRow key={d.taskId} item={d} />
            ))}
          </div>
        )}
      </Section>

      <Section title="変更" count={week.changes.length}>
        {week.changes.length === 0 ? (
          <Empty />
        ) : (
          <div className="stack">
            {week.changes.map((c) => (
              <ChangeRow key={c.id} item={c} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function WeekTable({ week, today }: { week: WeekContext; today: string }) {
  const grid = buildWeekGrid(week.days);
  return (
    <div className="table-wrap">
      <table className="week-grid">
        <caption className="sr-only">週間時間割</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">時限</span>
            </th>
            {grid.dates.map((d) => (
              <th key={d} scope="col" aria-current={d === today ? 'date' : undefined}>
                {formatDateJa(d)}
                {d === today ? <span className="count-chip">今日</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row) => (
            <tr key={row.period}>
              <th scope="row">{periodLabel(row.period)}</th>
              {row.cells.map((cell, i) => (
                <td key={grid.dates[i]}>
                  {cell.map((c) => (
                    <ClassCard key={c.sessionId} item={c} compact />
                  ))}
                </td>
              ))}
            </tr>
          ))}
          {grid.hasUnscheduled ? (
            <tr>
              <th scope="row">{periodLabel(undefined)}</th>
              {grid.unscheduled.map((cell, i) => (
                <td key={grid.dates[i]}>
                  {cell.map((c) => (
                    <ClassCard key={c.sessionId} item={c} compact />
                  ))}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function WeekList({ week, today }: { week: WeekContext; today: string }) {
  return (
    <div className="stack">
      {week.days.map((day) => (
        <section key={day.date} aria-label={formatDateJa(day.date)}>
          <h3 className="day-heading">
            {formatDateJa(day.date)}
            {day.date === today ? <span className="count-chip">今日</span> : null}
          </h3>
          {day.classes.length === 0 ? (
            <Empty />
          ) : (
            <div className="stack">
              {sortClasses(day.classes).map((c) => (
                <ClassCard key={c.sessionId} item={c} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
