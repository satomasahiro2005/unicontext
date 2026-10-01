import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError, NotFoundError } from './errors.js';

const HHMM = z.string().regex(/^\d{1,2}:\d{2}$/, 'expected HH:MM');

export const PeriodSchema = z.object({
  period: z.number().int().positive(),
  start: HHMM,
  end: HHMM,
});
export type PeriodDefinition = z.infer<typeof PeriodSchema>;

export const TermDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  year: z.number().int(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * University deployment profile (§54). Settings only: product code lives in connectors.
 * `products` holds per-product deployment settings (base URLs, auth strategy) consumed by connectors.
 */
export const ProfileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  locale: z.string().default('ja-JP'),
  academicCalendar: z.object({
    timezone: z.string().default('Asia/Tokyo'),
    periods: z.array(PeriodSchema).default([]),
    terms: z.array(TermDefinitionSchema).default([]),
  }),
  sources: z.record(z.string(), z.object({ product: z.string() }).passthrough()).default({}),
  products: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Optional authority overrides merged over the default conflict rules (§12). */
  authorityRules: z.record(z.string(), z.array(z.string())).optional(),
  privacy: z
    .object({
      /** Regex source for the university's student ID format; redacted from logs (§60). */
      studentIdPattern: z.string().optional(),
    })
    .default({}),
});
export type UniversityProfile = z.infer<typeof ProfileSchema>;

export function parseProfile(text: string): UniversityProfile {
  const result = ProfileSchema.safeParse(parseYaml(text));
  if (!result.success) {
    throw new ConfigError(
      `Invalid profile: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

/** profiles/ directory shipped in the repository (resolved relative to this package). */
export function builtinProfilesDir(): string {
  // packages/core/{src|dist}/profile.(ts|js) -> repo root /profiles
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'profiles');
}

/** Look up profiles/<id>/profile.yaml in searchPaths (first match wins), then the builtin dir. */
export function loadProfile(
  id: string,
  options: { searchPaths?: string[] } = {},
): UniversityProfile {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ConfigError(`Invalid profile id: ${id}`);
  const dirs = [...(options.searchPaths ?? []), builtinProfilesDir()];
  for (const dir of dirs) {
    const file = path.join(dir, id, 'profile.yaml');
    if (existsSync(file)) {
      const profile = parseProfile(readFileSync(file, 'utf8'));
      if (profile.id !== id) throw new ConfigError(`Profile id mismatch in ${file}: ${profile.id}`);
      return profile;
    }
  }
  throw new NotFoundError(`Profile not found: ${id}`, { details: { searched: dirs } });
}

/** Returns the period definition (e.g. 2限) from a profile, if defined. */
export function findPeriod(
  profile: UniversityProfile,
  period: number,
): PeriodDefinition | undefined {
  return profile.academicCalendar.periods.find((p) => p.period === period);
}
