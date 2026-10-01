import type { AuthResult, InteractiveLoginOptions } from '@unicontext/connector-sdk';

/** What the HTTP layer needs from a cookie jar (adapter-browser's CookieJar satisfies it). */
export interface LcuCookieJar {
  header(url: string): string;
  update(url: string, setCookie: string[]): void;
  get(name: string, url?: string): string | undefined;
}

/**
 * Authentication strategy behind the LCU session (§26). Strategies own credentials (SecretStore,
 * persistent browser profile); the product logic only ever sees a cookie jar.
 */
export interface LcuAuthStrategy {
  readonly id: string;
  /** Non-interactive status check (never opens a visible browser). */
  authenticate(): Promise<AuthResult>;
  /** Interactive login by a human (SSO + MFA). */
  login(options?: InteractiveLoginOptions): Promise<AuthResult>;
  /** Cookie jar for plain-HTTP replay; undefined when no session is stored. */
  cookies(): Promise<LcuCookieJar | undefined>;
  /**
   * One non-interactive attempt to re-establish the session (e.g. headless SSO through the
   * persistent browser profile). Never prompts. True when fresh cookies are available.
   */
  reauthenticate(signal?: AbortSignal): Promise<boolean>;
  /** Persist cookies the server rotated (e.g. a new JSESSIONID). Optional. */
  persist?(jar: LcuCookieJar): Promise<void>;
  /** Forget the stored session. */
  logout(): Promise<void>;
  dispose(): Promise<void>;
}
