import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  formatExpiry,
  getEnterpriseErrorKey,
  getEnterpriseViewState,
  isSsoOnlyError,
  normalizeEndpointInput,
  probeBlocksPasswordLogin,
} from '../src/renderer/utils/enterprise-helpers';
import type { EnterpriseStatus } from '../src/shared/enterprise-types';

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), 'utf8');
const base: EnterpriseStatus = { mode: 'standalone', onboardingRequired: false, loggedIn: false };

describe('normalizeEndpointInput', () => {
  it('trims, strips trailing slashes and defaults to https', () => {
    expect(normalizeEndpointInput('  agent.azienda.it/api// ')).toEqual({
      ok: true,
      endpoint: 'https://agent.azienda.it/api',
      insecure: false,
    });
  });
  it('flags plain http except on localhost', () => {
    expect(normalizeEndpointInput('http://host:8001')).toMatchObject({ ok: true, insecure: true });
    expect(normalizeEndpointInput('http://localhost:8001')).toMatchObject({ insecure: false });
  });
  it('rejects empty and invalid input', () => {
    expect(normalizeEndpointInput('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeEndpointInput('ftp://x.it')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeEndpointInput('http://')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('getEnterpriseViewState', () => {
  it('maps status to view state', () => {
    expect(getEnterpriseViewState(null)).toBe('loading');
    expect(getEnterpriseViewState({ ...base, onboardingRequired: true })).toBe('onboarding');
    expect(getEnterpriseViewState(base)).toBe('standalone');
    const ent = { ...base, mode: 'enterprise' as const };
    expect(getEnterpriseViewState({ ...ent, sessionExpired: true, loggedIn: true })).toBe('session-expired');
    expect(getEnterpriseViewState(ent)).toBe('logged-out');
    expect(getEnterpriseViewState({ ...ent, loggedIn: true, mustChangePassword: true })).toBe('must-change-password');
    expect(getEnterpriseViewState({ ...ent, loggedIn: true })).toBe('connected');
  });
});

describe('error helpers', () => {
  it('maps codes to i18n keys', () => {
    expect(getEnterpriseErrorKey('sso_required')).toBe('enterprise.errors.ssoNotAvailable');
    expect(getEnterpriseErrorKey('mfa_locked')).toBe('enterprise.errors.mfaLocked');
    expect(getEnterpriseErrorKey('whatever')).toBeUndefined();
  });
  it('detects sso-only errors and probe blocking', () => {
    expect(isSsoOnlyError({ code: 'password_login_disabled', message: '' })).toBe(true);
    expect(isSsoOnlyError({ code: 'x', message: '' })).toBe(false);
    expect(probeBlocksPasswordLogin({ ok: true, endpoint: 'e', verified: true, passwordAuthEnabled: false })).toBe(true);
    expect(probeBlocksPasswordLogin(null)).toBe(false);
  });
  it('formats expiry safely', () => {
    expect(formatExpiry(undefined)).toBeNull();
    expect(formatExpiry('nope')).toBeNull();
    expect(formatExpiry('2026-10-26T10:00:00Z')).toBeTruthy();
  });
});

describe('enterprise renderer wiring (source)', () => {
  it('App renders EnterpriseOnboarding gated by onboardingRequired', () => {
    const app = read('src/renderer/App.tsx');
    expect(app).toContain('enterpriseStatus?.onboardingRequired');
    expect(app).toMatch(/showEnterpriseOnboarding && \(/);
    expect(app).toContain('<EnterpriseOnboarding');
  });
  it('useIPC.ts is untouched by enterprise wiring', () => {
    const ipc = read('src/renderer/hooks/useIPC.ts');
    expect(ipc).not.toMatch(/enterprise/i);
  });
  it('SettingsPanel and nav-server know the account tab', () => {
    const panel = read('src/renderer/components/SettingsPanel.tsx');
    expect(panel.match(/'account'/g)!.length).toBeGreaterThanOrEqual(4);
    expect(panel).toContain("id: 'account' as TabId");
    expect(read('src/main/nav-server.ts')).toContain("'account'");
  });
  it('QR svg is rendered through <img data:> and never innerHTML', () => {
    const src = read('src/renderer/components/EnterpriseOnboarding.tsx');
    expect(src).toContain('data:image/svg+xml');
    expect(src).not.toContain('dangerouslySetInnerHTML');
  });
  it('all enterprise.* keys used exist in en/it/zh', () => {
    const src =
      read('src/renderer/components/EnterpriseOnboarding.tsx') +
      read('src/renderer/components/settings/SettingsAccount.tsx') +
      read('src/renderer/utils/enterprise-helpers.ts');
    const keys = new Set([...src.matchAll(/'(enterprise\.[A-Za-z.]+)'/g)].map((m) => m[1]));
    for (const lang of ['en', 'it', 'zh']) {
      const json = JSON.parse(read(`src/renderer/i18n/locales/${lang}.json`));
      for (const key of keys) {
        const v = key.split('.').reduce((o: any, k) => o?.[k], json);
        expect(typeof v, `${lang}:${key}`).toBe('string');
      }
      expect(typeof json.settings.account).toBe('string');
    }
  });
});

import { getEnterpriseErrorKey as _key, isLoginCancelled, resolveLoginMethods } from '../src/renderer/utils/enterprise-helpers';

describe('resolveLoginMethods', () => {
  const base = { ok: true, endpoint: 'e', verified: true };
  it('offers both while the probe is unknown', () => {
    expect(resolveLoginMethods(null)).toEqual({ browser: true, password: true });
  });
  it('desktopLogin servers: browser first, password only when allowed', () => {
    expect(resolveLoginMethods({ ...base, desktopLogin: true, passwordAuthEnabled: true, loginMode: 'password' }))
      .toEqual({ browser: true, password: true });
    expect(resolveLoginMethods({ ...base, desktopLogin: true, ssoEnabled: true, passwordAuthEnabled: false }))
      .toEqual({ browser: true, password: false });
    expect(resolveLoginMethods({ ...base, desktopLogin: true, loginMode: 'sso' }))
      .toEqual({ browser: true, password: false });
  });
  it('servers without desktopLogin keep the password form; SSO-only gets nothing', () => {
    expect(resolveLoginMethods({ ...base })).toEqual({ browser: false, password: true });
    expect(resolveLoginMethods({ ...base, ssoEnabled: true, passwordAuthEnabled: false }))
      .toEqual({ browser: false, password: false });
  });
  it('maps the new error codes', () => {
    expect(_key('login_timeout')).toBeDefined();
    expect(_key('state_mismatch')).toBeDefined();
    expect(_key('code_expired')).toBe(_key('exchange_failed'));
    expect(_key('desktop_login_unsupported')).toBeDefined();
    expect(isLoginCancelled({ code: 'login_cancelled', message: '' })).toBe(true);
  });
});
