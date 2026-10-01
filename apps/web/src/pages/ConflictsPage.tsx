import { useAdmin } from '../components/AppContext';
import { ConflictResolver } from '../components/ConflictCard';
import { PendingLinks } from '../components/PendingLinks';
import { Async, Empty, PageHeader, Section } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import type { ConflictsResponse } from '../types';

export function ConflictsPage() {
  usePageTitle('競合');
  const state = useApi<ConflictsResponse>('/api/v1/conflicts');
  const admin = useAdmin();
  const refresh = (): void => {
    void state.refetch();
    void admin.refetch();
  };
  return (
    <>
      <PageHeader title="競合" />
      <Async state={state}>
        {({ conflicts }) =>
          conflicts.length === 0 ? (
            <Empty />
          ) : (
            <div className="stack">
              {conflicts.map((c) => (
                <ConflictResolver key={c.id} item={c} onResolved={refresh} />
              ))}
            </div>
          )
        }
      </Async>
      {admin.data && admin.data.pendingLinks.length > 0 ? (
        <Section title="紐付けの確認" count={admin.data.pendingLinks.length}>
          <PendingLinks links={admin.data.pendingLinks} onChanged={refresh} />
        </Section>
      ) : null}
    </>
  );
}
