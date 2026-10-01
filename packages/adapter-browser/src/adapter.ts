import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type InteractiveAuthAdapter,
  type InteractiveLoginOptions,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { AuthRequiredError, type Clock, systemClock } from '@unicontext/core';
import type { BrowserSession } from './session.js';
import type { BrowserContextLike, PageLike } from './types.js';

export interface BrowserScrapeContext {
  page: PageLike;
  context: BrowserContextLike;
  input: SyncInput;
  session: BrowserSession;
}

export interface BrowserSourceAdapterOptions {
  id: string;
  version?: string;
  capabilities: Capability[];
  session: BrowserSession;
  /** Page to open before scraping (default: the session's startUrl). */
  url?: string;
  /** Read data from the authenticated page. Must be read-only (§50). */
  scrape(ctx: BrowserScrapeContext): Promise<SyncResult>;
  clock?: Clock;
}

/**
 * Generic last-resort adapter (§31): drives an authenticated, persistent browser profile and lets
 * a connector scrape pages. Prefer an HTTP/API connector whenever one exists; connectors that only
 * need the login (e.g. LiveCampusU) use BrowserSession directly and replay cookies over HTTP.
 */
export class BrowserSourceAdapter implements InteractiveAuthAdapter {
  readonly id: string;
  readonly version: string;
  private readonly clock: Clock;
  private healthState: HealthStatus;

  constructor(private readonly options: BrowserSourceAdapterOptions) {
    this.id = options.id;
    this.version = options.version ?? '1.0.0';
    this.clock = options.clock ?? systemClock;
    this.healthState = { state: 'healthy', checkedAt: this.clock.now().toISOString() };
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve([...this.options.capabilities]);
  }

  /** Non-interactive: a stored session (or a persistent profile) is enough to try a sync. */
  async authenticate(): Promise<AuthResult> {
    if (await this.options.session.hasStoredSession()) return { status: 'authenticated' };
    return {
      status: 'auth_required',
      message: `No browser session yet. Run \`unicontext login ${this.options.session.sourceId}\`.`,
    };
  }

  login(options?: InteractiveLoginOptions): Promise<AuthResult> {
    return this.options.session.login(options);
  }

  async logout(): Promise<void> {
    await this.options.session.clear({ profile: true });
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const out = await this.options.session.withPage(
      (page, context) =>
        this.options.scrape({ page, context, input, session: this.options.session }),
      this.options.url ? { url: this.options.url } : {},
    );
    const now = this.clock.now().toISOString();
    if ('auth' in out) {
      this.healthState = {
        state: 'auth_required',
        checkedAt: now,
        ...(out.auth.message ? { message: out.auth.message } : {}),
      };
      throw new AuthRequiredError(out.auth.message ?? 'Browser login required');
    }
    this.healthState = { state: 'healthy', checkedAt: now, lastSuccessAt: now };
    return out.result;
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ ...this.healthState });
  }

  async dispose(): Promise<void> {
    await this.options.session.close();
  }
}

export function createBrowserSourceAdapter(
  options: BrowserSourceAdapterOptions,
): BrowserSourceAdapter {
  return new BrowserSourceAdapter(options);
}
