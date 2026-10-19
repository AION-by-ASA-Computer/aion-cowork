import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../src/main/enterprise/auth';
import { SyncService } from '../src/main/enterprise/sync';
import { DEFAULT_MANAGED_DATA, type ManagedStoreData } from '../src/main/enterprise/managed-store';
import {
  createManagedProfileResolver,
  getManagedProfileResolver,
  setManagedProfileResolver,
} from '../src/main/enterprise/profile-resolver';
import type { ClientBootstrap } from '../src/shared/enterprise-sync-types';

const BOOT: ClientBootstrap = {
  revision: 'sha256:1',
  profiles: [
    { slug: 'p1', name: 'P1', description: '', instructions: 'i', skills: ['s1'], mcpServers: ['rag'], nativeToolGroups: [] },
  ],
  skills: [{ name: 's1', description: '', tags: [], version: 1, content: '# s1' }],
  mcpServers: [
    { slug: 'rag', displayName: 'R', execution: 'client_remote', transport: { type: 'sse', url: 'https://x/sse' }, auth: 'aion_token' },
    { slug: 'mem', displayName: 'M', execution: 'server_only', auth: 'none' },
    { slug: 'other', displayName: 'O', execution: 'client_remote', transport: { type: 'sse', url: 'https://y/sse' }, auth: 'none' },
  ],
  policy: { syncIntervalSec: 120 },
};

function setup(over: Partial<{ fetch: ReturnType<typeof vi.fn> }> = {}) {
  const data: ManagedStoreData = { ...DEFAULT_MANAGED_DATA };
  const managed = {
    get: (k: keyof ManagedStoreData) => data[k],
    set: (p: Partial<ManagedStoreData>) => Object.assign(data, p),
    clear: () => Object.assign(data, { ...DEFAULT_MANAGED_DATA }),
  };
  const fetchBootstrap = over.fetch ?? vi.fn(async () => ({ status: 'ok', etag: '"e1"', data: BOOT }));
  const skills = { apply: vi.fn(() => [{ name: 's1', description: '', tags: [], version: 1, contentHash: 'h' }]), clear: vi.fn() };
  const mcp = { apply: vi.fn(async () => ({ added: [], updated: [], removed: [] })), clear: vi.fn(async () => {}) };
  const onSessionExpired = vi.fn();
  const onChange = vi.fn();
  const svc = new SyncService({
    getEndpoint: () => 'https://h/api',
    getToken: () => 'tok',
    managed: managed as never,
    skills,
    mcp,
    onSessionExpired,
    onChange,
    fetchBootstrap: fetchBootstrap as never,
    random: () => 0.5,
  });
  return { svc, data, fetchBootstrap, skills, mcp, onSessionExpired, onChange };
}

afterEach(() => vi.useRealTimers());

describe('SyncService local MCP status', () => {
  it('reports localMcpCount and allowLocalMcp (default false) and re-applies on demand', async () => {
    const t = setup();
    t.data.mcpServers = [
      { slug: 'fs', displayName: 'fs', execution: 'client_local', transport: { type: 'stdio', command: 'x' }, auth: 'none' },
      BOOT.mcpServers[0],
    ];
    const st = t.svc.getStatus();
    expect(st.localMcpCount).toBe(1);
    expect(st.allowLocalMcp).toBe(false);
    await t.svc.reapplyMcp();
    expect(t.mcp.apply).toHaveBeenCalledWith(t.data.mcpServers);
  });
});

