import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ seed: {} as Record<string, unknown> }));

vi.mock('electron-store', () => {
  class MockStore {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-enterprise.json';
    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}), ...mocks.seed };
    }
    get(key: string) {
      return this.store[key];
    }
    set(key: string, value: unknown) {
      this.store[key] = value;
    }
  }
  return { default: MockStore };
});
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '1.0.0' } }));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { EnterpriseStore } from '../src/main/enterprise/enterprise-store';

describe('EnterpriseStore', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('starts empty with defaults', () => {
    const s = new EnterpriseStore();
    expect(s.hasToken()).toBe(false);
    expect(s.get('endpoint')).toBe('');
    expect(s.get('onboardingDone')).toBe(false);
  });

  it('allowLocalMcp defaults to false, persists, and resets on disconnect', () => {
    const s = new EnterpriseStore();
    expect(s.get('allowLocalMcp')).toBe(false);
    s.set({ allowLocalMcp: true });
    expect(s.get('allowLocalMcp')).toBe(true);
    s.clearSession();
    expect(s.get('allowLocalMcp')).toBe(true);
    s.clearConnection();
    expect(s.get('allowLocalMcp')).toBe(false);
  });

  it('persists values and keeps the token out of snapshot()', () => {
    const s = new EnterpriseStore();
    s.set({
      endpoint: 'https://a.example/api',
      accessToken: 'secret-token',
      expiresAt: '2030-01-01T00:00:00Z',
      user: { userId: '1', identifier: 'u', displayName: 'U', roles: ['user'] },
    });
    expect(s.getAccessToken()).toBe('secret-token');
    const snap = s.snapshot();
    expect(snap.hasToken).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('secret-token');
    expect('accessToken' in snap).toBe(false);
  });

  it('clearSession keeps endpoint, clearConnection drops it', () => {
    const s = new EnterpriseStore();
    s.set({ endpoint: 'https://a.example', accessToken: 't', selectedModel: 'm', onboardingDone: true });
    s.clearSession();
    expect(s.hasToken()).toBe(false);
    expect(s.get('endpoint')).toBe('https://a.example');
    expect(s.get('selectedModel')).toBe('m');
    s.clearConnection();
    expect(s.get('endpoint')).toBe('');
    expect(s.get('selectedModel')).toBe('');
    expect(s.get('onboardingDone')).toBe(true);
  });
});
