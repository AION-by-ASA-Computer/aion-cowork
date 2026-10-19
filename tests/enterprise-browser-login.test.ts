import { createHash } from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../src/main/enterprise/auth';
import {
  buildBrowserUrl,
  cancelBrowserLogin,
  startBrowserLogin,
} from '../src/main/enterprise/browser-login';
import { EnterpriseService } from '../src/main/enterprise/enterprise-service';
import { DEFAULT_ENTERPRISE_DATA, type EnterpriseStoreData } from '../src/main/enterprise/enterprise-store';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

/** Starts a login, returns the parsed browser URL once openExternal fired. */
function begin(extra: Partial<Parameters<typeof startBrowserLogin>[0]> = {}) {
  let resolveUrl!: (u: URL) => void;
  const opened = new Promise<URL>((r) => (resolveUrl = r));
  const openExternal = vi.fn((u: string) => resolveUrl(new URL(u)));
  const promise = startBrowserLogin({
    endpoint: 'https://h/api',
    loginUrl: 'https://h/login',
    openExternal,
    ...extra,
  });
  promise.catch(() => undefined);
  return { promise, opened, openExternal };
}

const callbackOf = (u: URL) => new URL(u.searchParams.get('redirect')!);

async function expectClosed(redirect: URL) {
  await expect(get(redirect.toString())).rejects.toThrow();
}

afterEach(() => {
  cancelBrowserLogin();
  vi.useRealTimers();
});

