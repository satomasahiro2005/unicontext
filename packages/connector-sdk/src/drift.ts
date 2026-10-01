import type { z } from 'zod';

export type DriftKind = 'unknown' | 'missing' | 'type_mismatch';

export interface DriftFinding {
  /** Dotted path, arrays as "[]", e.g. "schedule[].room". */
  path: string;
  kind: DriftKind;
}

export interface DriftOptions {
  /** Max array elements inspected per array (default 20). */
  arraySample?: number;
  maxDepth?: number;
}

interface Def {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  options?: z.ZodType[];
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

/** Strip wrappers; report whether the field may be absent. */
function unwrap(schema: z.ZodType): { schema: z.ZodType; optional: boolean } {
  let s = schema;
  let optional = false;
  for (let i = 0; i < 20; i++) {
    const d = defOf(s);
    if (
      (d.type === 'optional' ||
        d.type === 'default' ||
        d.type === 'prefault' ||
        d.type === 'catch') &&
      d.innerType
    ) {
      optional = true;
      s = d.innerType;
    } else if (
      (d.type === 'nullable' || d.type === 'readonly' || d.type === 'nonoptional') &&
      d.innerType
    ) {
      s = d.innerType;
    } else if (d.type === 'pipe' && d.in) {
      s = d.in;
    } else if (d.type === 'lazy') {
      return { schema: s, optional };
    } else {
      break;
    }
  }
  return { schema: s, optional };
}

/**
 * Compare a payload with the schema a connector expects (§73). Reports fields the API added
 * (unknown), fields it stopped sending (missing) and primitive type changes. Never throws, so
 * normalizers can call it on every item and keep going.
 */
export function detectSchemaDrift(
  payload: unknown,
  schema: z.ZodType,
  options: DriftOptions = {},
): DriftFinding[] {
  const sample = options.arraySample ?? 20;
  const maxDepth = options.maxDepth ?? 12;
  const found = new Map<string, DriftFinding>();
  const add = (path: string, kind: DriftKind): void => {
    const key = `${kind}:${path}`;
    if (!found.has(key)) found.set(key, { path: path || '$', kind });
  };

  const walk = (value: unknown, raw: z.ZodType, path: string, depth: number): void => {
    if (depth > maxDepth) return;
    const { schema: s } = unwrap(raw);
    const d = defOf(s);
    if (value === null || value === undefined) {
      if (value === null && defOf(raw).type !== 'nullable' && !raw.safeParse(null).success)
        add(path, 'type_mismatch');
      return;
    }
    if (d.type === 'object' && d.shape) {
      if (typeof value !== 'object' || Array.isArray(value)) {
        add(path, 'type_mismatch');
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const [key, fieldSchema] of Object.entries(d.shape)) {
        const childPath = path ? `${path}.${key}` : key;
        const { optional } = unwrap(fieldSchema);
        if (!(key in obj) || obj[key] === undefined) {
          if (!optional) add(childPath, 'missing');
          continue;
        }
        walk(obj[key], fieldSchema, childPath, depth + 1);
      }
      for (const key of Object.keys(obj)) {
        if (!(key in d.shape)) add(path ? `${path}.${key}` : key, 'unknown');
      }
      return;
    }
    if (d.type === 'array' && d.element) {
      if (!Array.isArray(value)) {
        add(path, 'type_mismatch');
        return;
      }
      for (const el of value.slice(0, sample)) walk(el, d.element, `${path}[]`, depth + 1);
      return;
    }
    if (d.type === 'union' && d.options) {
      const match = d.options.find((o) => o.safeParse(value).success);
      if (!match) add(path, 'type_mismatch');
      return;
    }
    if (!s.safeParse(value).success) add(path, 'type_mismatch');
  };

  try {
    walk(payload, schema, '', 0);
  } catch {
    add('$', 'type_mismatch');
  }
  return [...found.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
  );
}
