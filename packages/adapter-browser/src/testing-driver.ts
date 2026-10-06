import type {
  BrowserContextLike,
  BrowserCookie,
  BrowserDriver,
  LaunchOptions,
  LocatorLike,
  PageLike,
} from './types.js';

/**
 * Scripted in-memory browser for tests (no Playwright, no network). Screens are keyed by URL
 * (exact, then origin+pathname); `selectors` lists what `locator(sel).count()` finds; `clicks`
 * maps a selector to the URL the click navigates to.
 */
export interface FakeScreen {
  title: string;
  html: string;
  selectors?: string[];
  clicks?: Record<string, string>;
}

export class FakePage implements PageLike {
  private current = 'about:blank';
  closed = false;

  constructor(private readonly driver: FakeBrowserDriver) {}

  url(): string {
    return this.current;
  }

  private screen(): FakeScreen {
    return this.driver.screenFor(this.current);
  }

  title(): Promise<string> {
    return Promise.resolve(this.screen().title);
  }

  content(): Promise<string> {
    return Promise.resolve(this.screen().html);
  }

  navigate(url: string): void {
    let target = url;
    for (let i = 0; i < 10 && this.driver.redirects[target]; i++)
      target = this.driver.redirects[target] as string;
    this.current = target;
    this.driver.visited.push(target);
  }

  goto(url: string): Promise<unknown> {
    this.navigate(url);
    return Promise.resolve(null);
  }

  locator(selector: string): LocatorLike {
    const locator: LocatorLike = {
      count: () => {
        const s = this.screen();
        const present = s.selectors?.includes(selector) || selector in (s.clicks ?? {});
        return Promise.resolve(present ? 1 : 0);
      },
      first: () => locator,
      click: () => {
        this.driver.clicked.push(selector);
        const next = this.screen().clicks?.[selector];
        if (!next) return Promise.reject(new Error(`nothing to click: ${selector}`));
        this.navigate(next);
        return Promise.resolve();
      },
      check: () => {
        this.driver.checked.push(selector);
        return Promise.resolve();
      },
    };
    return locator;
  }

  waitForLoadState(): Promise<void> {
    return Promise.resolve();
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Page script evaluation, answered by `driver.evaluate` (undefined without one). */
  evaluate(expression: string): Promise<unknown> {
    return Promise.resolve(this.driver.evaluate?.(this, expression));
  }
}

export class FakeBrowserContext implements BrowserContextLike {
  readonly list: FakePage[];
  closed = false;

  constructor(private readonly driver: FakeBrowserDriver) {
    this.list = [new FakePage(driver)];
  }

  pages(): PageLike[] {
    return this.list.filter((p) => !p.closed);
  }

  newPage(): Promise<PageLike> {
    const p = new FakePage(this.driver);
    this.list.push(p);
    return Promise.resolve(p);
  }

  cookies(urls?: string | string[]): Promise<BrowserCookie[]> {
    const list = urls === undefined ? undefined : Array.isArray(urls) ? urls : [urls];
    return Promise.resolve(
      this.driver.cookies.filter(
        (c) =>
          !list ||
          list.some((u) => {
            const host = new URL(u).hostname;
            const d = c.domain.replace(/^\./, '');
            return host === d || host.endsWith(`.${d}`);
          }),
      ),
    );
  }

  close(): Promise<void> {
    this.closed = true;
    for (const p of this.list) p.closed = true;
    return Promise.resolve();
  }

  /** Request routes (Playwright `context.route`): recorded, never invoked. */
  route(pattern: string): Promise<void> {
    this.routes.push(pattern);
    return Promise.resolve();
  }

  readonly routes: string[] = [];
}

export class FakeBrowserDriver implements BrowserDriver {
  screens: Record<string, FakeScreen> = {};
  redirects: Record<string, string> = {};
  cookies: BrowserCookie[] = [];
  launches: { userDataDir: string; options: LaunchOptions }[] = [];
  contexts: FakeBrowserContext[] = [];
  visited: string[] = [];
  clicked: string[] = [];
  checked: string[] = [];
  /** Answers `page.evaluate(expression)` (e.g. an in-page fetch) for the current page. */
  evaluate?: (page: FakePage, expression: string) => unknown;

  constructor(
    init: Partial<Pick<FakeBrowserDriver, 'screens' | 'redirects' | 'cookies' | 'evaluate'>> = {},
  ) {
    Object.assign(this, init);
  }

  screenFor(url: string): FakeScreen {
    const exact = this.screens[url];
    if (exact) return exact;
    try {
      const u = new URL(url);
      const s = this.screens[`${u.origin}${u.pathname}`];
      if (s) return s;
    } catch {
      // about:blank
    }
    return { title: '', html: '' };
  }

  launchPersistentContext(
    userDataDir: string,
    options: LaunchOptions,
  ): Promise<BrowserContextLike> {
    this.launches.push({ userDataDir, options });
    const ctx = new FakeBrowserContext(this);
    this.contexts.push(ctx);
    return Promise.resolve(ctx);
  }

  /** The page of the most recent context (to simulate the human). */
  get activePage(): FakePage | undefined {
    return this.contexts[this.contexts.length - 1]?.list[0];
  }
}
