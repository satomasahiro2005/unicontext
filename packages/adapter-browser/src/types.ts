/**
 * Minimal structural views of the Playwright objects the browser adapter uses. Playwright's own
 * `Page`/`BrowserContext` satisfy these interfaces, and tests can provide fakes without
 * downloading a browser.
 */

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix time in seconds; -1 for session cookies. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export type LoadState = 'load' | 'domcontentloaded' | 'networkidle';

export interface LocatorLike {
  count(): Promise<number>;
  first(): LocatorLike;
  click(options?: { timeout?: number }): Promise<void>;
  check(options?: { timeout?: number }): Promise<void>;
  /**
   * Type into a field (Playwright `locator.fill`). Optional: only a connector whose student chose
   * to store a password (SavedCredentialsAdapter) uses it, and never on OTP/MFA fields.
   */
  fill?(value: string, options?: { timeout?: number }): Promise<void>;
}

export interface PageLike {
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  goto(
    url: string,
    options?: { waitUntil?: LoadState | 'commit'; timeout?: number },
  ): Promise<unknown>;
  locator(selector: string): LocatorLike;
  waitForLoadState(state?: LoadState, options?: { timeout?: number }): Promise<void>;
  isClosed(): boolean;
  /** Close this tab (Playwright pages have it; optional for fakes). */
  close?(): Promise<void>;
}

export interface BrowserContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  cookies(urls?: string | string[]): Promise<BrowserCookie[]>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  headless: boolean;
  /** Installed browser channel such as "chrome" or "msedge" (no Playwright download needed). */
  channel?: string;
  executablePath?: string;
  locale?: string;
  timezoneId?: string;
  /**
   * 'block' keeps service workers from registering, so requests a page (or its dedicated workers)
   * makes reach the network and are visible to response listeners and routes.
   */
  serviceWorkers?: 'allow' | 'block';
  /** Fixed viewport (default: none, the window size). */
  viewport?: { width: number; height: number };
  /** Extra browser command-line switches. */
  args?: string[];
}

/** Opens a persistent (on-disk) browser profile. */
export interface BrowserDriver {
  launchPersistentContext(userDataDir: string, options: LaunchOptions): Promise<BrowserContextLike>;
}
