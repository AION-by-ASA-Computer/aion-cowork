import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../src/main/enterprise/auth';
import { EnterpriseService } from '../src/main/enterprise/enterprise-service';
import {
  DEFAULT_ENTERPRISE_DATA,
  type EnterpriseStoreData,
} from '../src/main/enterprise/enterprise-store';

function makeStore() {
  const data: EnterpriseStoreData = { ...DEFAULT_ENTERPRISE_DATA };
  return {
    data,
    get: (k: keyof EnterpriseStoreData) => data[k],
    set: (p: Partial<EnterpriseStoreData>) => Object.assign(data, p),
    getAccessToken: () => data.accessToken,
    hasToken: () => Boolean(data.accessToken),
    clearSession: () =>
      Object.assign(data, {
        accessToken: '',
        expiresAt: '',
        user: null,
        mustChangePassword: false,
        sessionExpired: false,
      }),
    clearConnection() {
      this.clearSession();
      Object.assign(data, { endpoint: '', selectedModel: '', serverVersion: '' });
    },
  };
}

function setup(configured = false) {
  const store = makeStore();
  const config = {
    isConfigured: vi.fn(() => configured),
    getAll: vi.fn(() => ({ prev: true })),
    applyManagedAionSet: vi.fn(),
    removeManagedAionSet: vi.fn(),
  };
  const sync = vi.fn(async () => ({}));
  const emitStatus = vi.fn();
  const svc = new EnterpriseService({
    store: store as never,
    config,
    syncConfigAfterMutation: sync,
    emitStatus,
  });
  return { store, config, sync, emitStatus, svc };
}

const LOGIN_OK = {
  access_token: 'tok',
  user_id: 'u1',
  identifier: 'mario',
  display_name: 'Mario',
  roles: ['user'],
  must_change_password: false,
  expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
};

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function route(handlers: Record<string, () => Response>) {
  auth.setFetchImplementation(((url: string) => {
    const path = Object.keys(handlers).find((p) => url.endsWith(p));
    return Promise.resolve(path ? handlers[path]() : res(404, {}));
  }) as unknown as typeof fetch);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  auth.setFetchImplementation(null);
});

describe('EnterpriseService.getStatus', () => {
  it('requires onboarding only when not chosen and nothing configured', () => {
    expect(setup(false).svc.getStatus()).toMatchObject({
      mode: 'standalone',
      onboardingRequired: true,
      loggedIn: false,
    });
    expect(setup(true).svc.getStatus().onboardingRequired).toBe(false);
    const s = setup(false);
    s.store.data.onboardingDone = true;
    expect(s.svc.getStatus().onboardingRequired).toBe(false);
  });

  it('never exposes the token and reflects sessionExpired', () => {
    const { store, svc } = setup();
    Object.assign(store.data, {
      endpoint: 'https://h/api',
      accessToken: 'secret',
      expiresAt: '2030-01-01T00:00:00Z',
      sessionExpired: true,
      selectedModel: 'm',
    });
    const st = svc.getStatus();
    expect(JSON.stringify(st)).not.toContain('secret');
    expect(st).toMatchObject({ mode: 'enterprise', loggedIn: false, sessionExpired: true, selectedModel: 'm' });
  });

  it('chooseStandalone clears onboarding and emits', async () => {
    const { svc, emitStatus } = setup();
    const st = await svc.chooseStandalone();
    expect(st.onboardingRequired).toBe(false);
    expect(emitStatus).toHaveBeenCalledWith(st);
  });
});

