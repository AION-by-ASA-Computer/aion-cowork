import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState: { data: Record<string, unknown> } = { data: { servers: [] } };

vi.mock('electron-store', () => {
  class MockStore {
    get(key: string, d?: unknown) {
      return Object.prototype.hasOwnProperty.call(storeState.data, key) ? storeState.data[key] : d;
    }
    set(key: string, value: unknown) {
      storeState.data[key] = value;
    }
    delete(key: string) {
      delete storeState.data[key];
    }
    get store() {
      return storeState.data;
    }
  }
  return { default: MockStore };
});
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }));

import { mcpConfigStore } from '../src/main/mcp/mcp-config-store';
import { ManagedMcpApplier, toMcpConfig } from '../src/main/enterprise/managed-mcp';
import type { ManagedMcpServer } from '../src/shared/enterprise-sync-types';

const remote = (slug: string, auth: 'none' | 'aion_token' = 'aion_token'): ManagedMcpServer => ({
  slug,
  displayName: slug,
  execution: 'client_remote',
  transport: { type: 'sse', url: `https://x.test/${slug}/sse` },
  auth,
});
const serverOnly: ManagedMcpServer = { slug: 'memory', displayName: 'm', execution: 'server_only', auth: 'none' };

function setup(token = 'TOK') {
  const runtime = { updateServer: vi.fn(async () => {}), removeServer: vi.fn(async () => {}), invalidateCache: vi.fn() };
  const applier = new ManagedMcpApplier(mcpConfigStore, () => token, runtime);
  return { runtime, applier };
}

beforeEach(() => {
  storeState.data = { servers: [{ id: 'user-1', name: 'Mine', type: 'stdio', command: 'x', enabled: true }] };
});

describe('ManagedMcpApplier', () => {
  it('creates only client_* servers with managed ids/names and is idempotent', async () => {
    const { applier, runtime } = setup();
    const r1 = await applier.apply([remote('khub_rag'), serverOnly]);
    expect(r1.added).toEqual(['aion-managed-khub_rag']);
    const managed = mcpConfigStore.getManagedServers();
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({
      id: 'aion-managed-khub_rag',
      name: 'aion_khub_rag',
      type: 'sse',
      managed: true,
      enabled: true,
    });
    expect(mcpConfigStore.getServers().map((s) => s.id)).toContain('user-1');
    const before = JSON.stringify(storeState.data);
    runtime.updateServer.mockClear();
    const r2 = await applier.apply([remote('khub_rag'), serverOnly]);
    expect(r2).toEqual({ added: [], updated: [], removed: [] });
    expect(JSON.stringify(storeState.data)).toBe(before);
    expect(runtime.updateServer).not.toHaveBeenCalled();
  });

  it('updates changed entries and removes the ones that disappeared (user servers untouched)', async () => {
    const { applier, runtime } = setup();
    await applier.apply([remote('a'), remote('b')]);
    const changed = remote('a');
    changed.transport = { type: 'sse', url: 'https://other.test/sse' };
    const r = await applier.apply([changed]);
    expect(r.updated).toEqual(['aion-managed-a']);
    expect(r.removed).toEqual(['aion-managed-b']);
    expect(runtime.removeServer).toHaveBeenCalledWith('aion-managed-b');
    expect(mcpConfigStore.getServer('aion-managed-a')?.url).toBe('https://other.test/sse');
    expect(mcpConfigStore.getServer('user-1')).toBeTruthy();
    await applier.clear();
    expect(mcpConfigStore.getManagedServers()).toEqual([]);
    expect(mcpConfigStore.getServer('user-1')).toBeTruthy();
  });

  it('never persists the token and injects it at runtime only for aion_token servers', async () => {
    const { applier } = setup('SECRET-TOKEN');
    await applier.apply([remote('a', 'aion_token'), remote('b', 'none')]);
    expect(JSON.stringify(storeState.data)).not.toContain('SECRET-TOKEN');
    expect(applier.headerProvider(mcpConfigStore.getServer('aion-managed-a')!)).toEqual({
      Authorization: 'Bearer SECRET-TOKEN',
    });
    expect(applier.headerProvider(mcpConfigStore.getServer('aion-managed-b')!)).toBeUndefined();
    // a user server cannot receive the token
    expect(applier.headerProvider({ id: 'aion-managed-a', name: 'x', type: 'sse', enabled: true })).toBeUndefined();
  });

  it('reconnects aion_token servers when the token changes', async () => {
    const { applier, runtime } = setup();
    await applier.apply([remote('a', 'aion_token'), remote('b', 'none')]);
    runtime.updateServer.mockClear();
    await applier.onTokenChanged();
    expect(runtime.updateServer).toHaveBeenCalledTimes(1);
    expect(runtime.updateServer.mock.calls[0][0]).toMatchObject({ id: 'aion-managed-a' });
    expect(runtime.invalidateCache).toHaveBeenCalled();
  });

  it('maps stdio transports and refuses server_only', () => {
    expect(toMcpConfig(serverOnly)).toBeNull();
    expect(
      toMcpConfig({
        slug: 'l',
        displayName: 'l',
        execution: 'client_local',
        transport: { type: 'stdio', command: 'node', args: ['a.js'] },
        auth: 'none',
      })
    ).toMatchObject({ type: 'stdio', command: 'node', args: ['a.js'], managed: true });
  });
});

