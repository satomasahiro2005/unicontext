import { CapabilitySchema } from '@unicontext/canonical-model';
import { AdapterKindSchema } from '@unicontext/core';
import { z } from 'zod';

/**
 * Connector package metadata (§55) incl. unofficial API policy fields (§27).
 * Example: { name: "@unicontext/livecampusu", product: "LiveCampusU", license: "MIT", capabilities: [...],
 *            apiStability: "unofficial", risk: "unsupported", testedVersion: "..." }
 */
export const ConnectorMetadataSchema = z
  .object({
    name: z.string().min(1),
    product: z.string().min(1),
    version: z.string().min(1),
    license: z.string().min(1),
    description: z.string().optional(),
    capabilities: z.array(CapabilitySchema).min(1),
    adapter: AdapterKindSchema,
    apiStability: z.enum(['official', 'unofficial', 'experimental']),
    risk: z.enum(['supported', 'unsupported', 'experimental']).default('supported'),
    /** Product version the connector was tested against (§27). */
    testedVersion: z.string().optional(),
    /** Additional known-good versions; supports "x" wildcards such as "3.x". */
    testedVersions: z.array(z.string()).default([]),
    /** Authority class of facts from this source unless the normalizer says otherwise (§12). */
    defaultAuthority: z.string().default('unknown'),
    /** Display name for citations, e.g. "学務情報システム". */
    sourceLabel: z.string().optional(),
    /** Default schedule (§36): interval like "15m", or "push" | "event" | "manual". */
    defaultSchedule: z.string().default('15m'),
    /** Raw item types this connector emits. */
    rawTypes: z.array(z.string()).default([]),
    homepage: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.apiStability === 'unofficial') {
      if (m.risk === 'supported')
        ctx.addIssue({
          code: 'custom',
          path: ['risk'],
          message: 'unofficial connectors must declare risk "unsupported" or "experimental" (§27)',
        });
      if (!m.testedVersion && m.testedVersions.length === 0)
        ctx.addIssue({
          code: 'custom',
          path: ['testedVersion'],
          message: 'unofficial connectors must declare testedVersion (§27)',
        });
    }
  });
export type ConnectorMetadata = z.infer<typeof ConnectorMetadataSchema>;
export type ConnectorMetadataInput = z.input<typeof ConnectorMetadataSchema>;

export function defineMetadata(input: ConnectorMetadataInput): ConnectorMetadata {
  return ConnectorMetadataSchema.parse(input);
}

function versionMatches(pattern: string, version: string): boolean {
  if (pattern === version) return true;
  if (!pattern.includes('x') && !pattern.includes('*')) return false;
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[x*]/g, '[^.]+')}$`,
  );
  return re.test(version);
}

export interface ProductVersionEvaluation {
  known: boolean;
  state: 'healthy' | 'degraded';
  message: string | undefined;
}

/** §72: an unknown product version is a warning (degraded), not a failure. */
export function evaluateProductVersion(
  metadata: ConnectorMetadata,
  detected: string | undefined,
): ProductVersionEvaluation {
  if (!detected) return { known: false, state: 'healthy', message: undefined };
  const list = [
    ...(metadata.testedVersion ? [metadata.testedVersion] : []),
    ...metadata.testedVersions,
  ];
  if (list.length === 0 || list.some((p) => versionMatches(p, detected)))
    return { known: true, state: 'healthy', message: undefined };
  return {
    known: false,
    state: 'degraded',
    message: `${metadata.product} ${detected} has not been tested (tested: ${list.join(', ')})`,
  };
}