describe('startBrowserLogin', () => {
  it('builds the browser URL with PKCE params and a loopback redirect', async () => {
    const { promise, opened } = begin();
    const url = await opened;
    expect(url.origin + url.pathname).toBe('https://h/login');
    expect(url.searchParams.get('desktop')).toBe('1');
    const redirect = callbackOf(url);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/callback');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    cancelBrowserLogin();
    await expect(promise).rejects.toMatchObject({ error: { code: 'login_cancelled' } });
  });

  it('keeps existing login URL params and rejects non-http URLs', () => {
    const u = new URL(buildBrowserUrl('https://h/login?x=1', { state: 's', challenge: 'c', redirect: 'r' }));
    expect(u.searchParams.get('x')).toBe('1');
    expect(() => buildBrowserUrl('file:///etc/passwd', { state: 's', challenge: 'c', redirect: 'r' })).toThrow();
  });

  it('resolves code + verifier whose sha256 equals the challenge, and closes the server', async () => {
    const { promise, opened } = begin();
    const url = await opened;
    const redirect = callbackOf(url);
    const state = url.searchParams.get('state')!;
    const res = await get(`${redirect.origin}/callback?code=abc&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Accesso completato. Puoi tornare ad AION Cowork.');
    const out = await promise;
    expect(out.code).toBe('abc');
    expect(out.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash('sha256').update(out.codeVerifier).digest('base64url')).toBe(
      url.searchParams.get('challenge')
    );
    await expectClosed(redirect);
  });

  it('answers 404 to anything but GET /callback and keeps waiting', async () => {
    const { promise, opened } = begin();
    const url = await opened;
    const redirect = callbackOf(url);
    expect((await get(`${redirect.origin}/other`)).status).toBe(404);
    const post = await new Promise<number>((resolve, reject) => {
      const req = http.request(redirect.toString(), { method: 'POST', agent: false }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(post).toBe(404);
    const state = url.searchParams.get('state')!;
    await get(`${redirect.origin}/callback?code=z&state=${state}`);
    await expect(promise).resolves.toMatchObject({ code: 'z' });
  });

  it('binds to loopback only', async () => {
    const spy = vi.spyOn(http.Server.prototype, 'listen');
    const { promise, opened } = begin();
    await opened;
    expect(spy.mock.calls[0].slice(0, 2)).toEqual([0, '127.0.0.1']);
    spy.mockRestore();
    cancelBrowserLogin();
    await promise.catch(() => undefined);
  });

  it('rejects state_mismatch with an error page and closes', async () => {
    const { promise, opened } = begin();
    const redirect = callbackOf(await opened);
    const res = await get(`${redirect.origin}/callback?code=abc&state=wrong`);
    expect(res.status).toBe(400);
    expect(res.body).toContain('Accesso non riuscito');
    await expect(promise).rejects.toMatchObject({ error: { code: 'state_mismatch' } });
    await expectClosed(redirect);
  });

  it('rejects when the code is missing or the server reports an error', async () => {
    const a = begin();
    const ua = await a.opened;
    await get(`${callbackOf(ua).origin}/callback?state=${ua.searchParams.get('state')}`);
    await expect(a.promise).rejects.toMatchObject({ error: { code: 'exchange_failed' } });
    await expectClosed(callbackOf(ua));

    const b = begin();
    const ub = await b.opened;
    const res = await get(
      `${callbackOf(ub).origin}/callback?error=%3Cscript%3E&state=${ub.searchParams.get('state')}`
    );
    expect(res.body).not.toContain('<script>');
    await expect(b.promise).rejects.toMatchObject({ error: { code: 'exchange_failed' } });
  });

  it('times out with login_timeout and closes the server', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { promise, opened } = begin({ timeoutMs: 1000 });
    const redirect = callbackOf(await opened);
    await vi.advanceTimersByTimeAsync(1001);
    await expect(promise).rejects.toMatchObject({ error: { code: 'login_timeout' } });
    vi.useRealTimers();
    await expectClosed(redirect);
  });

  it('cancels through cancelBrowserLogin, AbortSignal and a superseding login', async () => {
    const a = begin();
    const ra = callbackOf(await a.opened);
    cancelBrowserLogin();
    await expect(a.promise).rejects.toMatchObject({ error: { code: 'login_cancelled' } });
    await expectClosed(ra);

    const ac = new AbortController();
    const b = begin({ signal: ac.signal });
    const rb = callbackOf(await b.opened);
    ac.abort();
    await expect(b.promise).rejects.toMatchObject({ error: { code: 'login_cancelled' } });
    await expectClosed(rb);

    const c = begin();
    const rc = callbackOf(await c.opened);
    const d = begin();
    await d.opened;
    await expect(c.promise).rejects.toMatchObject({ error: { code: 'login_cancelled' } });
    await expectClosed(rc);
    cancelBrowserLogin();
    await d.promise.catch(() => undefined);
  });

  it('closes the server when the browser cannot be opened', async () => {
    let port = 0;
    const p = startBrowserLogin({
      endpoint: 'https://h',
      loginUrl: 'https://h/login',
      openExternal: (u) => {
        port = Number(new URL(new URL(u).searchParams.get('redirect')!).port);
        throw new Error('nope');
      },
    });
    await expect(p).rejects.toMatchObject({ error: { code: 'browser_open_failed' } });
    await expect(get(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
    expect(port).toBeGreaterThan(0);
  });
});

// ---- auth.exchangeDesktopCode / probe -----------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const LOGIN_OK = {
  access_token: 'tok',
  user_id: 'u1',
  identifier: 'mario',
  display_name: 'Mario',
  roles: ['user'],
  must_change_password: false,
  expires_at: '2030-01-01T00:00:00Z',
};

describe('auth desktop login', () => {
  afterEach(() => auth.setFetchImplementation(null));

  it('exchanges the code without a Bearer and maps the payload', async () => {
    const f = vi.fn(() => Promise.resolve(jsonResponse(200, LOGIN_OK)));
    auth.setFetchImplementation(f as unknown as typeof fetch);
    const out = await auth.exchangeDesktopCode('https://h/api', 'c', 'v');
    expect(out.kind).toBe('ok');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://h/api/auth/desktop/exchange');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'c', code_verifier: 'v' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it.each(['invalid_code', 'code_expired', 'code_already_used', 'invalid_verifier'])(
    'keeps error code %s',
    async (code) => {
      auth.setFetchImplementation((() =>
        Promise.resolve(jsonResponse(400, { detail: { code } }))) as unknown as typeof fetch);
      await expect(auth.exchangeDesktopCode('https://h', 'c', 'v')).rejects.toMatchObject({
        error: { code },
      });
    }
  );

  it('probe exposes loginUrl and desktopLogin, with a heuristic fallback', async () => {
    const info = (extra: Record<string, unknown>, features: Record<string, unknown>) =>
      jsonResponse(200, { product: 'aion-agent', api_version: 1, features, ...extra });
    auth.setFetchImplementation((() =>
      Promise.resolve(info({ login_url: 'https://h/signin' }, { desktop_login: true }))) as unknown as typeof fetch);
    expect(await auth.probe('https://h/api')).toMatchObject({
      loginUrl: 'https://h/signin',
      desktopLogin: true,
    });
    auth.setFetchImplementation((() => Promise.resolve(info({}, {}))) as unknown as typeof fetch);
    expect(await auth.probe('https://h/api')).toMatchObject({
      loginUrl: 'https://h/login',
      desktopLogin: false,
    });
  });
});

// ---- service ------------------------------------------------------------------

function setupService(extra: Record<string, unknown> = {}) {
  const data: EnterpriseStoreData = { ...DEFAULT_ENTERPRISE_DATA };
  const store = {
    get: (k: keyof EnterpriseStoreData) => data[k],
    set: (p: Partial<EnterpriseStoreData>) => Object.assign(data, p),
    getAccessToken: () => data.accessToken,
    hasToken: () => Boolean(data.accessToken),
    clearSession: vi.fn(),
    clearConnection: vi.fn(),
  };
  const config = {
    isConfigured: vi.fn(() => false),
    getAll: vi.fn(() => ({})),
    applyManagedAionSet: vi.fn(),
    removeManagedAionSet: vi.fn(),
  };
  const focusWindow = vi.fn();
  const startBrowserLoginMock = vi.fn(async () => ({ code: 'c', codeVerifier: 'v' }));
  const svc = new EnterpriseService({
    store: store as never,
    config,
    syncConfigAfterMutation: vi.fn(async () => ({})),
    emitStatus: vi.fn(),
    openExternal: vi.fn(),
    focusWindow,
    startBrowserLogin: startBrowserLoginMock,
    ...extra,
  });
  return { svc, data, focusWindow, startBrowserLoginMock, config };
}

describe('EnterpriseService.loginWithBrowser', () => {
  afterEach(() => auth.setFetchImplementation(null));

  const routes = (desktop: boolean) =>
    vi.fn((url: string) => {
      if (url.endsWith('/v1/client/info'))
        return Promise.resolve(
          jsonResponse(200, {
            product: 'aion-agent',
            login_url: 'https://h/login',
            features: { desktop_login: desktop },
          })
        );
      if (url.endsWith('/auth/desktop/exchange')) return Promise.resolve(jsonResponse(200, LOGIN_OK));
      if (url.endsWith('/v1/llm/models'))
        return Promise.resolve(jsonResponse(200, { data: [{ id: 'm1', name: 'M1', is_default: true }] }));
      return Promise.resolve(jsonResponse(404, {}));
    });

  it('happy path: persists the session, applies the managed set and focuses the window', async () => {
    auth.setFetchImplementation(routes(true) as unknown as typeof fetch);
    const { svc, data, focusWindow, startBrowserLoginMock, config } = setupService();
    const res = await svc.loginWithBrowser('https://h/api/');
    expect(res.status).toBe('ok');
    expect(startBrowserLoginMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://h/api', loginUrl: 'https://h/login' })
    );
    expect(data.accessToken).toBe('tok');
    expect(data.selectedModel).toBe('m1');
    expect(config.applyManagedAionSet).toHaveBeenCalled();
    expect(focusWindow).toHaveBeenCalled();
    if (res.status === 'ok') expect(res.statusSnapshot.loggedIn).toBe(true);
  });

  it('returns desktop_login_unsupported without opening the browser', async () => {
    auth.setFetchImplementation(routes(false) as unknown as typeof fetch);
    const { svc, startBrowserLoginMock } = setupService();
    const res = await svc.loginWithBrowser('https://h/api');
    expect(res).toMatchObject({ status: 'error', error: { code: 'desktop_login_unsupported' } });
    expect(startBrowserLoginMock).not.toHaveBeenCalled();
  });

  it('propagates login_cancelled and does not focus the window', async () => {
    auth.setFetchImplementation(routes(true) as unknown as typeof fetch);
    const { BrowserLoginError } = await import('../src/main/enterprise/browser-login');
    const { svc, focusWindow } = setupService({
      startBrowserLogin: vi.fn(async () => {
        throw new BrowserLoginError('login_cancelled', 'Login cancelled');
      }),
    });
    expect(await svc.loginWithBrowser('https://h/api')).toMatchObject({
      status: 'error',
      error: { code: 'login_cancelled' },
    });
    expect(focusWindow).not.toHaveBeenCalled();
  });
});
