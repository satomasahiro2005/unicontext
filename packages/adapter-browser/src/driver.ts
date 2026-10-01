import { ConnectorError } from '@unicontext/core';
import type { BrowserContextLike, BrowserDriver, LaunchOptions } from './types.js';

/** Channels tried in order when none is configured: an installed Chrome, then Edge. */
export const DEFAULT_CHANNELS = ['chrome', 'msedge'] as const;

interface PlaywrightChromium {
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<unknown>;
}

/**
 * Driver backed by playwright-core (no bundled browser download). It launches an installed
 * Chrome/Edge (`channel`) or an explicit `executablePath`. playwright-core is loaded lazily so
 * that packages depending on this adapter do not pay for it unless a browser is actually opened.
 */
export function playwrightDriver(
  load: () => Promise<{ chromium: PlaywrightChromium }> = async () =>
    (await import('playwright-core')) as unknown as { chromium: PlaywrightChromium },
): BrowserDriver {
  return {
    async launchPersistentContext(userDataDir: string, options: LaunchOptions) {
      const { chromium } = await load();
      const base: Record<string, unknown> = {
        headless: options.headless,
        locale: options.locale ?? 'ja-JP',
        timezoneId: options.timezoneId ?? 'Asia/Tokyo',
        viewport: null,
      };
      if (options.executablePath) {
        return (await chromium.launchPersistentContext(userDataDir, {
          ...base,
          executablePath: options.executablePath,
        })) as BrowserContextLike;
      }
      const channels = options.channel ? [options.channel] : [...DEFAULT_CHANNELS];
      let lastError: unknown;
      for (const channel of channels) {
        try {
          return (await chromium.launchPersistentContext(userDataDir, {
            ...base,
            channel,
          })) as BrowserContextLike;
        } catch (e) {
          lastError = e;
        }
      }
      throw new ConnectorError(
        `No browser could be launched (tried channels: ${channels.join(', ')}). Install Google Chrome or Microsoft Edge, or set "browser.executablePath".`,
        { cause: lastError },
      );
    },
  };
}
