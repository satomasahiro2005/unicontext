import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { apiPost, enc, errorMessage } from '../api';
import { formatShort, zonedLocalToIso } from '../lib/dates';
import type { JsonValue } from '../lib/json';
import { fieldLabel, originLabel } from '../lib/labels';
import { formatValue, looksLikeInstants, parseCorrectionValue } from '../lib/values';
import type { ConflictItem, CorrectBody, CorrectResponse } from '../types';
import { useTimezone } from './AppContext';
import { CandidateList } from './Cards';
import { Citations } from './Citations';
import { useToast } from './Toast';
import { Badge } from './ui';

function ConflictHead({ item }: { item: ConflictItem }) {
  const tz = useTimezone();
  return (
    <header className="card-head">
      <Badge tone="bad">競合</Badge>
      <h3 className="card-title">{item.subjectLabel}</h3>
      <Badge>{fieldLabel(item.predicate)}</Badge>
      <time className="meta" dateTime={item.detectedAt}>
        {formatShort(item.detectedAt, tz)}
      </time>
    </header>
  );
}

/** Read-only conflict: every candidate with its source, no pick made for the user. */
export function ConflictSummary({ item }: { item: ConflictItem }) {
  return (
    <article className="card conflict-card">
      <ConflictHead item={item} />
      <CandidateList candidates={item.candidates} />
      <p className="meta">
        <Link to="/conflicts">解決する</Link>
      </p>
    </article>
  );
}

/** Conflict with a correction form: choose a candidate or enter a value (§74). */
export function ConflictResolver({
  item,
  onResolved,
}: {
  item: ConflictItem;
  onResolved: () => void;
}) {
  const tz = useTimezone();
  const toast = useToast();
  const [choice, setChoice] = useState<string>('');
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const instants = looksLikeInstants(item.candidates.map((c) => c.value));
  const hints = item.candidates.map((c) => c.value);
  const name = `choice-${item.id}`;

  function currentValue(): JsonValue | undefined {
    if (choice === 'custom') {
      if (instants) return custom ? zonedLocalToIso(custom, tz) : undefined;
      return parseCorrectionValue(custom, hints);
    }
    const idx = Number(choice);
    return choice !== '' && Number.isInteger(idx) ? item.candidates[idx]?.value : undefined;
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const value = currentValue();
    if (value === undefined) return;
    setBusy(true);
    try {
      const body: CorrectBody = note.trim() ? { value, note: note.trim() } : { value };
      await apiPost<CorrectResponse>(`/api/v1/facts/${enc(item.id)}/correct`, body);
      toast.success('修正を保存しました');
      onResolved();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card conflict-card">
      <ConflictHead item={item} />
      <form onSubmit={(e) => void submit(e)}>
        <fieldset>
          <legend>正しい値</legend>
          {item.candidates.map((c, i) => (
            <div className="choice" key={`${c.source}-${i}`}>
              <label>
                <input
                  type="radio"
                  name={name}
                  value={String(i)}
                  checked={choice === String(i)}
                  onChange={() => setChoice(String(i))}
                />
                <strong className="candidate-value">{formatValue(c.value, tz)}</strong>
              </label>
              <span className="candidate-source">{c.citation?.sourceLabel ?? c.source}</span>
              <Badge>{originLabel(c.origin)}</Badge>
              <Citations citations={c.citation ? [c.citation] : []} />
            </div>
          ))}
          <div className="choice">
            <label>
              <input
                type="radio"
                name={name}
                value="custom"
                checked={choice === 'custom'}
                onChange={() => setChoice('custom')}
              />
              <span>別の値</span>
            </label>
            {instants ? (
              <input
                type="datetime-local"
                aria-label="別の値"
                value={custom}
                onFocus={() => setChoice('custom')}
                onChange={(e) => {
                  setChoice('custom');
                  setCustom(e.target.value);
                }}
              />
            ) : (
              <input
                type="text"
                aria-label="別の値"
                value={custom}
                onFocus={() => setChoice('custom')}
                onChange={(e) => {
                  setChoice('custom');
                  setCustom(e.target.value);
                }}
              />
            )}
          </div>
        </fieldset>
        <label className="note-field">
          <span>メモ</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy || currentValue() === undefined}>
            この値で確定
          </button>
        </div>
      </form>
    </article>
  );
}
