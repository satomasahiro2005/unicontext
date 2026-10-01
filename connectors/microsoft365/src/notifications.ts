import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type Clock, ConnectorError, type FetchLike, systemClock } from '@unicontext/core';
import { createHttpClient, type HttpClient, type RateLimiter } from '@unicontext/connector-sdk';
import { DEFAULT_GRAPH_BASE_URL } from './config.js';

/*
 * OPTIONAL Graph change notifications (§24): "notification → delta sync".
 *
 * UniContext is local-first and runs no public server, so the default is delta polling every 15
 * minutes (defaultSchedule '15m'). A host that does have a public HTTPS endpoint (a tunnel such as
 * Cloudflare Tunnel / ngrok, or a small relay) can use this class to
 *   1. create/renew subscriptions with Graph,
 *   2. answer Graph's validation handshake and verify `clientState`,
 *   3. turn each valid notification into `trigger(sourceId)` — typically
 *      `SyncScheduler.trigger(sourceId)` — which runs the normal incremental (delta) sync.
 * Notifications carry no data we rely on; the delta query remains the single source of truth.
 */

export type SubscriptionResource = 'calendar' | 'mail' | 'drive' | 'channelMessages';

export interface ChangeSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
}

/** Graph resource path for a connector resource (Teams channel messages need team/channel ids). */
export function subscriptionResource(
  kind: SubscriptionResource,
  options: { mailFolder?: string; teamId?: string; channelId?: string } = {},
): string {
  switch (kind) {
    case 'calendar':
      return '/me/events';
    case 'mail':
      return `/me/mailFolders('${options.mailFolder ?? 'inbox'}')/messages`;
    case 'drive':
      return '/me/drive/root';
    case 'channelMessages':
      if (!options.teamId || !options.channelId)
        throw new RangeError('channelMessages subscriptions need teamId and channelId');
      return `/teams/${options.teamId}/channels/${options.channelId}/messages`;
  }
}

