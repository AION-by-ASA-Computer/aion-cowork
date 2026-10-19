import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../src/main/enterprise/auth';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LOGIN_OK = {
  access_token: 'tok',
  token_type: 'bearer',
  user_id: 'u1',
  identifier: 'mario',
  display_name: 'Mario',
  roles: ['user'],
  must_change_password: false,
  expires_at: '2030-01-01T00:00:00Z',
  expires_in: 604800,
};

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(url, init)));
  auth.setFetchImplementation(fn as unknown as typeof fetch);
  return fn;
}

afterEach(() => auth.setFetchImplementation(null));

describe('normalizeEndpoint', () => {
  it('trims and strips trailing slashes, keeps path', () => {
    expect(auth.normalizeEndpoint('  https://agent.x.it/api/// ')).toBe('https://agent.x.it/api');
    expect(auth.normalizeEndpoint('http://localhost:8001/')).toBe('http://localhost:8001');
  });
  it('rejects non-http(s) and empty', () => {
    expect(() => auth.normalizeEndpoint('ftp://x')).toThrow();
    expect(() => auth.normalizeEndpoint('')).toThrow();
    expect(() => auth.normalizeEndpoint('not a url')).toThrow();
  });
  it('detects private hosts', () => {
    expect(auth.isLocalOrPrivateHost('192.168.1.5')).toBe(true);
    expect(auth.isLocalOrPrivateHost('localhost')).toBe(true);
    expect(auth.isLocalOrPrivateHost('agent.azienda.it')).toBe(false);
  });
});

describe('login', () => {
  it('maps a successful payload and sends client:"chat"', async () => {
    const f = mockFetch(() => jsonResponse(200, LOGIN_OK));
    const out = await auth.login('https://h/api', 'mario', 'pw');
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.login.accessToken).toBe('tok');
      expect(out.login.user).toEqual({
        userId: 'u1',
        identifier: 'mario',
        displayName: 'Mario',
        roles: ['user'],
      });
      expect(out.login.expiresAt).toBe('2030-01-01T00:00:00Z');
    }
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://h/api/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({
      username: 'mario',
      password: 'pw',
      client: 'chat',
    });
  });

  it('returns mfa outcome', async () => {
    mockFetch(() =>
      jsonResponse(200, { mfa_required: true, mfa_stage: 'enroll', mfa_token: 'm', expires_in: 300 })
    );
    expect(await auth.login('https://h', 'a', 'b')).toEqual({
      kind: 'mfa',
      mfaStage: 'enroll',
      mfaToken: 'm',
      expiresIn: 300,
    });
  });

  it('maps 401 to invalid_credentials', async () => {
    mockFetch(() => jsonResponse(401, { detail: 'Invalid credentials' }));
    await expect(auth.login('https://h', 'a', 'b')).rejects.toMatchObject({
      status: 401,
      error: { code: 'invalid_credentials' },
    });
  });

  it('maps mfa_locked with retryAfter and other coded errors', async () => {
    mockFetch(() => jsonResponse(429, { detail: { code: 'mfa_locked', retry_after: 120 } }));
    await expect(auth.login('https://h', 'a', 'b')).rejects.toMatchObject({
      error: { code: 'mfa_locked', retryAfter: 120 },
    });
    mockFetch(() => jsonResponse(403, { detail: { code: 'sso_required' } }));
    await expect(auth.login('https://h', 'a', 'b')).rejects.toMatchObject({
      error: { code: 'sso_required' },
    });
    mockFetch(() => jsonResponse(401, { detail: { code: 'temp_password_expired' } }));
    await expect(auth.login('https://h', 'a', 'b')).rejects.toMatchObject({
      error: { code: 'temp_password_expired' },
    });
  });

  it('reports network failures', async () => {
    auth.setFetchImplementation((() => Promise.reject(new Error('boom'))) as unknown as typeof fetch);
    await expect(auth.login('https://h', 'a', 'b')).rejects.toMatchObject({
      status: 0,
      error: { code: 'network_error' },
    });
  });

  it('derives expiresAt from expires_in when expires_at is missing', () => {
    const p = auth.parseLoginPayload({ access_token: 't', expires_in: 60 }, 1_000_000);
    expect(p.expiresAt).toBe(new Date(1_000_000 + 60_000).toISOString());
  });
});

