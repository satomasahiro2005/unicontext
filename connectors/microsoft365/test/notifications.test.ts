import { describe, expect, it } from 'vitest';
import {
  generateClientState,
  GraphChangeNotifications,
  maxSubscriptionMinutes,
  subscriptionResource,
  validationResponse,
} from '../src/index.js';
import { AutoClock, json } from './helpers.js';

function make(overrides: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const triggers: [string, string][] = [];
  const requests: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const clock = new AutoClock();
  const notifications = new GraphChangeNotifications({
    sourceId: 'm365',
    clientState: 'secret-state',
    getAccessToken: () => Promise.resolve('graph-token'),
    trigger: (id, reason) => void triggers.push([id, reason]),
    clock,
    fetch:
      overrides.fetch ??
      ((url, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
        requests.push({
          url,
          method: init?.method ?? 'GET',
          body,
          auth: new Headers(init?.headers).get('authorization'),
        });
        const b = (body ?? {}) as Record<string, unknown>;
        return Promise.resolve(
          init?.method === 'DELETE'
            ? new Response(null, { status: 204 })
            : json(
                {
                  id: 'sub-1',
                  resource: b['resource'] ?? '/me/events',
                  changeType: 'updated',
                  notificationUrl: 'https://x.example/hook',
                  expirationDateTime: b['expirationDateTime'],
                },
                201,
              ),
        );
      }),
  });
  return { notifications, triggers, requests, clock };
}

describe('GraphChangeNotifications (optional hook, §24)', () => {
  it('answers the validation handshake by echoing the token', async () => {
    const { notifications, triggers } = make();
    const res = await notifications.handleWebhook({
      query: new URLSearchParams({ validationToken: 'abc 123' }),
    });
    expect(res.response).toEqual({ status: 200, contentType: 'text/plain', body: 'abc 123' });
    expect(triggers).toEqual([]);
    expect(notifications.validateNotification({ query: { validationToken: 'x' } })).toEqual({
      kind: 'validation',
      token: 'x',
    });
    expect(validationResponse({ validationToken: 'q' })?.body).toBe('q');
    expect(validationResponse({})).toBeUndefined();
  });

  it('checks clientState and triggers one sync for the source', async () => {
    const { notifications, triggers } = make();
    const res = await notifications.handleWebhook({
      body: {
        value: [
          {
            subscriptionId: 's1',
            changeType: 'created',
            resource: 'Users/x/Messages/1',
            clientState: 'secret-state',
          },
          {
            subscriptionId: 's1',
            changeType: 'updated',
            resource: 'Users/x/Messages/2',
            clientState: 'secret-state',
          },
          {
            subscriptionId: 's9',
            changeType: 'updated',
            resource: 'Users/x/Messages/3',
            clientState: 'forged',
          },
        ],
      },
    });
    expect(res.response.status).toBe(202);
    expect(res.accepted).toHaveLength(2);
    expect(res.rejected).toBe(1);
    expect(triggers).toEqual([['m365', 'changed']]);
  });

  it('rejects notifications that carry only a wrong clientState, and malformed calls', async () => {
    const { notifications, triggers } = make();
    const forged = await notifications.handleWebhook({
      body: { value: [{ clientState: 'nope' }] },
    });
    expect(forged.response.status).toBe(401);
    expect(triggers).toEqual([]);
    expect((await notifications.handleWebhook({ body: { hello: 1 } })).response.status).toBe(400);
    expect((await notifications.handleWebhook({})).response.status).toBe(400);
  });

  it('lifecycle events: missed → sync, reauthorizationRequired → reported, no sync', async () => {
    const { notifications, triggers } = make();
    await notifications.handleWebhook({
      body: { value: [{ lifecycleEvent: 'missed', clientState: 'secret-state' }] },
    });
    expect(triggers).toEqual([['m365', 'missed']]);
    triggers.length = 0;
    const res = await notifications.handleWebhook({
      body: {
        value: [
          {
            lifecycleEvent: 'reauthorizationRequired',
            subscriptionId: 's1',
            clientState: 'secret-state',
          },
        ],
      },
    });
    expect(triggers).toEqual([]);
    expect(res.accepted[0]?.lifecycleEvent).toBe('reauthorizationRequired');
  });

  it('creates a subscription with clientState and a capped expiration, then renews it', async () => {
    const { notifications, requests, clock } = make();
    const sub = await notifications.createSubscription(
      subscriptionResource('channelMessages', { teamId: 'T', channelId: 'C' }),
      'https://hooks.example.com/graph',
    );
    expect(sub.id).toBe('sub-1');
    expect(requests[0]).toMatchObject({
      url: 'https://graph.microsoft.com/v1.0/subscriptions',
      method: 'POST',
      auth: 'Bearer graph-token',
      body: {
        changeType: 'created,updated,deleted',
        notificationUrl: 'https://hooks.example.com/graph',
        resource: '/teams/T/channels/C/messages',
        clientState: 'secret-state',
        expirationDateTime: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
      },
    });
    expect(notifications.needsRenewal(sub, 90)).toBe(true);
    const renewed = await notifications.renew({ id: 'sub-1', resource: '/me/events' });
    expect(requests[1]).toMatchObject({
      url: 'https://graph.microsoft.com/v1.0/subscriptions/sub-1',
      method: 'PATCH',
    });
    expect(new Date(renewed.expirationDateTime).getTime() - clock.now().getTime()).toBe(
      4230 * 60_000,
    );
    await notifications.deleteSubscription('sub-1');
    expect(requests[2]?.method).toBe('DELETE');
  });

  it('requires a public HTTPS notification URL', async () => {
    const { notifications } = make();
    await expect(
      notifications.createSubscription('/me/events', 'http://localhost:3000/hook'),
    ).rejects.toThrow(/HTTPS/);
  });

  it('resource helpers and limits', () => {
    expect(subscriptionResource('calendar')).toBe('/me/events');
    expect(subscriptionResource('mail')).toBe("/me/mailFolders('inbox')/messages");
    expect(() => subscriptionResource('channelMessages')).toThrow();
    expect(maxSubscriptionMinutes('/teams/T/channels/C/messages')).toBe(60);
    expect(maxSubscriptionMinutes('/me/events')).toBe(4230);
    expect(generateClientState()).not.toBe(generateClientState());
    expect(generateClientState().length).toBeGreaterThanOrEqual(32);
  });
});
