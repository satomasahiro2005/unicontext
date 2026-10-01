import { readFileSync } from 'node:fs';
import { ConfigError } from '@unicontext/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const AuthorityRulesSchema = z.object({
  version: z.number().int().default(1),
  userOverrides: z.boolean().default(true),
  recencyOverride: z.enum(['conflict', 'recency', 'authority']).default('conflict'),
  minConfidence: z.number().min(0).max(1).default(0.5),
  predicates: z.record(z.string(), z.array(z.string())).default({}),
  default: z.array(z.string()).default([]),
});
export type AuthorityRules = z.infer<typeof AuthorityRulesSchema>;

export function parseAuthorityRules(yamlText: string): AuthorityRules {
  const res = AuthorityRulesSchema.safeParse(parseYaml(yamlText));
  if (!res.success)
    throw new ConfigError(
      `Invalid authority rules: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return res.data;
}

/** The rules shipped with UniContext (packages/provenance/default-rules.yaml). */
export function loadDefaultAuthorityRules(): AuthorityRules {
  return parseAuthorityRules(
    readFileSync(new URL('../default-rules.yaml', import.meta.url), 'utf8'),
  );
}

/** Overlay predicate lists (e.g. from a university profile's authorityRules). */
export function mergeAuthorityRules(
  base: AuthorityRules,
  overrides: Partial<AuthorityRules> | undefined,
): AuthorityRules {
  if (!overrides) return base;
  return AuthorityRulesSchema.parse({
    ...base,
    ...overrides,
    predicates: { ...base.predicates, ...(overrides.predicates ?? {}) },
  });
}

/** Ordered authority list for a predicate. */
export function authorityOrder(rules: AuthorityRules, predicate: string): string[] {
  return rules.predicates[predicate] ?? rules.default;
}
