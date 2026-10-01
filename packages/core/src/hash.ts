import { createHash, randomUUID } from 'node:crypto';

/** JSON.stringify with sorted object keys (undefined dropped), so equal values hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** sha256 of the stable JSON form of a value. */
export function contentHash(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Deterministic UUID (v5 layout, SHA-1 based) from arbitrary parts. */
export function stableUuid(...parts: string[]): string {
  const h = createHash('sha1').update(parts.join('\u0000')).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function newUuid(): string {
  return randomUUID();
}