describe('probe', () => {
  it('verifies via /v1/client/info', async () => {
    mockFetch(() =>
      jsonResponse(200, {
        product: 'aion-agent',
        api_version: 1,
        version: '1.6.2',
        min_client_version: '1.0.0',
        login_mode: 'password',
        features: { llm_proxy: true },
      })
    );
    const r = await auth.probe('https://h/api/', '1.0.0');
    expect(r).toMatchObject({ ok: true, verified: true, serverVersion: '1.6.2', llmProxy: true });
    expect(r.endpoint).toBe('https://h/api');
    expect(r.warning).toBeUndefined();
  });

  it('warns when client is older than min_client_version', async () => {
    mockFetch(() =>
      jsonResponse(200, { product: 'aion-agent', api_version: 1, min_client_version: '2.0.0' })
    );
    const r = await auth.probe('https://h', '1.0.0');
    expect(r.verified).toBe(true);
    expect(r.warning).toContain('2.0.0');
  });

  it('falls back to /health + /auth/status as unverified', async () => {
    mockFetch((url) => {
      if (url.endsWith('/v1/client/info')) return jsonResponse(404, { detail: 'nf' });
      if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok', service: 'aion-api' });
      return jsonResponse(200, { login_mode: 'password', two_factor_required: true });
    });
    const r = await auth.probe('https://h');
    expect(r).toMatchObject({ ok: true, verified: false, twoFactorRequired: true });
    expect(r.warning).toBeTruthy();
  });

  it('fails when nothing answers, and on bad URL', async () => {
    mockFetch(() => jsonResponse(500, {}));
    expect((await auth.probe('https://h')).ok).toBe(false);
    expect((await auth.probe('nope')).error?.code).toBe('invalid_endpoint');
  });
});

describe('refresh / models / logout', () => {
  it('refresh sends bearer token', async () => {
    const f = mockFetch(() => jsonResponse(200, { ...LOGIN_OK, access_token: 'new' }));
    const p = await auth.refresh('https://h', 'old');
    expect(p.accessToken).toBe('new');
    expect((f.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer old');
  });

  it('listModels maps the OpenAI-style list', async () => {
    mockFetch(() =>
      jsonResponse(200, {
        object: 'list',
        data: [{ id: 'gpt', name: 'GPT', model_name: 'gpt-x', description: 'd', is_default: true }],
      })
    );
    expect(await auth.listModels('https://h', 't')).toEqual([
      { id: 'gpt', name: 'GPT', modelName: 'gpt-x', description: 'd', isDefault: true },
    ]);
  });

  it('logout swallows errors', async () => {
    mockFetch(() => jsonResponse(500, {}));
    await expect(auth.logout('https://h', 't')).resolves.toBeUndefined();
  });
});

describe('computeRefreshDelayMs', () => {
  const H = 3600_000;
  const now = 1_000_000_000_000;
  it('waits until 24h before expiry for a 7d token', () => {
    const exp = new Date(now + 7 * 24 * H).toISOString();
    expect(auth.computeRefreshDelayMs(exp, now, 7 * 24 * H)).toBe(6 * 24 * H);
  });
  it('refreshes now when already inside the window', () => {
    const exp = new Date(now + 2 * H).toISOString();
    expect(auth.computeRefreshDelayMs(exp, now, 7 * 24 * H)).toBe(0);
  });
  it('caps the window at half the TTL for short tokens (no refresh loop)', () => {
    const exp = new Date(now + 1 * H).toISOString();
    expect(auth.computeRefreshDelayMs(exp, now, 1 * H)).toBe(0.5 * H);
  });
  it('returns null for past/invalid expiry and caps long delays', () => {
    expect(auth.computeRefreshDelayMs('garbage', now)).toBeNull();
    expect(auth.computeRefreshDelayMs(new Date(now - 1).toISOString(), now)).toBeNull();
    const far = new Date(now + 400 * 24 * H).toISOString();
    expect(auth.computeRefreshDelayMs(far, now, 400 * 24 * H)).toBe(auth.MAX_TIMER_MS);
  });
});
