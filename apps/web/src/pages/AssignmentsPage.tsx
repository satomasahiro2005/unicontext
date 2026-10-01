import { useState } from 'react';
import { TaskRow } from '../components/Cards';
import { Async, Empty, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { sortByDue } from '../lib/sort';
import type { AssignmentsResponse } from '../types';

const FILTERS = [
  { value: 'open', label: '未完了', query: '' },
  { value: 'done', label: '提出済み・完了', query: '?status=submitted,completed' },
  {
    value: 'all',
    label: 'すべて',
    query: '?status=pending,in_progress,submitted,completed,cancelled,unknown',
  },
] as const;

export function AssignmentsPage() {
  usePageTitle('課題');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('open');
  const query = FILTERS.find((f) => f.value === filter)?.query ?? '';
  const state = useApi<AssignmentsResponse>(`/api/v1/assignments${query}`);
  return (
    <>
      <PageHeader title="課題">
        <label className="inline-field">
          <span>表示</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </PageHeader>
      <Async state={state}>
        {({ assignments }) => (
          <>
            {assignments.length === 0 ? (
              <Empty />
            ) : (
              <div className="stack">
                {sortByDue(assignments).map((a) => (
                  <TaskRow key={a.taskId} item={a} />
                ))}
              </div>
            )}
          </>
        )}
      </Async>
    </>
  );
}
