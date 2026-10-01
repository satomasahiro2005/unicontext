import { useState } from 'react';
import { apiPost, enc, errorMessage } from '../api';
import { useAdmin, useTimezone } from '../components/AppContext';
import { useToast } from '../components/Toast';
import { Async, Badge, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { formatShort } from '../lib/dates';
import { healthLabel, healthSeverity, healthTone, needsLoginCommand } from '../lib/labels';
import type { SourceInfo, SourcesResponse, SyncResponse } from '../types';

export function SourcesPage() {
  usePageTitle('ソース');
  const state = useApi<SourcesResponse>('/api/v1/sources', { pollMs: 30_000 });
  const admin = useAdmin();
  return (
    <>
      <PageHeader title="ソース" />
      <Async state={state}>
        {({ sources }) => (
          <ul className="plain-list stack">
            {[...sources]
              .sort((a, b) => healthSeverity(b.state) - healthSeverity(a.state))
              .map((s) => (
                <SourceCard
                  key={s.sourceId}
                  source={s}
                  onSynced={() => {
                    void state.refetch();
                    void admin.refetch();
                  }}
                />
              ))}
          </ul>
        )}
      </Async>
    </>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const toast = useToast();
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('コピーしました');
    } catch {
      toast.error('コピーできませんでした。選択して手動でコピーしてください');
    }
  }
  return (
    <div className="command-line">
      <code tabIndex={0}>{command}</code>
      <button type="button" onClick={() => void copy()}>
        コピー
      </button>
    </div>
  );
}

function SourceCard({ source, onSynced }: { source: SourceInfo; onSynced: () => void }) {
  const tz = useTimezone();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const syncing = busy || source.running;

  async function sync(): Promise<void> {
    setBusy(true);
    try {
      const res = await apiPost<SyncResponse>(`/api/v1/sources/${enc(source.sourceId)}/sync`);
      const r = res.report;
      if (r.ok) {
        toast.success(`同期しました (追加${r.raw.inserted}件、更新${r.raw.updated}件)`);
      } else {
        toast.error(`同期に失敗しました${r.error ? `: ${r.error}` : ''}`);
      }
      onSynced();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card">
      <header className="card-head">
        <h2 className="card-title">{source.displayName ?? source.sourceId}</h2>
        <Badge tone={healthTone(source.state)}>{healthLabel(source.state)}</Badge>
        {!source.enabled ? <Badge>無効</Badge> : null}
        {source.versionKnown === false ? <Badge tone="warn">未確認のバージョン</Badge> : null}
        <button type="button" disabled={syncing || !source.loaded} onClick={() => void sync()}>
          {syncing ? '同期中' : '同期'}
        </button>
      </header>
      {source.message ? <p className="note">{source.message}</p> : null}
      {source.loadError ? (
        <p className="note" role="alert">
          {source.loadError}
        </p>
      ) : null}
      <dl className="kv">
        <dt>最終同期</dt>
        <dd>{source.lastSyncAt ? formatShort(source.lastSyncAt, tz) : 'なし'}</dd>
        <dt>最終成功</dt>
        <dd>{source.lastSuccessAt ? formatShort(source.lastSuccessAt, tz) : 'なし'}</dd>
        <dt>バージョン</dt>
        <dd>{source.detectedVersion ?? 'なし'}</dd>
        <dt>ドリフト</dt>
        <dd>
          {source.openDrift}件{source.openDrift > 0 ? <Badge tone="warn">要確認</Badge> : null}
        </dd>
        {source.connector ? (
          <>
            <dt>コネクタ</dt>
            <dd>
              <code>{source.connector}</code>
            </dd>
          </>
        ) : null}
        {source.schedule ? (
          <>
            <dt>間隔</dt>
            <dd>{source.schedule}</dd>
          </>
        ) : null}
      </dl>
      {needsLoginCommand(source.state) ? <CopyableCommand command={source.loginCommand} /> : null}
    </li>
  );
}
