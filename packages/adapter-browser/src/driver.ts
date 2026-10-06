import { ConnectorError } from '@unicontext/core';
import { BrowserProfileInUseError, isProfileHandOffError } from './profile-lock.js';
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
        viewport: options.viewport ?? null,
        ...(options.serviceWorkers ? { serviceWorkers: options.serviceWorkers } : {}),
        ...(options.args?.length ? { args: [...options.args] } : {}),
      };
      if (options.executablePath) {
        try {
          return (await chromium.launchPersistentContext(userDataDir, {
            ...base,
            executablePath: options.executablePath,
          })) as BrowserContextLike;
        } catch (e) {
          if (isProfileHandOffError(e)) throw new BrowserProfileInUseError(userDataDir, { cause: e });
          throw e;
        }
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
          // The browser started but found the profile already open: trying another channel would
          // fail the same way, and "no browser could be launched" would be wrong.
          if (isProfileHandOffError(e)) throw new BrowserProfileInUseError(userDataDir, { cause: e });
          lastError = e;
        }
      }
      const detail = firstLine(lastError);
      throw new ConnectorError(
        `No browser could be launched (tried channels: ${channels.join(', ')})${detail ? `: ${detail}` : ''}. Install Google Chrome or Microsoft Edge, or set "browser.executablePath".`,
        { cause: lastError },
      );
    },
  };
}

function firstLine(e: unknown): string {
  if (e === undefined) return '';
  const text = e instanceof Error ? e.message : String(e);
  return (text.split('\n')[0] ?? '').trim().slice(0, 200);
}
