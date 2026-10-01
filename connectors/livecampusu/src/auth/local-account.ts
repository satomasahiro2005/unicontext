import type { AuthResult } from '@unicontext/connector-sdk';
import { ConnectorError } from '@unicontext/core';
import type { LcuAuthStrategy, LcuCookieJar } from '../core/auth.js';

/**
 * `local-account` — STUB / extension point only.
 *
 * LCU-Web still contains a hidden local login form (`account` / `password`, `/webLogin`), but the
 * university authenticates students through Shibboleth SSO + Entra ID MFA. Posting that hidden form
 * would bypass the university's SSO/MFA, so this strategy deliberately does NOT implement it
 * (§27: no authentication bypass). It reports `failed` unless the deployment explicitly sets
 * `auth: local` AND `allowLocalAccount: true` — and even then it only documents the seam: a
 * deployment whose institution officially issues local LCU accounts would implement `login()` /
 * `reauthenticate()` here (credentials from the SecretStore, never from config).
 */
export class LocalAccountStrategy implements LcuAuthStrategy {
  readonly id = 'local-account';

  constructor(private readonly options: { sourceId: string; allowed: boolean }) {}

  private message(): string {
    return this.options.allowed
      ? 'LiveCampusU local-account login is not implemented (extension point only). Use auth: browser-sso.'
      : 'LiveCampusU local-account login is disabled: it would bypass the university SSO/MFA. Use auth: saml/entra (browser SSO); local accounts need `auth: local` and `allowLocalAccount: true` in the deployment profile.';
  }

  authenticate(): Promise<AuthResult> {
    return Promise.resolve({ status: 'failed', message: this.message() });
  }

  login(): Promise<AuthResult> {
    if (!this.options.allowed)
      return Promise.resolve({ status: 'failed', message: this.message() });
    return Promise.reject(new ConnectorError(this.message()));
  }

  cookies(): Promise<LcuCookieJar | undefined> {
    return Promise.resolve(undefined);
  }

  reauthenticate(): Promise<boolean> {
    return Promise.resolve(false);
  }

  logout(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
