import type { Clock, Logger, SecretStore } from '@unicontext/core';
import type { LcuAuthStrategy } from '../core/auth.js';
import type { LcuDeploymentProfile } from '../core/deployment.js';
import { BrowserSsoStrategy, type BrowserSsoStrategyOptions } from './browser-sso.js';
import { LocalAccountStrategy } from './local-account.js';

export { BrowserSsoStrategy, isLoggedInPage, type BrowserSessionLike } from './browser-sso.js';
export type { BrowserSsoStrategyOptions } from './browser-sso.js';
export { LocalAccountStrategy } from './local-account.js';

export type AuthStrategyKind = 'browser-sso' | 'local-account';

/** `saml` / `entra` / `browser-sso` → browser-sso; `local` → local-account. Config wins over profile. */
export function selectAuthStrategy(
  configAuth: string | undefined,
  productSettings: Record<string, unknown> | undefined,
): AuthStrategyKind {
  const raw =
    configAuth ??
    (typeof productSettings?.auth === 'string' ? productSettings.auth : undefined) ??
    'browser-sso';
  return raw === 'local' ? 'local-account' : 'browser-sso';
}

export interface CreateAuthStrategyOptions {
  sourceId: string;
  deployment: LcuDeploymentProfile;
  secrets: SecretStore;
  logger?: Logger | undefined;
  clock?: Clock | undefined;
  cacheDir?: string | undefined;
  configAuth?: string | undefined;
  productSettings?: Record<string, unknown> | undefined;
  /** Explicit opt-in (config or profile) for the local-account extension point. */
  allowLocalAccount?: boolean | undefined;
  browser?: BrowserSsoStrategyOptions['browser'];
  driver?: BrowserSsoStrategyOptions['driver'];
  createSession?: BrowserSsoStrategyOptions['createSession'];
}

export function createAuthStrategy(options: CreateAuthStrategyOptions): LcuAuthStrategy {
  const kind = selectAuthStrategy(options.configAuth, options.productSettings);
  if (kind === 'local-account')
    return new LocalAccountStrategy({
      sourceId: options.sourceId,
      allowed: options.allowLocalAccount === true,
    });
  return new BrowserSsoStrategy({
    sourceId: options.sourceId,
    deployment: options.deployment,
    secrets: options.secrets,
    logger: options.logger,
    clock: options.clock,
    cacheDir: options.cacheDir,
    browser: options.browser,
    driver: options.driver,
    createSession: options.createSession,
  });
}
