import type { JsonValue } from '@unicontext/canonical-model';
import type { AnnouncementAttachment } from './types.js';

/** Connector-supplied details of an announcement (`announcement.extra`), validated defensively. */
export interface AnnouncementExtra {
  read: boolean | undefined;
  /**
   * UniContext opened it while it was unread at the source (which marked it read there), so the
   * source's read state is not the student's reading.
   */
  openedByUniContext: boolean;
  bodyStatus: string | undefined;
  attachments: AnnouncementAttachment[];
  links: string[];
  courses: string[];
  targetDate: string | undefined;
}

const isObject = (v: unknown): v is Record<string, JsonValue> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** Reads the optional connector fields; anything absent or of the wrong type counts as unknown. */
export function readAnnouncementExtra(
  extra: Record<string, JsonValue> | undefined,
): AnnouncementExtra {
  const e = extra ?? {};
  const attachments: AnnouncementAttachment[] = [];
  if (Array.isArray(e.attachments)) {
    for (const a of e.attachments) {
      if (!isObject(a) || typeof a.name !== 'string' || a.name.length === 0) continue;
      attachments.push(
        typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0
          ? { name: a.name, size: a.size }
          : { name: a.name },
      );
    }
  }
  return {
    read: typeof e.read === 'boolean' ? e.read : undefined,
    openedByUniContext: e.openedByUniContext === true,
    bodyStatus: typeof e.bodyStatus === 'string' ? e.bodyStatus : undefined,
    attachments,
    links: strings(e.links),
    courses: strings(e.courses),
    targetDate:
      typeof e.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.targetDate)
        ? e.targetDate
        : undefined,
  };
}