describe('managed guards on user writes', () => {
  beforeEach(async () => {
    await setup().applier.apply([remote('a')]);
  });

  it('rejects editing/deleting managed entries and forged managed flags', () => {
    const existing = mcpConfigStore.getServer('aion-managed-a')!;
    expect(mcpConfigStore.checkUserWrite({ ...existing, enabled: false })).toBeTruthy();
    expect(() => mcpConfigStore.saveServer({ ...existing, url: 'https://evil' })).toThrow();
    expect(mcpConfigStore.checkUserDelete('aion-managed-a')).toBeTruthy();
    expect(() => mcpConfigStore.deleteServer('aion-managed-a')).toThrow();
    // forged flag / reserved id / name clash
    expect(
      mcpConfigStore.checkUserWrite({ id: 'u2', name: 'N', type: 'stdio', command: 'x', enabled: true, managed: true })
    ).toBeTruthy();
    expect(
      mcpConfigStore.checkUserWrite({ id: 'aion-managed-zzz', name: 'N', type: 'stdio', command: 'x', enabled: true })
    ).toBeTruthy();
    expect(
      mcpConfigStore.checkUserWrite({ id: 'u3', name: 'aion_a', type: 'stdio', command: 'x', enabled: true })
    ).toBeTruthy();
    expect(mcpConfigStore.getServer('aion-managed-a')?.url).toBe('https://x.test/a/sse');
  });

  it('still allows normal user servers', () => {
    const s = { id: 'u9', name: 'Ok', type: 'stdio' as const, command: 'x', enabled: true };
    expect(mcpConfigStore.checkUserWrite(s)).toBeNull();
    mcpConfigStore.saveServer(s);
    expect(mcpConfigStore.getServer('u9')).toBeTruthy();
    mcpConfigStore.deleteServer('u9');
    expect(mcpConfigStore.getServer('u9')).toBeUndefined();
  });

  it('setServers (document import) cannot drop or forge managed entries', () => {
    mcpConfigStore.setServers([
      { id: 'u5', name: 'U5', type: 'stdio', command: 'x', enabled: true },
      { id: 'aion-managed-a', name: 'aion_a', type: 'sse', url: 'https://evil', enabled: true },
      { id: 'u6', name: 'U6', type: 'stdio', command: 'y', enabled: true, managed: true },
    ]);
    const all = mcpConfigStore.getServers();
    expect(all.find((s) => s.id === 'aion-managed-a')?.url).toBe('https://x.test/a/sse');
    expect(all.find((s) => s.id === 'u6')).toBeUndefined();
    expect(all.find((s) => s.id === 'u5')).toBeTruthy();
    mcpConfigStore.setServers([]);
    expect(mcpConfigStore.getManagedServers()).toHaveLength(1);
  });
});

describe('client_local gate (allowLocalMcp)', () => {
  const local: ManagedMcpServer = {
    slug: 'fs',
    displayName: 'fs',
    execution: 'client_local',
    transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp'] },
    auth: 'none',
  };
  function gated(initial = false) {
    const flag = { allow: initial };
    const applier = new ManagedMcpApplier(mcpConfigStore, () => 't', {}, undefined, [], () => flag.allow);
    return { flag, applier };
  }

  it('is off by default: client_local is never created', async () => {
    const applier = new ManagedMcpApplier(mcpConfigStore, () => 't');
    await applier.apply([remote('a'), local]);
    expect(mcpConfigStore.getManagedServers().map((s) => s.id)).toEqual(['aion-managed-a']);
  });

  it('creates entries when turned on and removes them when turned off', async () => {
    const { flag, applier } = gated(false);
    const list = [remote('a'), local];
    await applier.apply(list);
    expect(mcpConfigStore.getServer('aion-managed-fs')).toBeFalsy();
    flag.allow = true;
    const on = await applier.apply(list);
    expect(on.added).toEqual(['aion-managed-fs']);
    expect(mcpConfigStore.getServer('aion-managed-fs')).toMatchObject({ type: 'stdio', command: 'npx' });
    flag.allow = false;
    const off = await applier.apply(list);
    expect(off.removed).toEqual(['aion-managed-fs']);
    expect(mcpConfigStore.getServer('aion-managed-fs')).toBeFalsy();
    expect(mcpConfigStore.getServer('aion-managed-a')).toBeTruthy();
  });
});