describe('SyncService', () => {
  it('applies a bootstrap and then sends the ETag (304 keeps data)', async () => {
    const t = setup();
    const st = await t.svc.syncNow();
    expect(st.state).toBe('idle');
    expect(st.counts).toEqual({ profiles: 1, skills: 1, mcpServers: 2 });
    expect(st.revision).toBe('sha256:1');
    expect(t.skills.apply).toHaveBeenCalledOnce();
    expect(t.mcp.apply).toHaveBeenCalledWith(BOOT.mcpServers);
    t.fetchBootstrap.mockResolvedValueOnce({ status: 'not_modified' });
    await t.svc.syncNow();
    expect(t.fetchBootstrap.mock.calls[1][2]).toBe('"e1"');
    expect(t.skills.apply).toHaveBeenCalledOnce();
    expect(t.svc.listProfiles()).toHaveLength(1);
  });

  it('does not run concurrent syncs', async () => {
    const t = setup();
    await Promise.all([t.svc.syncNow(), t.svc.syncNow()]);
    expect(t.fetchBootstrap).toHaveBeenCalledOnce();
  });

  it('marks the session expired on 401 and stops', async () => {
    const t = setup({
      fetch: vi.fn(async () => {
        throw new auth.EnterpriseHttpError(401, { code: 'invalid_credentials', message: 'x' });
      }),
    });
    const st = await t.svc.syncNow();
    expect(st.state).toBe('error');
    expect(t.onSessionExpired).toHaveBeenCalled();
  });

  it('flags unsupported servers without an error and keeps going', async () => {
    const t = setup({
      fetch: vi.fn(async () => {
        throw new auth.EnterpriseHttpError(404, { code: 'bootstrap_unsupported', message: 'x' });
      }),
    });
    const st = await t.svc.syncNow();
    expect(st.unsupported).toBe(true);
    expect(st.state).toBe('idle');
    expect(st.error).toBeUndefined();
  });

  it('records network errors and retries on the next interval', async () => {
    const t = setup({
      fetch: vi.fn(async () => {
        throw new auth.EnterpriseHttpError(0, { code: 'network_error', message: 'down' });
      }),
    });
    const st = await t.svc.syncNow();
    expect(st).toMatchObject({ state: 'error', error: { code: 'network_error' } });
    expect(t.onSessionExpired).not.toHaveBeenCalled();
  });

  it('does not store the etag when applying fails', async () => {
    const t = setup();
    t.skills.apply.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const st = await t.svc.syncNow();
    expect(st.state).toBe('error');
    expect(t.data.etag).toBe('');
  });

  it('clear() removes managed data and discards an in-flight result', async () => {
    const t = setup();
    await t.svc.syncNow();
    await t.svc.clear();
    expect(t.mcp.clear).toHaveBeenCalled();
    expect(t.skills.clear).toHaveBeenCalled();
    expect(t.svc.getStatus().counts).toEqual({ profiles: 0, skills: 0, mcpServers: 0 });
    expect(t.data.etag).toBe('');

    let release!: () => void;
    const t2 = setup({
      fetch: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ status: 'ok', etag: '"x"', data: BOOT });
          })
      ),
    });
    const p = t2.svc.syncNow();
    await t2.svc.clear();
    release();
    await p;
    expect(t2.skills.apply).not.toHaveBeenCalled();
    expect(t2.data.profiles).toEqual([]);
  });

  describe('scheduler', () => {
    beforeEach(() => vi.useFakeTimers());

    it('syncs immediately, then every policy interval (min 60 s) until stopped', async () => {
      const t = setup();
      t.svc.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.fetchBootstrap).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(t.fetchBootstrap).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.fetchBootstrap).toHaveBeenCalledTimes(2);
      t.svc.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.fetchBootstrap).toHaveBeenCalledTimes(2);
    });

    it('never schedules faster than 60 s', async () => {
      const t = setup();
      t.data.syncIntervalSec = 5;
      t.fetchBootstrap.mockResolvedValue({ status: 'not_modified' });
      t.svc.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(t.fetchBootstrap).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(t.fetchBootstrap).toHaveBeenCalledTimes(2);
      t.svc.stop();
    });
  });
});

describe('ManagedProfileResolver', () => {
  const resolver = createManagedProfileResolver({
    getProfiles: () => BOOT.profiles,
    getMcpServers: () => BOOT.mcpServers,
    getSkillPaths: (slug) => [`/sets/${slug}`],
  });

  it('filters allowed managed MCP names by profile and ignores server_only', () => {
    expect(resolver.getAllowedManagedMcpNames('p1')).toEqual(['aion_rag']);
    expect(resolver.getAllowedManagedMcpNames('nope')).toBeNull();
  });

  it('identifies managed names', () => {
    expect(resolver.isManagedMcpName('aion_rag')).toBe(true);
    expect(resolver.isManagedMcpName('aion_other')).toBe(true);
    expect(resolver.isManagedMcpName('aion_mem')).toBe(false);
    expect(resolver.isManagedMcpName('mine')).toBe(false);
  });

  it('exposes profiles and skill paths only for known profiles', () => {
    expect(resolver.listProfiles()).toHaveLength(1);
    expect(resolver.getProfile('p1')?.name).toBe('P1');
    expect(resolver.getProfile('x')).toBeNull();
    expect(resolver.getSkillPaths('p1')).toEqual(['/sets/p1']);
    expect(resolver.getSkillPaths('x')).toEqual([]);
  });

  it('accessor is null until registered', () => {
    setManagedProfileResolver(null);
    expect(getManagedProfileResolver()).toBeNull();
    setManagedProfileResolver(resolver);
    expect(getManagedProfileResolver()).toBe(resolver);
    setManagedProfileResolver(null);
  });
});