describe('EnterpriseService flows', () => {
  it('login applies the managed set with the default model and syncs config', async () => {
    const { svc, config, sync, store } = setup();
    route({
      '/auth/login': () => res(200, LOGIN_OK),
      '/v1/client/info': () => res(200, { product: 'aion-agent', api_version: 1, version: '1.6.2' }),
      '/v1/llm/models': () =>
        res(200, { data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', is_default: true }] }),
    });
    const r = await svc.login({ endpoint: 'https://h/api/', username: 'u', password: 'p' });
    expect(r.status).toBe('ok');
    expect(config.applyManagedAionSet).toHaveBeenCalledWith({
      endpoint: 'https://h/api',
      token: 'tok',
      model: 'b',
      modelLabel: undefined,
    });
    expect(sync).toHaveBeenCalledWith({ prev: true });
    expect(store.data.serverVersion).toBe('1.6.2');
    expect(store.data.onboardingDone).toBe(true);
    svc.stopScheduler();
  });

  it('returns mfa_required without storing a token, then completes via verifyMfa', async () => {
    const { svc, store } = setup();
    route({
      '/auth/login': () => res(200, { mfa_required: true, mfa_stage: 'verify', mfa_token: 'm' }),
      '/auth/2fa/verify': () => res(200, LOGIN_OK),
      '/v1/llm/models': () => res(200, { data: [] }),
      '/v1/client/info': () => res(404, {}),
    });
    const r = await svc.login({ endpoint: 'https://h', username: 'u', password: 'p' });
    expect(r).toMatchObject({ status: 'mfa_required', mfaStage: 'verify', mfaToken: 'm' });
    expect(store.data.accessToken).toBe('');
    const v = await svc.verifyMfa({ mfaToken: 'm', code: '123456' });
    expect(v.status).toBe('ok');
    expect(store.data.endpoint).toBe('https://h');
    svc.stopScheduler();
  });

  it('login errors are mapped, nothing applied', async () => {
    const { svc, config } = setup();
    route({ '/auth/login': () => res(429, { detail: { code: 'mfa_locked', retry_after: 30 } }) });
    const r = await svc.login({ endpoint: 'https://h', username: 'u', password: 'p' });
    expect(r).toMatchObject({ status: 'error', error: { code: 'mfa_locked', retryAfter: 30 } });
    expect(config.applyManagedAionSet).not.toHaveBeenCalled();
  });

  it('refresh 401 marks the session expired and emits', async () => {
    const { svc, store, emitStatus } = setup();
    Object.assign(store.data, { endpoint: 'https://h', accessToken: 't', expiresAt: LOGIN_OK.expires_at });
    route({ '/auth/refresh': () => res(401, { detail: 'expired' }) });
    const r = await svc.refresh();
    expect(r.ok).toBe(false);
    expect(store.data.sessionExpired).toBe(true);
    expect(emitStatus).toHaveBeenCalled();
    expect(svc.getStatus().loggedIn).toBe(false);
  });

  it('refresh success updates token and managed set', async () => {
    const { svc, store, config } = setup();
    Object.assign(store.data, {
      endpoint: 'https://h',
      accessToken: 'old',
      expiresAt: LOGIN_OK.expires_at,
      selectedModel: 'm',
    });
    route({ '/auth/refresh': () => res(200, { ...LOGIN_OK, access_token: 'new' }) });
    const r = await svc.refresh();
    expect(r.ok).toBe(true);
    expect(store.data.accessToken).toBe('new');
    expect(config.applyManagedAionSet).toHaveBeenCalledWith(expect.objectContaining({ token: 'new', model: 'm' }));
    svc.stopScheduler();
  });

  it('scheduler fires a refresh inside the window, one timer at a time', async () => {
    const { svc, store } = setup();
    Object.assign(store.data, {
      endpoint: 'https://h',
      accessToken: 't',
      expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    });
    let calls = 0;
    route({
      '/auth/refresh': () => {
        calls++;
        return res(200, { ...LOGIN_OK, expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString() });
      },
    });
    svc.startScheduler();
    svc.startScheduler();
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(calls).toBe(1);
    svc.stopScheduler();
  });

  it('logout clears the session, disconnect removes the managed set', async () => {
    const { svc, store, config, sync } = setup();
    Object.assign(store.data, { endpoint: 'https://h', accessToken: 't', onboardingDone: true });
    route({ '/auth/logout': () => res(200, { ok: true }) });
    const st = await svc.disconnect();
    expect(store.data.accessToken).toBe('');
    expect(store.data.endpoint).toBe('');
    expect(config.removeManagedAionSet).toHaveBeenCalled();
    expect(sync).toHaveBeenCalled();
    expect(st.mode).toBe('standalone');
  });

  it('changePassword clears mustChangePassword and applies the set', async () => {
    const { svc, store, config } = setup();
    Object.assign(store.data, {
      endpoint: 'https://h',
      accessToken: 't',
      mustChangePassword: true,
      selectedModel: 'm',
      expiresAt: LOGIN_OK.expires_at,
    });
    route({ '/auth/change-password': () => res(200, {}) });
    const r = await svc.changePassword({ oldPassword: 'a', newPassword: 'b' });
    expect(r.ok).toBe(true);
    expect(store.data.mustChangePassword).toBe(false);
    expect(config.applyManagedAionSet).toHaveBeenCalled();
    svc.stopScheduler();
  });
});
