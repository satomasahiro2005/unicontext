import { ConfigError, ValidationError } from '@unicontext/core';
import jsonata from 'jsonata';

/** `{{ jsonata }}` placeholder inside call templates (first capture = the expression). */
export const TEMPLATE_RE = /\{\{\s*(.+?)\s*\}\}/;

const cache = new Map<string, jsonata.Expression>();
const CACHE_LIMIT = 2000;

/** Compile (and cache) a JSONata expression. Syntax errors become ConfigError. */
export function compileExpr(source: string): jsonata.Expression {
  const hit = cache.get(source);
  if (hit) return hit;
  let compiled: jsonata.Expression;
  try {
    compiled = jsonata(source);
  } catch (e) {
    const err = e as { message?: string; position?: number };
    throw new ConfigError(
      `Invalid JSONata expression "${source}": ${err.message ?? String(e)}${
        err.position !== undefined ? ` (at ${err.position})` : ''
      }`,
      { cause: e },
    );
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(source, compiled);
  return compiled;
}

/** JSONata "sequences" are arrays with extra flags; hand out plain arrays. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, plain);
  return value;
}

/** Evaluate a JSONata expression. `undefined` means "no match". Runtime errors propagate. */
export async function evalExpr(
  source: string,
  input: unknown,
  bindings?: Record<string, unknown>,
): Promise<unknown> {
  const result: unknown = await compileExpr(source).evaluate(input ?? {}, bindings);
  return plain(result);
}

/** Evaluate an expression and treat any failure as "no value" (message returned for warnings). */
export async function tryEval(
  source: string,
  input: unknown,
  bindings?: Record<string, unknown>,
): Promise<{ value: unknown; error?: string }> {
  try {
    return { value: await evalExpr(source, input, bindings) };
  } catch (e) {
    const err = e as { message?: string };
    return { value: undefined, error: `${source}: ${err.message ?? String(e)}` };
  }
}

/** Result of an expression used as a list (select / forEach): undefined → [], scalar → [scalar]. */
export function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Render `{{expr}}` placeholders in strings, recursively through arrays and objects. A string that
 * is exactly one placeholder keeps the evaluated type (number, array, ...); placeholders inside a
 * longer string are stringified. An unresolved placeholder is an error (never silently empty, so a
 * missing id cannot turn into a list-everything request).
 */
export async function renderTemplate(
  value: unknown,
  scope: Record<string, unknown>,
): Promise<unknown> {
  if (typeof value === 'string') return renderString(value, scope);
  if (Array.isArray(value)) return Promise.all(value.map((v) => renderTemplate(v, scope)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await renderTemplate(v, scope);
    return out;
  }
  return value;
}

async function renderString(text: string, scope: Record<string, unknown>): Promise<unknown> {
  const re = new RegExp(TEMPLATE_RE.source, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return text;
  const resolve = async (expr: string): Promise<unknown> => {
    let v: unknown;
    try {
      v = await evalExpr(expr, scope);
    } catch (e) {
      throw new ValidationError(
        `Template {{${expr}}} failed: ${e instanceof Error ? e.message : String(e)}`,
        {
          cause: e,
        },
      );
    }
    if (v === undefined || v === null)
      throw new ValidationError(`Template {{${expr}}} did not resolve to a value`);
    return v;
  };
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && only[0] === text.trim() && only[1]) return resolve(only[1]);
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.index);
    const v = await resolve(m[1] ?? '');
    out += typeof v === 'object' ? JSON.stringify(v) : String(v);
    last = (m.index ?? 0) + m[0].length;
  }
  return out + text.slice(last);
}
