import { useEffect, useId, useRef, useState } from 'react';
import { enc } from '../api';
import { useApi } from '../hooks';
import { dedupeCitations, describeLocation } from '../lib/citation';
import { formatShort } from '../lib/dates';
import { fieldLabel, originLabel } from '../lib/labels';
import { safeHttpUrl } from '../lib/text';
import { formatValue } from '../lib/values';
import type { Citation, SourceRefResponse } from '../types';
import { useTimezone } from './AppContext';
import { Badge, ErrorAlert } from './ui';

/** Source chips for one item (§49). Clicking a chip opens the 出典 panel for that source reference. */
export function Citations({ citations }: { citations: readonly Citation[] | undefined }) {
  const [open, setOpen] = useState<Citation | undefined>(undefined);
  const list = dedupeCitations(citations);
  if (list.length === 0) return <span className="no-source">出典なし</span>;
  return (
    <>
      <ul className="chips" aria-label="出典">
        {list.map((c) => (
          <li key={c.sourceReferenceId}>
            <button
              type="button"
              className="chip"
              aria-haspopup="dialog"
              title="出典を開く"
              onClick={() => setOpen(c)}
            >
              {c.label}
            </button>
          </li>
        ))}
      </ul>
      {open ? <SourceDialog citation={open} onClose={() => setOpen(undefined)} /> : null}
    </>
  );
}

function SourceDialog({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const tz = useTimezone();
  const state = useApi<SourceRefResponse>(`/api/v1/source-refs/${enc(citation.sourceReferenceId)}`);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const reference = state.data?.reference;
  const sourceSystem = reference?.sourceSystem ?? citation.sourceSystem;
  const sourceLabel = reference?.sourceLabel ?? citation.sourceLabel;
  const itemId = reference?.sourceItemId ?? citation.sourceItemId;
  const retrievedAt = reference?.retrievedAt ?? citation.retrievedAt;
  const authority = reference?.authority ?? citation.authority;
  const location = describeLocation(reference?.location ?? citation.location);
  const rawUrl = reference?.url ?? citation.url;
  const href = safeHttpUrl(rawUrl);
  const raw = state.data?.rawItem;

  return (
    <dialog
      ref={ref}
      className="source-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-header">
          <h2 id={titleId}>出典</h2>
          <button type="button" onClick={() => ref.current?.close()}>
            閉じる
          </button>
        </header>
        <dl className="kv">
          <dt>情報源</dt>
          <dd>{sourceLabel ?? sourceSystem}</dd>
          <dt>システム</dt>
          <dd>{sourceSystem}</dd>
          <dt>項目ID</dt>
          <dd>
            <code>{itemId}</code>
          </dd>
          <dt>取得日時</dt>
          <dd>{formatShort(retrievedAt, tz)}</dd>
          {location ? (
            <>
              <dt>場所</dt>
              <dd>{location}</dd>
            </>
          ) : null}
          <dt>区分</dt>
          <dd>{authority}</dd>
          {raw?.sourceUpdatedAt ? (
            <>
              <dt>元の更新日時</dt>
              <dd>{formatShort(raw.sourceUpdatedAt, tz)}</dd>
            </>
          ) : null}
          {raw?.deletedAt ? (
            <>
              <dt>削除</dt>
              <dd>{formatShort(raw.deletedAt, tz)}</dd>
            </>
          ) : null}
          {rawUrl ? (
            <>
              <dt>元のURL</dt>
              <dd>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {href}
                  </a>
                ) : (
                  <code>{rawUrl}</code>
                )}
              </dd>
            </>
          ) : null}
        </dl>
        <h3>この出典から得た事実</h3>
        {state.error ? (
          <ErrorAlert error={state.error} onRetry={() => void state.refetch()} />
        ) : null}
        {state.loading ? <p className="loading">読み込み中</p> : null}
        {state.data ? (
          state.data.facts.length === 0 ? (
            <p className="empty">なし</p>
          ) : (
            <ul className="fact-list">
              {state.data.facts.map((f) => (
                <li key={f.id}>
                  <strong>{fieldLabel(f.predicate)}</strong>
                  <span>{formatValue(f.value, tz)}</span>
                  <Badge>{originLabel(f.origin)}</Badge>
                  <small>{formatShort(f.observedAt, tz)}</small>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </dialog>
  );
}
