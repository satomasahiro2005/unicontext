import { useState } from 'react';
import { apiPost, errorMessage } from '../api';
import type { IdentityBody, IdentityLink, IdentityResponse } from '../types';
import { useAdmin } from './AppContext';
import { useToast } from './Toast';
import { Badge, Empty } from './ui';

/** Suggested identity links (§14) with 確認 / 却下 buttons. */
export function PendingLinks({
  links,
  onChanged,
}: {
  links: readonly IdentityLink[];
  onChanged?: () => void;
}) {
  const toast = useToast();
  const admin = useAdmin();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  async function decide(link: IdentityLink, action: 'confirm' | 'reject'): Promise<void> {
    setBusy(link.id);
    try {
      const body: IdentityBody = { leftId: link.leftId, rightId: link.rightId };
      await apiPost<IdentityResponse>(`/api/v1/identity/${action}`, body);
      setDone((s) => new Set(s).add(link.id));
      toast.success(
        action === 'confirm' ? '同じものとして確認しました' : '別のものとして却下しました',
      );
      void admin.refetch();
      onChanged?.();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  const visible = links.filter((l) => !done.has(l.id));
  if (visible.length === 0) return <Empty />;
  return (
    <ul className="plain-list">
      {visible.map((link) => (
        <li key={link.id} className="card">
          <p className="link-pair">
            <code>{link.leftId}</code>
            <span aria-hidden="true"> ⇄ </span>
            <code>{link.rightId}</code>
          </p>
          <p className="meta">
            <Badge tone="info">一致度{Math.round(link.score * 100)}%</Badge>
            <span>{link.method}</span>
          </p>
          {link.evidence.length > 0 ? (
            <ul className="evidence-list">
              {link.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
          <div className="actions">
            <button
              type="button"
              disabled={busy === link.id}
              onClick={() => void decide(link, 'confirm')}
            >
              確認
            </button>
            <button
              type="button"
              disabled={busy === link.id}
              onClick={() => void decide(link, 'reject')}
            >
              却下
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
