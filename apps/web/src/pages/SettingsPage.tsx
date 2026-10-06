import { useState } from 'react';
import { apiPost, enc, errorMessage } from '../api';
import { useTimezone } from '../components/AppContext';
import { Citations } from '../components/Citations';
import { useToast } from '../components/Toast';
import { Async, Badge, Empty, PageHeader, Section } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { formatShort } from '../lib/dates';
import type { JsonValue } from '../lib/json';
import { fieldLabel, importanceLabel, importanceTone, notificationKindLabel } from '../lib/labels';
import { describeNotification } from '../lib/notifications';
import { formatValue } from '../lib/values';
import { readTheme, saveTheme, THEME_OPTIONS, type ThemePreference } from '../theme';
import type {
  AdditionsResponse,
  AdditionView,
  Citation,
  NotificationsResponse,
  ProposalsResponse,
  ProposalView,
  SettingsResponse,
} from '../types';

export function SettingsPage() {
  usePageTitle('設定');
  return (
    <>
      <PageHeader title="設定" />
      <ThemeSection />
      <AdditionsSection />
      <ProposalsSection />
      <NotificationsSection />
      <SettingsSection />
    </>
  );
}

function ThemeSection() {
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  return (
    <Section title="表示">
      <label className="inline-field">
        <span>テーマ</span>
        <select
          value={theme}
          onChange={(e) => {
            const next = e.target.value as ThemePreference;
            setTheme(next);
            saveTheme(next);
          }}
        >
          {THEME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </Section>
  );
}

const PROPOSAL_STATUS: Record<ProposalView['status'], string> = {
  pending: '承認待ち',
  confirmed: '承認済み',
  rejected: '却下',
  expired: '期限切れ',
};

function ProposalsSection() {
  const state = useApi<ProposalsResponse>('/api/v1/proposals');
  const tz = useTimezone();
  const toast = useToast();
  const [busy, setBusy] = useState<string | undefined>(undefined);

  async function decide(p: ProposalView, action: 'confirm' | 'reject'): Promise<void> {
    setBusy(p.id);
    try {
      await apiPost(`/api/v1/proposals/${enc(p.id)}/${action}`);
      toast.success(action === 'confirm' ? '承認しました' : '却下しました');
      await state.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Section title="AIの提案">
      <Async state={state}>
        {({ proposals }) => {
          const sorted = [...proposals].sort(
            (a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'),
          );
          return sorted.length === 0 ? (
            <Empty />
          ) : (
            <ul className="plain-list stack">
              {sorted.map((p) => (
                <li key={p.id} className="card">
                  <header className="card-head">
                    <h3 className="card-title">{p.preview}</h3>
                    <Badge tone={p.status === 'pending' ? 'warn' : 'muted'}>
                      {PROPOSAL_STATUS[p.status]}
                    </Badge>
                  </header>
                  <p className="meta">
                    <span className="field-label">{fieldLabel(p.predicate)}</span>
                    <strong>{formatValue(p.value as JsonValue, tz)}</strong>
                    <span>期限{formatShort(p.expiresAt, tz)}</span>
                  </p>
                  {p.note ? <p className="note">{p.note}</p> : null}
                  {p.status === 'pending' ? (
                    <div className="actions">
                      <button
                        type="button"
                        disabled={busy === p.id}
                        onClick={() => void decide(p, 'confirm')}
                      >
                        承認
                      </button>
                      <button
                        type="button"
                        disabled={busy === p.id}
                        onClick={() => void decide(p, 'reject')}
                      >
                        却下
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          );
        }}
      </Async>
    </Section>
  );
}

const ADDITION_KIND: Record<AdditionView['kind'], string> = {
  lecture: '講義の記録',
  assignment: '課題',
  report: 'レポート',
  quiz: '小テスト',
  exam: '試験',
  prep: '準備',
  note: 'メモ',
  task: 'やること',
  condition: '本人の条件（グループ・履修）',
  session_rule: 'グループ別の日程',
  progress: '進み具合',
};

/** What AI clients added from lecture recordings, waiting for the user to confirm or reject. */
function AdditionsSection() {
  const state = useApi<AdditionsResponse>('/api/v1/additions');
  const toast = useToast();
  const [busy, setBusy] = useState<string | undefined>(undefined);

  async function decide(a: AdditionView, action: 'confirm' | 'reject'): Promise<void> {
    setBusy(a.id);
    try {
      await apiPost(`/api/v1/additions/${enc(a.id)}/${action}`);
      toast.success(action === 'confirm' ? '確認しました' : '却下しました');
      await state.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Section title="AIが追加した内容（チャットで登録・録音から）">
      <Async state={state}>
        {({ additions }) =>
          additions.length === 0 ? (
            <Empty />
          ) : (
            <ul className="plain-list stack">
              {additions.map((a) => (
                <li key={a.id} className="card">
                  <header className="card-head">
                    <h3 className="card-title">{a.title}</h3>
                    <Badge>{ADDITION_KIND[a.kind]}</Badge>
                    <Badge tone="warn">{a.label}</Badge>
                    {a.conflicts.length > 0 ? <Badge tone="bad">大学側と食い違い</Badge> : null}
                  </header>
                  <p className="meta">
                    {a.course ? <span>{a.course.title}</span> : null}
                    {a.dueText ? (
                      <>
                        <span className="field-label">日時</span>
                        <strong>{a.dueText}</strong>
                      </>
                    ) : null}
                    <span>
                      {a.source}
                      {a.recordingTimestamp ? ` ${a.recordingTimestamp}` : ''}
                    </span>
                  </p>
                  {a.attachedTo ? <p className="note">大学側の項目: {a.attachedTo.title}</p> : null}
                  {a.conflicts.map((c) => (
                    <p key={c.id} className="note">
                      {c.values
                        .map(
                          (v) =>
                            `${typeof v.value === 'string' ? v.value : JSON.stringify(v.value)}（${v.source}）`,
                        )
                        .join(' / ')}
                    </p>
                  ))}
                  {a.evidence ? <blockquote className="evidence">{a.evidence}</blockquote> : null}
                  <div className="actions">
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() => void decide(a, 'confirm')}
                    >
                      確認
                    </button>
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() => void decide(a, 'reject')}
                    >
                      却下
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Async>
    </Section>
  );
}

function isCitation(x: unknown): x is Citation {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { sourceReferenceId?: unknown }).sourceReferenceId === 'string' &&
    typeof (x as { label?: unknown }).label === 'string'
  );
}

function NotificationsSection() {
  const state = useApi<NotificationsResponse>('/api/v1/notifications');
  const tz = useTimezone();
  return (
    <Section title="通知">
      <Async state={state}>
        {({ notifications }) =>
          notifications.length === 0 ? (
            <Empty />
          ) : (
            <ul className="plain-list stack">
              {notifications.map((n, i) => {
                const v = describeNotification(n, i, tz);
                return (
                  <li key={v.key} className="card">
                    <header className="card-head">
                      {v.priority ? (
                        <Badge tone={importanceTone(v.priority)}>
                          {importanceLabel(v.priority)}
                        </Badge>
                      ) : null}
                      {v.kind ? <Badge>{notificationKindLabel(v.kind)}</Badge> : null}
                      <h3 className="card-title">{v.title}</h3>
                      {v.at ? <span className="meta">{v.at}</span> : null}
                    </header>
                    {v.detail ? <p className="note">{v.detail}</p> : null}
                    <Citations citations={v.citations.filter(isCitation)} />
                  </li>
                );
              })}
            </ul>
          )
        }
      </Async>
    </Section>
  );
}

function SettingsSection() {
  const state = useApi<SettingsResponse>('/api/v1/settings');
  return (
    <Section title="デーモン">
      <Async state={state}>
        {(s) => (
          <>
            <dl className="kv">
              <dt>バージョン</dt>
              <dd>{s.version}</dd>
              <dt>プロファイル</dt>
              <dd>{s.profile ?? 'なし'}</dd>
              <dt>タイムゾーン</dt>
              <dd>{s.timezone}</dd>
              <dt>テレメトリ</dt>
              <dd>{s.telemetry ? '有効' : '無効'}</dd>
              <dt>シークレット保管</dt>
              <dd>{s.secretBackend}</dd>
              <dt>データ</dt>
              <dd>
                <code>{s.dataDir}</code>
              </dd>
              <dt>設定ファイル</dt>
              <dd>
                <code>{s.configFile}</code>
              </dd>
            </dl>
            <details>
              <summary>設定の内容</summary>
              <pre className="config-dump">{JSON.stringify(s.config, null, 2)}</pre>
            </details>
          </>
        )}
      </Async>
    </Section>
  );
}
