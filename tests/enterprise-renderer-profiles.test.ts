import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  formatRelativeTime,
  getProfileLabel,
  getSyncErrorKey,
  getSyncViewModel,
  profileStorageKey,
  readStoredProfile,
  validateProfileSelection,
  writeStoredProfile,
  type StorageLike,
} from '../src/renderer/utils/enterprise-profiles';
import type { ManagedProfile } from '../src/shared/enterprise-sync-types';

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), 'utf8');
const profile = (slug: string, name = slug): ManagedProfile => ({
  slug,
  name,
  description: '',
  instructions: '',
  skills: [],
  mcpServers: [],
  nativeToolGroups: [],
});
const memStorage = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const throwing: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('profile selection persistence', () => {
  it('is keyed per endpoint (trailing slashes ignored)', () => {
    expect(profileStorageKey('https://a.it/api/')).toBe(profileStorageKey('https://a.it/api'));
    expect(profileStorageKey('https://a.it')).not.toBe(profileStorageKey('https://b.it'));
  });
  it('round-trips and clears', () => {
    const s = memStorage();
    writeStoredProfile(s, 'https://a.it', 'x');
    expect(readStoredProfile(s, 'https://a.it')).toBe('x');
    expect(readStoredProfile(s, 'https://b.it')).toBeNull();
    writeStoredProfile(s, 'https://a.it', null);
    expect(readStoredProfile(s, 'https://a.it')).toBeNull();
  });
  it('never throws when storage fails or is missing', () => {
    expect(readStoredProfile(throwing, 'e')).toBeNull();
    expect(() => writeStoredProfile(throwing, 'e', 'x')).not.toThrow();
    expect(readStoredProfile(null, 'e')).toBeNull();
  });
  it('drops slugs that no longer exist', () => {
    const list = [profile('a'), profile('b')];
    expect(validateProfileSelection('a', list)).toBe('a');
    expect(validateProfileSelection('gone', list)).toBeNull();
    expect(validateProfileSelection(null, list)).toBeNull();
  });
  it('label falls back to the slug', () => {
    expect(getProfileLabel('a', [profile('a', 'Assistente')])).toBe('Assistente');
    expect(getProfileLabel('zzz', [])).toBe('zzz');
  });
});

describe('getSyncViewModel', () => {
  const counts = { profiles: 2, skills: 3, mcpServers: 1 };
  it('maps states', () => {
    expect(getSyncViewModel(undefined).state).toBe('never');
    expect(getSyncViewModel({ state: 'idle', counts }).state).toBe('never');
    expect(
      getSyncViewModel({ state: 'idle', counts, lastSyncAt: '2026-01-01T00:00:00Z' }).state
    ).toBe('idle');
    const syncing = getSyncViewModel({ state: 'syncing', counts });
    expect(syncing.state).toBe('syncing');
    expect(syncing.canSync).toBe(false);
    expect(getSyncViewModel({ state: 'idle', counts, unsupported: true }).state).toBe(
      'unsupported'
    );
    const err = getSyncViewModel({
      state: 'error',
      counts,
      error: { code: 'timeout', message: 'm' },
    });
    expect(err).toMatchObject({
      state: 'error',
      errorCode: 'timeout',
      errorMessage: 'm',
      canSync: true,
    });
  });
  it('maps error codes to i18n keys', () => {
    expect(getSyncErrorKey('timeout')).toBe('enterprise.sync.errors.unreachable');
    expect(getSyncErrorKey('unauthorized')).toBe('enterprise.sync.errors.unauthorized');
    expect(getSyncErrorKey('weird')).toBeUndefined();
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  it('formats minutes/hours/days', () => {
    expect(formatRelativeTime('2026-10-19T11:55:00Z', now, 'en')).toBe('5 minutes ago');
    expect(formatRelativeTime('2026-10-19T09:00:00Z', now, 'en')).toBe('3 hours ago');
    expect(formatRelativeTime('2026-10-17T12:00:00Z', now, 'en')).toBe('2 days ago');
  });
  it('handles recent, invalid and missing', () => {
    expect(formatRelativeTime('2026-10-19T11:59:50Z', now, 'en')).toBe('now');
    expect(formatRelativeTime('nope', now)).toBeNull();
    expect(formatRelativeTime(undefined, now)).toBeNull();
  });
});

describe('renderer wiring (source checks)', () => {
  it('WelcomeView sends profileId only through the selector hook', () => {
    const src = read('src/renderer/components/WelcomeView.tsx');
    expect(src).toContain('useManagedProfiles');
    expect(src).toContain('<ProfileSelector');
    expect(src).toContain('selectedSlug ?? undefined');
    expect(src).not.toContain('setPendingSessionProfile');
  });
  it('useIPC.startSession forwards profileId in session.start; no invoke monkey-patch remains', () => {
    const ipc = read('src/renderer/hooks/useIPC.ts');
    expect(ipc).toContain('profileId?: string');
    expect(ipc).toContain('...(profileId ? { profileId } : {})');
    const utils = read('src/renderer/utils/enterprise-profiles.ts');
    expect(utils).not.toContain('setPendingSessionProfile');
    expect(utils).not.toContain('electronAPI');
  });
  it('ChatView shows the badge for the active session profile', () => {
    expect(read('src/renderer/components/ChatView.tsx')).toContain(
      '<ProfileBadge profileId={activeSession.profileId} />'
    );
  });
  it('hook is inert without profiles / enterprise mode', () => {
    const src = read('src/renderer/hooks/useManagedProfiles.ts');
    expect(src).toContain("status?.mode === 'enterprise'");
    expect(src).toContain('status.loggedIn');
    expect(src).toContain('lastSyncAt');
  });
  it('SettingsAccount shows the local-MCP opt-in only when localMcpCount > 0', () => {
    const src = read('src/renderer/components/settings/SettingsAccount.tsx');
    expect(src).toContain('localMcpCount > 0');
    expect(src).toContain('api.setAllowLocalMcp(allow)');
    expect(src).toContain("t('enterprise.sync.allowLocalMcp')");
    expect(src).toContain('checked={status.sync?.allowLocalMcp === true}');
  });
  it('IPC: channel declared, exposed by preload and handled in main', () => {
    expect(read('src/shared/enterprise-types.ts')).toContain("setAllowLocalMcp: 'enterprise.setAllowLocalMcp'");
    expect(read('src/preload/index.ts')).toContain('EC.setAllowLocalMcp');
    expect(read('src/main/enterprise/enterprise-ipc.ts')).toContain('ipcMain.handle(c.setAllowLocalMcp');
  });
  it('i18n keys exist in en/it/zh', () => {
    const keys = [
      ['enterprise', 'sync', 'title'],
      ['enterprise', 'sync', 'syncNow'],
      ['enterprise', 'sync', 'unsupported'],
      ['enterprise', 'sync', 'states', 'unsupported'],
      ['enterprise', 'sync', 'errors', 'generic'],
      ['enterprise', 'sync', 'allowLocalMcp'],
      ['enterprise', 'sync', 'allowLocalMcpWarning'],
      ['profile', 'selectorTitle'],
      ['profile', 'none'],
      ['profile', 'badgeTitle'],
    ];
    for (const l of ['en', 'it', 'zh']) {
      const d = JSON.parse(read(`src/renderer/i18n/locales/${l}.json`));
      for (const k of keys) {
        const v = k.reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], d);
        expect(typeof v, `${l}:${k.join('.')}`).toBe('string');
      }
    }
  });
});
