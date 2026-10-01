import { createHttpClient } from '@unicontext/connector-sdk';
import type { FetchLike } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import { HttpSession, SessionExpiredError } from '../src/index.js';
import { BASE } from './helpers.js';

function session(fetchFn: FetchLike): HttpSession {
  return new HttpSession(createHttpClient({ fetch: fetchFn }), BASE);
}

describe('HttpSession', () => {
  it('keeps cookies from set-cookie across redirects and drops expired ones', async () => {
    const seen: (string | null)[] = [];
    let n = 0;
    const s = session((_input, init) => {
      seen.push(new Headers(init?.headers).get('cookie'));
      n++;
      if (n === 1) {
        const r = new Response(null, { status: 302, headers: { location: `${BASE}next` } });
        r.headers.append('set-cookie', 'JSESSIONID=abc; Path=/lcu-web; HttpOnly');
        r.headers.append('set-cookie', 'other=1; Path=/');
        return Promise.resolve(r);
      }
      if (n === 2) {
        const r = new Response('<p>ok</p>', { status: 200 });
        r.headers.append('set-cookie', 'other=; Max-Age=0; Path=/');
        return Promise.resolve(r);
      }
      return Promise.resolve(new Response('again'));
    });
    const res = await s.fetch(`${BASE}start`);
    expect(res.html).toBe('<p>ok</p>');
    expect(res.url).toBe(`${BASE}next`);
    expect(res.redirects).toEqual([`${BASE}next`]);
    expect(seen).toEqual([null, 'JSESSIONID=abc; other=1']);
    await s.fetch(`${BASE}third`);
    expect(seen[2]).toBe('JSESSIONID=abc');
    s.reset();
    expect(s.hasCookie('JSESSIONID')).toBe(false);
  });

  it('picks the session id up from a ;jsessionid= path parameter and strips it', async () => {
    const urls: string[] = [];
    const cookies: (string | null)[] = [];
    let n = 0;
    const s = session((input, init) => {
      urls.push(input);
      cookies.push(new Headers(init?.headers).get('cookie'));
      return Promise.resolve(
        n++ === 0
          ? new Response(null, {
              status: 302,
              headers: { location: `${BASE}page;jsessionid=XYZ?a=1` },
            })
          : new Response('done'),
      );
    });
    await s.fetch(`${BASE}go`);
    expect(urls).toEqual([`${BASE}go`, `${BASE}page?a=1`]);
    expect(cookies).toEqual([null, 'JSESSIONID=XYZ']);
  });

  it('turns a 303 POST redirect into GET but keeps the body for 307', async () => {
    const calls: string[] = [];
    let n = 0;
    const s = session((input, init) => {
      calls.push(`${init?.method} ${input} ${typeof init?.body === 'string' ? init.body : '-'}`);
      n++;
      if (n === 1)
        return Promise.resolve(
          new Response(null, { status: 303, headers: { location: `${BASE}a` } }),
        );
      if (n === 2)
        return Promise.resolve(
          new Response(null, { status: 307, headers: { location: `${BASE}b` } }),
        );
      return Promise.resolve(new Response('x'));
    });
    await s.fetch(`${BASE}form`, { method: 'POST', form: { 名前: 'テスト', _csrf: 't' } });
    expect(calls[0]).toContain('POST');
    expect(calls[0]).toContain('%E5%90%8D%E5%89%8D=%E3%83%86%E3%82%B9%E3%83%88&_csrf=t');
    expect(calls[1]).toBe(`GET ${BASE}a -`);
    expect(calls[2]).toBe(`GET ${BASE}b -`);
  });

  it('refuses redirect loops and off-origin redirects', async () => {
    const loop = session(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: `${BASE}loop` } })),
    );
    await expect(loop.fetch(`${BASE}loop`)).rejects.toBeInstanceOf(SessionExpiredError);
    const off = session(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
      ),
    );
    await expect(off.fetch(`${BASE}x`)).rejects.toThrow(/off-origin/);
  });

  it('serializes exclusive operations in order', async () => {
    const s = session(() => Promise.resolve(new Response('x')));
    const order: string[] = [];
    const slow = s.exclusive(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    const failing = s.exclusive(() => {
      order.push('failing');
      return Promise.reject(new Error('boom'));
    });
    const fast = s.exclusive(() => {
      order.push('fast');
      return Promise.resolve();
    });
    await slow;
    await expect(failing).rejects.toThrow('boom');
    await fast;
    expect(order).toEqual(['slow', 'failing', 'fast']);
  });
});
