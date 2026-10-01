import { ConfigError } from '@unicontext/core';
import { z } from 'zod';
import type { DriftTypeSpec } from './spec.js';

const PRIMITIVES: Record<string, z.ZodType> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  null: z.null(),
  any: z.unknown(),
  date: z.string(),
};

function leaf(token: string): z.ZodType {
  let optional = false;
  let text = token.trim();
  if (text.endsWith('?')) {
    optional = true;
    text = text.slice(0, -1).trim();
  }
  const parts = text.split('|').map((p) => p.trim());
  const schemas = parts.map((p) => {
    const s = PRIMITIVES[p];
    if (!s)
      throw new ConfigError(`Unknown drift type "${p}" (use string|number|boolean|null|any|date)`);
    return s;
  });
  const [first, ...rest] = schemas;
  if (!first) throw new ConfigError('Empty drift type');
  const base =
    rest.length === 0 ? first : z.union([first, ...rest] as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  return optional ? base.optional() : base;
}

/**
 * Convert the mapping's mini drift schema into zod for detectSchemaDrift (§73):
 *   { id: number, name: string, "term?": { name: string }, tags: [string], note: "string|null" }
 * A key ending in "?" is optional; "a|b" is a union ("null" allows null); `[T]` is an array of T.
 */
export function miniSchemaToZod(spec: DriftTypeSpec): z.ZodType {
  if (typeof spec === 'string') return leaf(spec);
  if (Array.isArray(spec)) {
    const element = spec[0];
    if (element === undefined) throw new ConfigError('Drift array types need an element type');
    return z.array(miniSchemaToZod(element));
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(spec)) {
    const optionalKey = key.endsWith('?');
    const name = optionalKey ? key.slice(0, -1) : key;
    const schema = miniSchemaToZod(value);
    shape[name] = optionalKey ? schema.optional() : schema;
  }
  return z.object(shape);
}
