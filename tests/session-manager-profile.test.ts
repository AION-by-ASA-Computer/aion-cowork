import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance } from '../src/main/db/database';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-session-manager-profile-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}) };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = { ...this.store, ...key };
    }
  }
  return { default: MockStore };
});

vi.mock('../src/main/agent/agent-runner', () => ({
  CoworkAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

import { SessionManager } from '../src/main/session/session-manager';

import { setManagedProfileResolver } from '../src/main/enterprise/engine-bridge';

function makeDb(): DatabaseInstance {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(() => null),
      getAll: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messages: {
      create: vi.fn(),
      getBySessionId: vi.fn(() => []),
      delete: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
    traceSteps: {
      create: vi.fn(),
      update: vi.fn(),
      getBySessionId: vi.fn(() => []),
      deleteBySessionId: vi.fn(),
    },
  } as unknown as DatabaseInstance;
}

const resolver = {
  listProfiles: () => [],
  getProfile: (slug: string) =>
    slug === 'legal'
      ? {
          slug: 'legal',
          name: 'Legal',
          description: '',
          instructions: 'x',
          skills: [],
          mcpServers: [],
          nativeToolGroups: [],
        }
      : null,
  getSkillPaths: () => [],
  getAllowedManagedMcpNames: () => [],
  isManagedMcpName: () => false,
};

describe('SessionManager.startSession profileId', () => {
  afterEach(() => setManagedProfileResolver(null));

  async function start(profileId?: string) {
    const db = makeDb();
    const manager = new SessionManager(db, vi.fn());
    (manager as unknown as { enqueuePrompt: () => void }).enqueuePrompt = vi.fn();
    const session = await manager.startSession(
      't',
      'p',
      '/tmp',
      undefined,
      undefined,
      undefined,
      profileId
    );
    return { db, session };
  }

  it('stores a known profile slug', async () => {
    setManagedProfileResolver(resolver);
    const { db, session } = await start('legal');
    expect(session.profileId).toBe('legal');
    expect(db.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ profile_id: 'legal' })
    );
  });

  it('drops an unknown profile slug', async () => {
    setManagedProfileResolver(resolver);
    const { db, session } = await start('ghost');
    expect(session.profileId).toBeUndefined();
    expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ profile_id: null }));
  });

  it('drops the slug when no resolver is registered (standalone)', async () => {
    const { session } = await start('legal');
    expect(session.profileId).toBeUndefined();
  });

  it('maps profile_id on listSessions', () => {
    const db = makeDb();
    (db.sessions.getAll as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 's',
        title: 't',
        claude_session_id: null,
        openai_thread_id: null,
        status: 'idle',
        cwd: null,
        mounted_paths: '[]',
        allowed_tools: '[]',
        memory_enabled: 0,
        model: null,
        profile_id: 'legal',
        created_at: 1,
        updated_at: 1,
      },
    ]);
    expect(new SessionManager(db, vi.fn()).listSessions()[0].profileId).toBe('legal');
  });
});
