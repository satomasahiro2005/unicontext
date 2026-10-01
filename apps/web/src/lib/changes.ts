import { DEFAULT_TIMEZONE } from './dates.js';
import type { JsonValue } from './json.js';
import { changeTypeLabel, entityKindLabel, fieldLabel } from './labels.js';
import { formatValue } from './values.js';

/** The subset of the context engine's ChangeItem that rendering needs. */
export interface ChangeLike {
  id: string;
  entityKind: string;
  type: string;
  summary: string;
  changedFields: string[];
  before: Record<string, JsonValue> | null;
  after: Record<string, JsonValue> | null;
  occurredAt: string;
}

export interface ChangeDiff {
  field: string;
  label: string;
  before: string;
  after: string;
  /** `締切: 10/8 23:59 → 10/10 23:59` */
  text: string;
}

export interface ChangeView {
  kindLabel: string;
  typeLabel: string;
  headline: string;
  diffs: ChangeDiff[];
  hiddenDiffs: number;
}

const MAX_DIFFS = 8;
const SUBJECT = /^(.*?「[^」]*」)/;

/** Splits `課題「課題1」の締切: ...` into `課題「課題1」`; undefined when no quoted title exists. */
export function changeSubject(summary: string): string | undefined {
  return SUBJECT.exec(summary)?.[1];
}

/**
 * Before/after rendering of one change event (§45). Updates list one diff per changed field,
 * e.g. `締切: 10/8 23:59 → 10/10 23:59`; create/delete/restore/conflict events only carry a headline.
 */
export function describeChange(item: ChangeLike, timeZone: string = DEFAULT_TIMEZONE): ChangeView {
  const kindLabel = entityKindLabel(item.entityKind);
  const typeLabel = changeTypeLabel(item.type);
  const diffs: ChangeDiff[] = [];
  if (item.type === 'updated') {
    for (const field of item.changedFields) {
      const before = formatValue(item.before?.[field], timeZone);
      const after = formatValue(item.after?.[field], timeZone);
      const label = fieldLabel(field);
      diffs.push({ field, label, before, after, text: `${label}: ${before} → ${after}` });
    }
  }
  const shown = diffs.slice(0, MAX_DIFFS);
  const headline = diffs.length > 0 ? (changeSubject(item.summary) ?? item.summary) : item.summary;
  return {
    kindLabel,
    typeLabel,
    headline,
    diffs: shown,
    hiddenDiffs: diffs.length - shown.length,
  };
}
