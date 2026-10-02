import { useState } from 'react';
import { apiPost, enc, errorMessage } from '../api';
import { formatDateTimeYear, formatShort } from '../lib/dates';
import { submissionStatusLabel, submissionStatusTone, materialKindLabel } from '../lib/labels';
import { formatFileSize, groupByChannel, groupByFolder, safeHttpUrl } from '../lib/text';
import type {
  CourseAssignmentItem,
  CourseFileItem,
  DiscussionItem,
  DownloadFilesResponse,
} from '../types';
import { useTimezone } from './AppContext';
import { useToast } from './Toast';
import { Citations } from './Citations';
import { Badge, Section } from './ui';

function OpenLink({ url, label = '開く' }: { url: string | undefined; label?: string }) {
  const href = safeHttpUrl(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

function PostCard({ item }: { item: DiscussionItem }) {
  const tz = useTimezone();
  return (
    <article className="card">
      <header className="card-head">
        {item.kind === 'announcement' ? <Badge tone="info">お知らせ</Badge> : null}
        {item.isReply ? <Badge>返信</Badge> : null}
        {item.authorRole === 'instructor' ? <Badge tone="ok">教員</Badge> : null}
        <h3 className="card-title">{item.title ?? item.author ?? 'Teams'}</h3>
        {item.sentAt ? (
          <time className="meta" dateTime={item.sentAt}>
            {formatShort(item.sentAt, tz)}
          </time>
        ) : null}
      </header>
      {item.author && item.title ? <p className="meta">{item.author}</p> : null}
      {item.body ? <p className="body-text clamp-3">{item.body}</p> : null}
      {item.attachments.length > 0 ? (
        <ul className="inline-list">
          {item.attachments.map((a, i) => (
            <li key={`${a.name}-${i}`}>
              {safeHttpUrl(a.url) ? <OpenLink url={a.url} label={a.name} /> : a.name}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="meta">
        <OpenLink url={item.url} />
      </p>
      <Citations citations={item.citations} />
    </article>
  );
}

export function DiscussionSection({ items }: { items: readonly DiscussionItem[] }) {
  if (items.length === 0) return null;
  return (
    <Section title="Teamsの投稿" count={items.length}>
      {groupByChannel(items).map((g) => (
        <div key={g.channel ?? ''}>
          {g.channel ? <h3 className="day-heading">{g.channel}</h3> : null}
          <div className="stack">
            {g.items.map((p) => (
              <PostCard key={p.id} item={p} />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

/**
 * Download through UniContext (read-only at SharePoint): the daemon fetches the file into its local
 * copy and extracts its text for search, then the browser saves that copy.
 */
function DownloadButton({ item }: { item: CourseFileItem }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const r = await apiPost<DownloadFilesResponse>('/api/v1/files/download', { ids: [item.id] });
      const f = r.results[0];
      if (f && (f.status === 'downloaded' || f.status === 'cached')) {
        window.location.assign(`/api/v1/files/${enc(item.id)}/content`);
        if (f.path) toast.success(`保存しました: ${f.path}`);
      } else if (f?.status === 'tooLarge')
        toast.error('ファイルが大きすぎます（上限は設定のfiles.maxDownloadMB）');
      else toast.error(f?.error ?? 'ダウンロードできませんでした');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" disabled={busy} onClick={() => void download()}>
      {busy ? 'ダウンロード中…' : 'ダウンロード'}
    </button>
  );
}

function FileRow({ item }: { item: CourseFileItem }) {
  const tz = useTimezone();
  const href = safeHttpUrl(item.url);
  return (
    <li className="card card-compact">
      <span className="card-head">
        {item.materialKind ? <Badge>{materialKindLabel(item.materialKind)}</Badge> : null}
        <span className="card-title">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </span>
      </span>
      <span className="meta">
        {item.sizeBytes !== undefined ? <span>{formatFileSize(item.sizeBytes)}</span> : null}
        {item.modifiedAt ? (
          <time dateTime={item.modifiedAt}>{formatShort(item.modifiedAt, tz)}</time>
        ) : null}
        {item.modifiedBy ? <span>{item.modifiedBy}</span> : null}
        <DownloadButton item={item} />
      </span>
      <Citations citations={item.citations} />
    </li>
  );
}

export function FilesSection({
  items,
  total,
}: {
  items: readonly CourseFileItem[];
  total: number;
}) {
  if (items.length === 0) return null;
  return (
    <Section title="ファイル" count={total}>
      {groupByFolder(items).map((g) => (
        <div key={g.folder}>
          <h3 className="day-heading">{g.folder || 'ルート'}</h3>
          <ul className="plain-list stack">
            {g.items.map((f) => (
              <FileRow key={f.id} item={f} />
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

function AssignmentRow({ item }: { item: CourseAssignmentItem }) {
  const tz = useTimezone();
  return (
    <article className="card">
      <header className="card-head">
        {item.status ? (
          <Badge tone={submissionStatusTone(item.status)}>
            {submissionStatusLabel(item.status)}
          </Badge>
        ) : null}
        <h3 className="card-title">{item.title}</h3>
      </header>
      <p className="meta">
        {item.dueAt ? (
          <>
            <span>締切</span>
            <time dateTime={item.dueAt}>{formatDateTimeYear(item.dueAt, tz)}</time>
          </>
        ) : null}
        {item.points !== undefined ? <span>{item.points}点</span> : null}
        {item.submittedAt ? (
          <>
            <span>提出</span>
            <time dateTime={item.submittedAt}>{formatDateTimeYear(item.submittedAt, tz)}</time>
          </>
        ) : null}
        <OpenLink url={item.url} />
      </p>
      <Citations citations={item.citations} />
    </article>
  );
}

export function AssignmentsSection({ items }: { items: readonly CourseAssignmentItem[] }) {
  if (items.length === 0) return null;
  return (
    <Section title="課題" count={items.length}>
      <div className="stack">
        {items.map((a) => (
          <AssignmentRow key={a.id} item={a} />
        ))}
      </div>
    </Section>
  );
}
