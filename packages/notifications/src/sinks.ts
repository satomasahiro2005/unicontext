import { createHmac } from 'node:crypto';
import {
  errorMessage,
  type Logger,
  type SecretStore,
  silentLogger,
  type UniContextConfig,
} from '@unicontext/core';
import {
  meetsPriority,
  type Notification,
  type NotificationPriority,
  type NotificationSink,
  PRIORITY_LABELS_JA,
} from './types.js';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `[重要] タイトル — 本文` */
export function formatNotificationLine(n: Notification): string {
  const body = oneLine(n.body);
  return `[${PRIORITY_LABELS_JA[n.priority]}] ${oneLine(n.title)}${body ? ` — ${body}` : ''}`;
}

/** Writes one line per notification. Defaults to stderr: stdout is reserved for MCP stdio. */
export function createConsoleSink(opts: { write?: (line: string) => void } = {}): NotificationSink {
  const write =
    opts.write ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  return {
    id: 'console',
    send(n) {
      write(formatNotificationLine(n));
    },
  };
}

/** The subset of node-notifier used here. */
export interface NotifierLike {
  notify(
    options: { title: string; message: string; sound?: boolean; wait?: boolean },
    callback?: (error: Error | null, response?: unknown) => void,
  ): unknown;
}

async function loadNodeNotifier(): Promise<NotifierLike | undefined> {
  const specifier = 'node-notifier';
  const mod = (await import(specifier)) as { default?: NotifierLike } & Partial<NotifierLike>;
  const candidate = mod.default ?? mod;
  return typeof candidate.notify === 'function' ? (candidate as NotifierLike) : undefined;
}

const DESKTOP_TIMEOUT_MS = 10_000;

/**
 * Desktop notifications through the optional `node-notifier` module. Returns undefined when the
 * module is not available; never throws. Priorities below `minPriority` (default 'normal') are
 * not shown, to keep low-signal events out of the way.
 */
export async function createDesktopSink(
  opts: {
    load?: () => Promise<NotifierLike | undefined>;
    logger?: Logger;
    minPriority?: NotificationPriority;
  } = {},
): Promise<NotificationSink | undefined> {
  const logger = opts.logger ?? silentLogger;
  const minPriority = opts.minPriority ?? 'normal';
  let notifier: NotifierLike | undefined;
  try {
    notifier = await (opts.load ?? loadNodeNotifier)();
  } catch (e) {
    logger.debug('desktop notifications unavailable', { error: errorMessage(e) });
    return undefined;
  }
  if (!notifier) {
    logger.debug('desktop notifications unavailable');
    return undefined;
  }
  const target = notifier;
  return {
    id: 'desktop',
    send(n) {
      if (!meetsPriority(n.priority, minPriority)) return;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, DESKTOP_TIMEOUT_MS);
        timer.unref?.();
        try {
          target.notify(
            {
              title: `[${PRIORITY_LABELS_JA[n.priority]}] ${oneLine(n.title)}`,
              message: oneLine(n.body),
              sound: n.priority === 'critical',
              wait: false,
            },
            (err) => {
              clearTimeout(timer);
              if (err) reject(err);
              else resolve();
            },
          );
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
    },
  };
}

export interface WebhookSinkOptions {
  url: string;
  /** HMAC-SHA256 key; adds `X-UniContext-Signature: sha256=<hex of the request body>`. */
  secret?: string;
  fetch?: typeof fetch;
  minPriority?: NotificationPriority;
  /** Default 10 seconds. */
  timeoutMs?: number;
}

/** Signature header value for a webhook body. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * POSTs `{"event":"notification","notification":{...}}` as JSON. Errors never contain the URL
 * (it may carry a token in its query string).
 */
export function createWebhookSink(opts: WebhookSinkOptions): NotificationSink {
  const doFetch = opts.fetch ?? fetch;
  const minPriority = opts.minPriority ?? 'low';
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    id: 'webhook',
    async send(n) {
      if (!meetsPriority(n.priority, minPriority)) return;
      const body = JSON.stringify({ event: 'notification', notification: n });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'unicontext-notifications',
      };
      if (opts.secret) headers['X-UniContext-Signature'] = signWebhookBody(body, opts.secret);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let status: number;
      try {
        const res = await doFetch(opts.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        status = res.status;
      } catch (e) {
        // The original error is deliberately not attached as `cause`: it may embed the URL.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`webhook delivery failed (${e instanceof Error ? e.name : 'error'})`);
      } finally {
        clearTimeout(timer);
      }
      if (status < 200 || status >= 300) throw new Error(`webhook responded with HTTP ${status}`);
    },
  };
}

/**
 * Builds the sinks enabled in config. Returns [] when notifications are disabled. The webhook is
 * created only when enabled with a url; if `secretRef` is set but the secret is missing it is
 * skipped (with a warning) rather than sending unsigned requests.
 */
export async function createSinksFromConfig(
  config: UniContextConfig['notifications'],
  deps: { secrets: SecretStore; logger?: Logger; fetch?: typeof fetch },
): Promise<NotificationSink[]> {
  const logger = deps.logger ?? silentLogger;
  if (!config.enabled) return [];
  const sinks: NotificationSink[] = [];
  if (config.sinks.console.enabled) sinks.push(createConsoleSink());
  if (config.sinks.desktop.enabled) {
    const desktop = await createDesktopSink({ logger });
    if (desktop) sinks.push(desktop);
  }
  const hook = config.sinks.webhook;
  if (hook.enabled && hook.url) {
    let secret: string | undefined;
    if (hook.secretRef) {
      try {
        secret = await deps.secrets.get(hook.secretRef);
      } catch (e) {
        logger.warn('webhook secret lookup failed', { error: errorMessage(e) });
      }
      if (!secret) {
        logger.warn('webhook disabled: secret not found in the secret store', {
          secretRef: hook.secretRef,
        });
      }
    }
    if (!hook.secretRef || secret) {
      sinks.push(
        createWebhookSink({
          url: hook.url,
          ...(secret ? { secret } : {}),
          minPriority: hook.minPriority,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }),
      );
    }
  }
  return sinks;
}
