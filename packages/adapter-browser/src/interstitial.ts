import { type Logger, silentLogger } from '@unicontext/core';
import type { PageLike } from './types.js';

/**
 * Interstitial handlers dismiss meaningless screens that appear during a browser login (consent
 * prompts the user has already agreed to, "continue" pages). They are a narrow allow-list:
 *
 * - they NEVER type into credential, one-time-code or MFA fields (the runner refuses to call a
 *   handler on any page that has such a field);
 * - anything that needs a human returns `needs_human`, which surfaces as `auth_required`.
 */
export interface InterstitialContext {
  page: PageLike;
  url: URL;
  title: string;
  html: string;
  logger: Logger;
}

export type InterstitialOutcome =
  { action: 'handled' } | { action: 'not_applicable' } | { action: 'needs_human'; reason: string };

export interface InterstitialHandler {
  readonly id: string;
  readonly description: string;
  matches(ctx: InterstitialContext): boolean;
  handle(ctx: InterstitialContext): Promise<InterstitialOutcome>;
}

/** Fields that mean "a human must type something": passwords, OTP/MFA codes. */
const CREDENTIAL_FIELD_PATTERNS: RegExp[] = [
  /<input\b[^>]*\btype\s*=\s*["']?password\b/i,
  /<input\b[^>]*\bautocomplete\s*=\s*["']?one-time-code\b/i,
  /<input\b[^>]*\bname\s*=\s*["']?(otc|otp|totp|passcode|verificationcode|j_password|password)\b/i,
];

/** True when the page asks for a password, OTP or MFA code (handlers must not run there). */
export function hasCredentialField(html: string): boolean {
  return CREDENTIAL_FIELD_PATTERNS.some((re) => re.test(html));
}

/** Playwright selectors for credential/OTP inputs that are actually shown to the user. */
export const VISIBLE_CREDENTIAL_SELECTORS = [
  'input[type="password"]:visible',
  'input[autocomplete="one-time-code"]:visible',
  'input[name="otc"]:visible',
  'input[name="otp"]:visible',
  'input[name="passcode"]:visible',
] as const;

/**
 * True when the page shows a password/OTP field. Unlike hasCredentialField (HTML scan, used as a
 * conservative guard before handlers act), this ignores hidden fields — some service start pages
 * keep a hidden local-login password input next to their SSO button.
 */
export async function hasVisibleCredentialField(page: PageLike): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    for (const selector of VISIBLE_CREDENTIAL_SELECTORS)
      if ((await page.locator(selector).count()) > 0) return true;
    return false;
  } catch {
    return false;
  }
}

export interface InterstitialRunResult {
  /** Handler ids that acted, in order. */
  handled: string[];
  /** Set when a page needs a human (credentials, MFA, an unknown prompt a handler refused). */
  needsHuman?: string;
}

async function snapshot(page: PageLike, logger: Logger): Promise<InterstitialContext | undefined> {
  if (page.isClosed()) return undefined;
  try {
    const [title, html] = await Promise.all([page.title(), page.content()]);
    return { page, url: new URL(page.url()), title, html, logger };
  } catch {
    // Page is navigating; try again on the next poll.
    return undefined;
  }
}

/**
 * Run the first matching handler on `page` (repeating while handlers keep acting, up to
 * `maxSteps`). Pages with credential fields are never touched.
 */
export async function runInterstitials(
  page: PageLike,
  handlers: readonly InterstitialHandler[],
  options: { logger?: Logger; maxSteps?: number } = {},
): Promise<InterstitialRunResult> {
  const logger = options.logger ?? silentLogger;
  const result: InterstitialRunResult = { handled: [] };
  const maxSteps = options.maxSteps ?? 5;
  for (let step = 0; step < maxSteps; step++) {
    const ctx = await snapshot(page, logger);
    if (!ctx) return result;
    const handler = handlers.find((h) => {
      try {
        return h.matches(ctx);
      } catch {
        return false;
      }
    });
    if (!handler) return result;
    if (hasCredentialField(ctx.html)) {
      result.needsHuman = `${handler.id}: page asks for credentials; a human must continue`;
      return result;
    }
    const outcome = await handler.handle(ctx);
    if (outcome.action === 'needs_human') {
      result.needsHuman = `${handler.id}: ${outcome.reason}`;
      return result;
    }
    if (outcome.action === 'not_applicable') return result;
    logger.info('interstitial handled', { handler: handler.id, host: ctx.url.host });
    result.handled.push(handler.id);
  }
  return result;
}

export interface ShibbolethConsentOptions {
  /** IdP hosts the handler may act on. Default: ['idp.shizuoka.ac.jp']. */
  hosts?: string[];
  /** Path of the IdP SSO profile endpoints. Default: /idp/profile/SAML2/(Redirect|POST|POST-SimpleSign)/SSO */
  ssoPathPattern?: RegExp;
  /** Titles / headings identifying the attribute-release page. */
  markers?: string[];
  /** Select "_shib_idp_rememberConsent" when the option exists (default true). */
  remember?: boolean;
  /** Max time for the post-submit navigation. */
  timeoutMs?: number;
}

export const SHIBBOLETH_CONSENT_DEFAULTS = {
  hosts: ['idp.shizuoka.ac.jp'],
  ssoPathPattern: /^\/idp\/profile\/SAML2\/(Redirect|POST|POST-SimpleSign)\/SSO\b/,
  markers: ['送信属性の選択', 'Information Release', '属性送信', 'Attribute Release'],
} as const;

/**
 * Shibboleth IdP attribute-release consent ("送信属性の選択 / Information Release").
 *
 * The user explicitly asked for this screen to be accepted automatically: it appears on every
 * login and carries no decision for them. The handler only acts when ALL of these hold: the host is
 * an allowed IdP host, the path is the SAML2 SSO profile endpoint, the title/body has one of the
 * consent markers, the form has `_eventId_proceed`, and there is no credential field. It selects
 * `_shib_idp_rememberConsent` when present and presses 同意 (`_eventId_proceed`). It never presses
 * the reject button and never fills anything.
 */
export function shibbolethConsentHandler(
  options: ShibbolethConsentOptions = {},
): InterstitialHandler {
  const hosts = (options.hosts ?? [...SHIBBOLETH_CONSENT_DEFAULTS.hosts]).map((h) =>
    h.toLowerCase(),
  );
  const pathPattern = options.ssoPathPattern ?? SHIBBOLETH_CONSENT_DEFAULTS.ssoPathPattern;
  const markers = options.markers ?? [...SHIBBOLETH_CONSENT_DEFAULTS.markers];
  const remember = options.remember ?? true;
  const timeout = options.timeoutMs ?? 30_000;
  return {
    id: 'shibboleth-attribute-consent',
    description:
      'Accept the Shibboleth IdP attribute-release consent (送信属性の選択 / Information Release)',
    matches(ctx) {
      if (!hosts.includes(ctx.url.hostname.toLowerCase())) return false;
      if (!pathPattern.test(ctx.url.pathname)) return false;
      const text = `${ctx.title}\n${ctx.html}`;
      if (!markers.some((m) => text.includes(m))) return false;
      return /name\s*=\s*["']_eventId_proceed["']/.test(ctx.html);
    },
    async handle(ctx) {
      const proceed = ctx.page.locator('[name="_eventId_proceed"]');
      if ((await proceed.count()) === 0) return { action: 'not_applicable' };
      if (remember) {
        const rememberOption = ctx.page.locator(
          'input[name="_shib_idp_consentOptions"][value="_shib_idp_rememberConsent"]',
        );
        if ((await rememberOption.count()) > 0) await rememberOption.first().check({ timeout });
      }
      await proceed.first().click({ timeout });
      try {
        await ctx.page.waitForLoadState('load', { timeout });
      } catch {
        // The next poll re-inspects the page either way.
      }
      return { action: 'handled' };
    },
  };
}
