import { useState } from 'react';
import { AnnouncementRow } from '../components/Cards';
import { Async, Empty, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import type { AnnouncementsResponse } from '../types';

export function AnnouncementsPage() {
  usePageTitle('お知らせ');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const state = useApi<AnnouncementsResponse>(
    `/api/v1/announcements?limit=100${unreadOnly ? '&unreadOnly=1' : ''}`,
    { pollMs: 60_000 },
  );
  return (
    <>
      <PageHeader title="お知らせ">
        <label className="inline-field">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />
          <span>未読のみ</span>
        </label>
      </PageHeader>
      <Async state={state}>
        {({ announcements }) =>
          announcements.length === 0 ? (
            <Empty />
          ) : (
            <div className="stack">
              {announcements.map((a) => (
                <AnnouncementRow key={a.id} item={a} />
              ))}
            </div>
          )
        }
      </Async>
    </>
  );
}
