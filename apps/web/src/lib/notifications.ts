import { DEFAULT_TIMEZONE, formatShort } from './dates.js';
import { tightenJa, truncate } from './text.js';

export interface NotificationView {
  key: string;
  title: string;
  detail: string | undefined;
  priority: string | undefined;
  kind: string | undefined;
  at: string | undefined;
  /** Raw citation-like objects, passed to the Citations component. */
  citations: unknown[];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Tolerant reader for notification objects: the wire shape belongs to the notifications package,
 * so only well-known optional fields are read and the rest is ignored.
 */
export function describeNotification(
  n: unknown,
  index: number,
  timeZone: string = DEFAULT_TIMEZONE,
): NotificationView {
  const o = (typeof n === 'object' && n !== null ? n : {}) as Record<string, unknown>;
  const title = str(o.title) ?? str(o.summary) ?? str(o.message) ?? str(o.body) ?? '通知';
  const detail = str(o.body) ?? str(o.message) ?? str(o.detail);
  const at = str(o.createdAt) ?? str(o.at) ?? str(o.occurredAt);
  return {
    key: str(o.id) ?? `n${index}`,
    title: tightenJa(truncate(title, 120)),
    detail: detail && detail !== title ? tightenJa(truncate(detail, 240)) : undefined,
    priority: str(o.priority) ?? str(o.severity),
    kind: str(o.kind) ?? str(o.type),
    at: at ? formatShort(at, timeZone) : undefined,
    citations: Array.isArray(o.citations) ? o.citations : [],
  };
}
