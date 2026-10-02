import { Link, useParams } from '@tanstack/react-router';
import { enc } from '../api';
import { useTimezone } from '../components/AppContext';
import { CourseLink } from '../components/Cards';
import { Citations } from '../components/Citations';
import { LinkedText } from '../components/LinkedText';
import { Async, Badge, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { formatShort } from '../lib/dates';
import { importanceLabel, importanceTone, scopeLabel } from '../lib/labels';
import { formatFileSize, safeHttpUrl } from '../lib/text';
import type { AnnouncementDetail, AnnouncementResponse } from '../types';

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
      <Async state={state}>{({ announcement }) => <Body a={announcement} />}</Async>
    </>
  );
}

function Body({ a }: { a: AnnouncementDetail }) {
  const tz = useTimezone();
  const original = safeHttpUrl(a.url);
  return (
    <article className="card">
      <header className="card-head">
        {a.read === true ? <Badge>既読</Badge> : null}
        {a.read === false ? <Badge tone="warn">未読</Badge> : null}
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