/** Longest lifetime Graph grants, in minutes (channel messages: 60, others about 3 days). */
export function maxSubscriptionMinutes(resource: string): number {
  if (/\/channels\/[^/]+\/messages/i.test(resource)) return 60;
  if (/^\/?(chats|me\/chats)/i.test(resource)) return 60;
  if (/\/drive\//i.test(resource)) return 42_300;
  return 4230;
}

/** Random `clientState` secret (store it in the SecretStore, never in config). */
export function generateClientState(): string {
  return randomBytes(24).toString('base64url');
}

export interface ChangeNotification {
  subscriptionId?: string;
  changeType?: string;
  resource?: string;
  clientState?: string;
  lifecycleEvent?: string;
  tenantId?: string;
  resourceData?: Record<string, unknown>;
}

export interface WebhookRequest {
  /** Query string of the webhook URL (Graph sends `validationToken`). */
  query?: URLSearchParams | Record<string, string | undefined>;
  /** Parsed JSON body of the POST. */
  body?: unknown;
}

export interface WebhookResponse {
  status: 200 | 202 | 400 | 401;
  contentType: string;
  body: string;
}

export type NotificationCheck =
  | { kind: 'validation'; token: string }
  | { kind: 'notifications'; accepted: ChangeNotification[]; rejected: number }
  | { kind: 'invalid' };

export interface WebhookResult {
  response: WebhookResponse;
  accepted: ChangeNotification[];
  rejected: number;
}

export interface ChangeNotificationsOptions {
  sourceId: string;
  /** Returns a valid Graph access token (e.g. via OAuthTokenStore.getAccessToken). */
  getAccessToken: () => Promise<string>;
  /** The `clientState` secret set on the subscriptions; notifications carrying another value are rejected. */
  clientState: string;
  /** Called (once per webhook call) with the sourceId when a valid notification arrived. */
  trigger: (sourceId: string, reason: 'changed' | 'missed') => void | Promise<void>;
  fetch?: FetchLike;
  rateLimiter?: RateLimiter;
  clock?: Clock;
  graphBaseUrl?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function queryValue(query: WebhookRequest['query'], key: string): string | undefined {
  if (!query) return undefined;
  if (query instanceof URLSearchParams) return query.get(key) ?? undefined;
  return query[key];
}

export class GraphChangeNotifications {
  private readonly http: HttpClient;
  private readonly base: string;
  private readonly clock: Clock;

  constructor(private readonly options: ChangeNotificationsOptions) {
    this.clock = options.clock ?? systemClock;
    this.base = (options.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, '');
    this.http = createHttpClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
      clock: this.clock,
      headers: async () => ({
        authorization: `Bearer ${await options.getAccessToken()}`,
        'content-type': 'application/json',
      }),
    });
  }

  private async call(path: string, method: string, body?: unknown): Promise<unknown> {
    const res = await this.http.request(`${this.base}${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ConnectorError(
        `Graph subscriptions ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
        {
          details: { status: res.status },
        },
      );
    }
    return res.status === 204 ? undefined : await res.json();
  }

  private toSubscription(json: unknown, clientState?: string): ChangeSubscription {
    const j = (json ?? {}) as Record<string, unknown>;
    if (typeof j.id !== 'string' || typeof j.expirationDateTime !== 'string')
      throw new ConnectorError('Unexpected subscription response from Graph');
    return {
      id: j.id,
      resource: typeof j.resource === 'string' ? j.resource : '',
      changeType: typeof j.changeType === 'string' ? j.changeType : '',
      notificationUrl: typeof j.notificationUrl === 'string' ? j.notificationUrl : '',
      expirationDateTime: j.expirationDateTime,
      ...(clientState ? { clientState } : {}),
    };
  }

  /** POST /subscriptions. `notificationUrl` must be a public HTTPS URL that answers validation. */
  async createSubscription(
    resource: string,
    notificationUrl: string,
    clientState: string = this.options.clientState,
    options: {
      changeType?: string;
      expirationMinutes?: number;
      lifecycleNotificationUrl?: string;
    } = {},
  ): Promise<ChangeSubscription> {
    if (!/^https:\/\//.test(notificationUrl))
      throw new RangeError('notificationUrl must be a public HTTPS URL');
    const minutes = Math.min(
      options.expirationMinutes ?? maxSubscriptionMinutes(resource),
      maxSubscriptionMinutes(resource),
    );
    const json = await this.call('/subscriptions', 'POST', {
      changeType: options.changeType ?? 'created,updated,deleted',
      notificationUrl,
      ...(options.lifecycleNotificationUrl
        ? { lifecycleNotificationUrl: options.lifecycleNotificationUrl }
        : {}),
      resource,
      expirationDateTime: new Date(this.clock.now().getTime() + minutes * 60_000).toISOString(),
      clientState,
    });
    return this.toSubscription(json, clientState);
  }

  /** PATCH /subscriptions/{id}: extend the expiration (call before it lapses, e.g. at 50% of lifetime). */
  async renew(
    subscription: Pick<ChangeSubscription, 'id' | 'resource'>,
    expirationMinutes?: number,
  ): Promise<ChangeSubscription> {
    const minutes = Math.min(
      expirationMinutes ?? maxSubscriptionMinutes(subscription.resource),
      maxSubscriptionMinutes(subscription.resource),
    );
    const json = await this.call(`/subscriptions/${encodeURIComponent(subscription.id)}`, 'PATCH', {
      expirationDateTime: new Date(this.clock.now().getTime() + minutes * 60_000).toISOString(),
    });
    return this.toSubscription(json);
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.call(`/subscriptions/${encodeURIComponent(id)}`, 'DELETE');
  }

  /** True when the subscription should be renewed (less than half of `lifetimeMinutes` left). */
  needsRenewal(
    subscription: Pick<ChangeSubscription, 'expirationDateTime'>,
    marginMinutes = 30,
  ): boolean {
    return (
      new Date(subscription.expirationDateTime).getTime() - this.clock.now().getTime() <
      marginMinutes * 60_000
    );
  }

  /**
   * Classify one webhook call without side effects:
   * - `?validationToken=` → `validation` (echo the token, Graph's handshake);
   * - POST body `{value: [...]}` → `notifications`, with entries whose `clientState` differs
   *   from ours counted as `rejected`;
   * - anything else → `invalid`.
   */
  validateNotification(request: WebhookRequest): NotificationCheck {
    const token = queryValue(request.query, 'validationToken');
    if (token !== undefined) return { kind: 'validation', token };
    const value = (request.body as { value?: unknown } | undefined)?.value;
    if (!Array.isArray(value)) return { kind: 'invalid' };
    const accepted: ChangeNotification[] = [];
    let rejected = 0;
    for (const entry of value as ChangeNotification[]) {
      if (
        typeof entry?.clientState === 'string' &&
        constantTimeEqual(entry.clientState, this.options.clientState)
      )
        accepted.push(entry);
      else rejected++;
    }
    return { kind: 'notifications', accepted, rejected };
  }

  /**
   * Handle one webhook call end to end: validation echo (200 text/plain), or verify clientState,
   * call `trigger(sourceId)` once (it should only enqueue: Graph wants an answer within 3
   * seconds) and answer 202. A `missed` lifecycle event triggers a sync as well;
   * `reauthorizationRequired` is returned in `accepted` for the host to renew the subscription.
   */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    const check = this.validateNotification(request);
    if (check.kind === 'validation')
      return {
        response: { status: 200, contentType: 'text/plain', body: check.token },
        accepted: [],
        rejected: 0,
      };
    if (check.kind === 'invalid')
      return {
        response: { status: 400, contentType: 'text/plain', body: 'bad request' },
        accepted: [],
        rejected: 0,
      };
    const wantsSync = check.accepted.filter((n) => n.lifecycleEvent !== 'reauthorizationRequired');
    if (wantsSync.length > 0) {
      const missed = wantsSync.every((n) => n.lifecycleEvent === 'missed');
      await this.options.trigger(this.options.sourceId, missed ? 'missed' : 'changed');
    }
    return {
      response:
        check.accepted.length === 0 && check.rejected > 0
          ? { status: 401, contentType: 'text/plain', body: 'invalid clientState' }
          : { status: 202, contentType: 'text/plain', body: '' },
      accepted: check.accepted,
      rejected: check.rejected,
    };
  }
}

/** Convenience: the validation handshake only (no verification needed per Graph docs). */
export function validationResponse(query: WebhookRequest['query']): WebhookResponse | undefined {
  const token = queryValue(query, 'validationToken');
  return token === undefined ? undefined : { status: 200, contentType: 'text/plain', body: token };
}
