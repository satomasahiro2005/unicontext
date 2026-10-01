import type { ConnectorContext } from '@unicontext/connector-sdk';
import { ConfigError } from '@unicontext/core';
import { LcuPublicStrategy } from './lcu/strategy.js';
import { resolveDeployment } from './profiles/index.js';
import type { SyllabusStrategy } from './strategy.js';
import type { SyllabusConfig } from './types.js';

export type StrategyFactory = (ctx: ConnectorContext<SyllabusConfig>) => SyllabusStrategy;

/** Product key under `profile.products` where the syllabus deployment settings live. */
export const SYLLABUS_PRODUCT = 'syllabus';

const STRATEGIES = new Map<string, StrategyFactory>([
  [
    'lcu-public',
    (ctx) =>
      new LcuPublicStrategy({
        deployment: resolveDeployment(ctx.config, ctx.profile?.products[SYLLABUS_PRODUCT], {
          requireScreens: ['syllabusSearch', 'syllabusDetail'],
        }),
      }),
  ],
]);

/** Plug in another syllabus system (a strategy is selected by `strategy:` in config). */
export function registerSyllabusStrategy(id: string, factory: StrategyFactory): void {
  STRATEGIES.set(id, factory);
}

export function createStrategy(ctx: ConnectorContext<SyllabusConfig>): SyllabusStrategy {
  const factory = STRATEGIES.get(ctx.config.strategy);
  if (!factory)
    throw new ConfigError(
      `Unknown syllabus strategy "${ctx.config.strategy}" (known: ${[...STRATEGIES.keys()].join(', ')})`,
    );
  return factory(ctx);
}
