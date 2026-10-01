import { DEFAULT_SENSITIVE_KEY_PATTERN } from '@unicontext/core';

export interface StripResult<T> {
  value: T;
  /** Dotted paths of removed keys (values are never reported). */
  removed: string[];
}

/**
 * Credential guard: deep-copy `value` without keys that look like credentials
 * (DEFAULT_SENSITIVE_KEY_PATTERN: token, password, cookie, authorization, ...). Only keys holding
 * a non-empty string, number, object or array are removed; `null`, booleans and empty strings
 * (e.g. `has_token: false`) carry no secret and stay.
 */
export function stripCredentials<T>(
  value: T,
  pattern: RegExp = DEFAULT_SENSITIVE_KEY_PATTERN,
): StripResult<T> {
  const removed: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (depth > 40 || seen.has(v)) return undefined;
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (pattern.test(k) && x !== null && x !== undefined) {
          const secretLike =
            (typeof x === 'string' && x.length > 0) ||
            typeof x === 'number' ||
            typeof x === 'object';
          if (secretLike) {
            removed.push(p);
            continue;
          }
        }
        out[k] = walk(x, p, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return { value: walk(value, '', 0) as T, removed };
}
