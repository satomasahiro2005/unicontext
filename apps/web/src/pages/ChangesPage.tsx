import { TimezoneProvider } from '../components/AppContext';
import { ChangeRow } from '../components/Cards';
import { ConflictBanner } from '../components/ConflictBanner';
import { Async, Empty, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { dayKey, formatDateJa, formatShort, relativeDayLabel } from '../lib/dates';
import { groupByDay } from '../lib/sort';
import type { ChangesContext } from '../types';

export function ChangesPage() {
  usePageTitle('変更');
  const state = useApi<ChangesContext>('/api/v1/changes', { pollMs: 60_000 });
  return (
    <>
      <PageHeader title="変更" />
      <Async state={state}>
        {(ctx) => (
          <TimezoneProvider value={ctx.timezone}>
            <ChangesBody ctx={ctx} />
          </TimezoneProvider>
        )}
      </Async>
    </>
  );
}

function ChangesBody({ ctx }: { ctx: ChangesContext }) {
  const tz = ctx.timezone;
  const groups = groupByDay(
    ctx.changes.filter((c) => c.entityKind !== 'documentChunk'),
    (c) => c.occurredAt,
    tz,
  );
  const today = dayKey(new Date(), tz);
  return (
    <>
      <p className="meta">{formatShort(ctx.since, tz)}以降</p>
      <ConflictBanner count={ctx.conflicts.length} />
      {groups.length === 0 ? (
        <Empty />
      ) : (
        groups.map((g) => {
          const relative = g.key ? relativeDayLabel(g.key, today) : undefined;
          const id = `day-${g.key || 'unknown'}`;
          return (
            <section key={g.key} className="section" aria-labelledby={id}>
              <h2 id={id}>
                {g.key ? formatDateJa(g.key, tz) : '日時不明'}
                {relative ? <span className="count-chip">{relative}</span> : null}
              </h2>
              <div className="stack">
                {g.items.map((c) => (
                  <ChangeRow key={c.id} item={c} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
