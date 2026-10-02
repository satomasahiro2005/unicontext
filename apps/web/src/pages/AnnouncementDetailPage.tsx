import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { apiPost, enc, errorMessage } from '../api';
import { useTimezone } from '../components/AppContext';
import { CourseLink } from '../components/Cards';
import { Citations } from '../components/Citations';
import { LinkedText } from '../components/LinkedText';
import { useToast } from '../components/Toast';
import { Async, Badge, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { formatShort } from '../lib/dates';
import { importanceLabel, importanceTone, scopeLabel } from '../lib/labels';
import { formatFileSize, safeHttpUrl } from '../lib/text';
import type { AnnouncementDetail, AnnouncementResponse, OpenAnnouncementsReport } from '../types';

export function AnnouncementDetailPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const state = useApi<AnnouncementResponse>(id ? `/api/v1/announcements/${enc(id)}` : null);
  usePageTitle(state.data?.announcement.title ?? 'お知らせ');
  return (
    <>
      <PageHeader title={state.data?.announcement.title ?? 'お知らせ'} />
      <p className="meta">
        <Link to="/announcements">お知らせ一覧</Link>
      </p>
      <Async state={state}>
        {({ announcement }) => <Body a={announcement} reload={() => state.refetch()} />}
      </Async>
    </>
  );
}

function Body({ a, reload }: { a: AnnouncementDetail; reload: () => Promise<void> }) {
  const tz = useTimezone();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const original = safeHttpUrl(a.url);
  const unopened = a.bodyStatus === 'notOpened' || (a.bodyStatus === 'pending' && !a.body);

  // Showing the body here is reading it in UniContext: clear UniContext's own 未読 (never LCU's).
  const marked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!a.unread || !a.body || marked.current === a.id) return;
    marked.current = a.id;
    void apiPost(`/api/v1/announcements/${enc(a.id)}/read`, { read: true }).catch(() => undefined);
  }, [a.id, a.unread, a.body]);

  async function fetchBody(): Promise<void> {
    if (
      a.bodyStatus === 'notOpened' &&
      !window.confirm(
        'LiveCampusUではこのお知らせが既読になり、未読に戻せません。本文を取得しますか？',
      )
    )
      return;
    setBusy(true);
    try {
      const r = await apiPost<OpenAnnouncementsReport>('/api/v1/announcements/open', {
        ids: [a.id],
      });
      const result = r.results[0];
      if (result?.status === 'opened') toast.success('本文を取得しました');
      else toast.error(result?.error ?? '本文を取得できませんでした');
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function markUnread(): Promise<void> {
    try {
      await apiPost(`/api/v1/announcements/${enc(a.id)}/read`, { read: false });
      marked.current = a.id;
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <article className="card">
      <header className="card-head">
        {a.unread ? (
          <Badge tone="warn">未読</Badge>
        ) : a.read !== undefined ? (
          <Badge>既読</Badge>
        ) : null}
        <Badge tone={importanceTone(a.importance)}>{importanceLabel(a.importance)}</Badge>
        <Badge>{scopeLabel(a.scope)}</Badge>
        {a.category ? <Badge tone="info">{a.category}</Badge> : null}
      </header>
      <dl className="kv">
        {a.author ? (
          <>
            <dt>差出人</dt>
            <dd>{a.author}</dd>
          </>
        ) : null}
        {a.publishedAt ? (
          <>
            <dt>公開</dt>
            <dd>
              <time dateTime={a.publishedAt}>{formatShort(a.publishedAt, tz)}</time>
            </dd>
          </>
        ) : null}
        {a.targetDate ? (
          <>
            <dt>対象日</dt>
            <dd>{a.targetDate}</dd>
          </>
        ) : null}
        {a.course || a.courses.length > 0 ? (
          <>
            <dt>講義</dt>
            <dd>
              <CourseLink course={a.course} />
              {a.courses.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </dd>
          </>
        ) : null}
        {original ? (
          <>
            <dt>元の記事</dt>
            <dd>
              <a href={original} target="_blank" rel="noopener noreferrer">
                開く
              </a>
            </dd>
          </>
        ) : null}
      </dl>
      {a.body ? <LinkedText text={a.body} /> : null}
      {a.bodyStatus === 'notOpened' ? (
        <p className="note">
          LiveCampusUで未読のため、本文は未取得です。LiveCampusUで読むと、次の同期で取得します。
        </p>
      ) : null}
      {a.bodyStatus === 'pending' && !a.body ? (
        <p className="note">本文は次の同期で取得します。</p>
      ) : null}
      <div className="actions">
        {unopened ? (
          <button type="button" disabled={busy} onClick={() => void fetchBody()}>
            {a.bodyStatus === 'notOpened' ? '本文を取得（LCUで既読になります）' : '本文を取得'}
          </button>
        ) : null}
        {!a.unread && a.body ? (
          <button type="button" onClick={() => void markUnread()}>
            未読に戻す
          </button>
        ) : null}
      </div>
      {a.attachments.length > 0 ? (
        <section aria-label="添付ファイル">
          <h3>添付ファイル</h3>
          <ul>
            {a.attachments.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name}
                {f.size !== undefined && formatFileSize(f.size) ? (
                  <span className="meta">{formatFileSize(f.size)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {a.links.length > 0 ? (
        <section aria-label="リンク">
          <h3>リンク</h3>
          <ul>
            {a.links.map((l) => {
              const href = safeHttpUrl(l);
              return (
                <li key={l}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {l}
                    </a>
                  ) : (
                    l
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <Citations citations={a.citations} />
    </article>
  );
}
