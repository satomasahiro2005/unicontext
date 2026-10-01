import { ENTITY_SCHEMAS, type EntityKind } from '@unicontext/canonical-model';
import { parseZonedDate, toZonedIso, zonedDateString, zonedTime } from '@unicontext/core';
import type { z } from 'zod';

export type FieldKind =
  'datetime' | 'localDate' | 'number' | 'boolean' | 'string' | 'array' | 'other';

/** Fields holding a local calendar day ("YYYY-MM-DD") rather than an instant. */
const LOCAL_DATE_FIELDS = new Set(['date', 'startsOn', 'endsOn']);

interface Def {
  type?: string;
  format?: string;
  innerType?: z.ZodType;
}

function def(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

const fieldKindCache = new Map<string, FieldKind | undefined>();

/** Kind of a canonical entity field (undefined when the entity has no such field). */
export function fieldKind(kind: EntityKind, field: string): FieldKind | undefined {
  const key = `${kind}.${field}`;
  if (fieldKindCache.has(key)) return fieldKindCache.get(key);
  const shape = (ENTITY_SCHEMAS[kind] as unknown as { shape: Record<string, z.ZodType> }).shape;
  let result: FieldKind | undefined;
  let s: z.ZodType | undefined = shape[field];
  for (let i = 0; s && i < 10; i++) {
    const d = def(s);
    if (
      d.innerType &&
      ['optional', 'default', 'nullable', 'prefault', 'nonoptional'].includes(d.type ?? '')
    ) {
      s = d.innerType;
      continue;
    }
    if (d.type === 'string')
      result =
        d.format === 'datetime'
          ? 'datetime'
          : LOCAL_DATE_FIELDS.has(field)
            ? 'localDate'
            : 'string';
    else if (d.type === 'number') result = 'number';
    else if (d.type === 'boolean') result = 'boolean';
    else if (d.type === 'array') result = 'array';
    else result = 'other';
    break;
  }
  fieldKindCache.set(key, result);
  return result;
}

const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function normalizeOffset(raw: string): string {
  if (raw === 'Z' || raw === 'z') return 'Z';
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(raw);
  return m ? `${m[1]}${m[2]}:${m[3] ?? '00'}` : raw;
}

/**
 * Coerce a value into an ISO-8601 instant with offset. Strings with an offset keep it; bare local
 * datetimes and dates are interpreted in `timezone`; numbers are epoch seconds (< 1e11) or ms.
 * Returns undefined when the value is not a date.
 */
export function toIsoDateTime(value: unknown, timezone: string): string | undefined {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? undefined : toZonedIso(value, timezone);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toZonedIso(new Date(Math.abs(value) < 1e11 ? value * 1000 : value), timezone);
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^-?\d{10,13}$/.test(text)) return toIsoDateTime(Number(text), timezone);
  const dm = DATE_RE.exec(text);
  if (dm) {
    try {
      return toZonedIso(parseZonedDate(text, timezone), timezone);
    } catch {
      return undefined;
    }
  }
  const m = DATETIME_RE.exec(text);
  if (m) {
    const [, y, mo, d, h, mi, s, frac, off] = m;
    const secs = s ?? '00';
    if (off) {
      const iso = `${y}-${mo}-${d}T${h}:${mi}:${secs}${frac ?? ''}${normalizeOffset(off)}`;
      return Number.isNaN(new Date(iso).getTime()) ? undefined : iso;
    }
    const at = zonedTime(
      { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) },
      timezone,
    );
    const withSeconds = new Date(at.getTime() + Number(secs) * 1000);
    return Number.isNaN(withSeconds.getTime()) ? undefined : toZonedIso(withSeconds, timezone);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : toZonedIso(parsed, timezone);
}

/** Coerce a value into a local date "YYYY-MM-DD" in `timezone`. */
export function toLocalDate(value: unknown, timezone: string): string | undefined {
  if (typeof value === 'string' && DATE_RE.test(value.trim())) return value.trim();
  const iso = toIsoDateTime(value, timezone);
  if (!iso) return undefined;
  return zonedDateString(new Date(iso), timezone);
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return undefined;
}

export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'y'].includes(t)) return true;
    if (['false', 'no', '0', 'n'].includes(t)) return false;
  }
  return undefined;
}

export function toStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return undefined;
  return JSON.stringify(value);
}

export type ExplicitCoercion = 'string' | 'number' | 'boolean' | 'datetime' | 'date' | 'array';

/** Explicit `{expr, as}` coercion. Returns undefined when the value cannot be converted. */
export function coerceExplicit(value: unknown, as: ExplicitCoercion, timezone: string): unknown {
  switch (as) {
    case 'string':
      return toStringValue(value);
    case 'number':
      return toNumber(value);
    case 'boolean':
      return toBoolean(value);
    case 'datetime':
      return toIsoDateTime(value, timezone);
    case 'date':
      return toLocalDate(value, timezone);
    case 'array':
      return value === undefined || value === null
        ? undefined
        : Array.isArray(value)
          ? value
          : [value];
  }
}

/** Schema-driven coercion for a canonical field. `ok: false` means the value was unusable. */
export function coerceForField(
  kind: EntityKind,
  field: string,
  value: unknown,
  timezone: string,
): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  switch (fieldKind(kind, field)) {
    case 'datetime': {
      const v = toIsoDateTime(value, timezone);
      return v === undefined ? { ok: false } : { ok: true, value: v };
    }
    case 'localDate': {
      const v = toLocalDate(value, timezone);
      return v === undefined ? { ok: false } : { ok: true, value: v };
    }
    case 'number': {
      const v = toNumber(value);
      return v === undefined ? { ok: false } : { ok: true, value: v };
    }
    case 'boolean': {
      const v = toBoolean(value);
      return v === undefined ? { ok: false } : { ok: true, value: v };
    }
    case 'string': {
      const v = toStringValue(value);
      return v === undefined ? { ok: false } : { ok: true, value: v };
    }
    case 'array':
      return { ok: true, value: Array.isArray(value) ? value : [value] };
    default:
      return { ok: true, value };
  }
}
