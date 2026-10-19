import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProfile, ManagedProfileResolver } from '../src/shared/enterprise-sync-types';
import {
  buildProfilePromptSection,
  filterMcpToolsForProfile,
  getManagedProfileResolver,
  getProfilePromptSection,
  getProfileSignature,
  getProfileSkillPaths,
  isKnownProfileSlug,
  setManagedProfileResolver,
} from '../src/main/enterprise/engine-bridge';
import { buildPiSessionRuntimeSignature } from '../src/main/agent/pi-session-runtime';

function makeProfile(overrides: Partial<ManagedProfile> = {}): ManagedProfile {
  return {
    slug: 'legal',
    name: 'Legal',
    description: '',
    instructions: 'Always cite the contract clause.',
    skills: [],
    mcpServers: ['crm'],
    nativeToolGroups: [],
    ...overrides,
  };
}

function makeResolver(
  profiles: ManagedProfile[],
  managed: string[] = ['aion_crm', 'aion_erp'],
  skillPaths: Record<string, string[]> = {}
): ManagedProfileResolver {
  return {
    listProfiles: () => profiles,
    getProfile: (slug) => profiles.find((p) => p.slug === slug) ?? null,
    getSkillPaths: (slug) => skillPaths[slug] ?? [],
    getAllowedManagedMcpNames: (slug) => {
      const p = profiles.find((x) => x.slug === slug);
      return p ? p.mcpServers.map((s) => `aion_${s}`) : null;
    },
    isManagedMcpName: (name) => managed.includes(name),
  };
}

const tools = [
  { name: 'mcp__aion_crm__a', serverName: 'aion_crm' },
  { name: 'mcp__aion_erp__b', serverName: 'aion_erp' },
  { name: 'mcp__github__c', serverName: 'github' },
];

describe('engine bridge', () => {
  afterEach(() => setManagedProfileResolver(null));

  it('is a no-op without a resolver (standalone)', () => {
    expect(getManagedProfileResolver()).toBeNull();
    expect(isKnownProfileSlug('legal')).toBe(false);
    expect(getProfilePromptSection('legal')).toBeUndefined();
    expect(getProfileSkillPaths('legal')).toEqual([]);
    expect(getProfileSignature('legal')).toBeUndefined();
    expect(filterMcpToolsForProfile(tools, 'legal')).toBe(tools);
  });

  it('prompt section only for a known profile', () => {
    setManagedProfileResolver(makeResolver([makeProfile()]));
    expect(getProfilePromptSection('legal')).toBe(
      '## AION profile: Legal\nAlways cite the contract clause.'
    );
    expect(buildProfilePromptSection(makeProfile())).toContain('## AION profile: Legal');
    expect(getProfilePromptSection(undefined)).toBeUndefined();
    expect(getProfilePromptSection('nope')).toBeUndefined();
  });

  it('adds skill paths only with a known profile', () => {
    setManagedProfileResolver(makeResolver([makeProfile()], undefined, { legal: ['/skills/x'] }));
    expect(getProfileSkillPaths('legal')).toEqual(['/skills/x']);
    expect(getProfileSkillPaths(undefined)).toEqual([]);
    expect(getProfileSkillPaths('nope')).toEqual([]);
  });

  it('MCP filter matrix', () => {
    setManagedProfileResolver(makeResolver([makeProfile()]));
    // no profile: everything available
    expect(filterMcpToolsForProfile(tools, undefined).map((t) => t.serverName)).toEqual([
      'aion_crm',
      'aion_erp',
      'github',
    ]);
    // profile with allowed subset: managed erp dropped, user server kept
    expect(filterMcpToolsForProfile(tools, 'legal').map((t) => t.serverName)).toEqual([
      'aion_crm',
      'github',
    ]);
    // unknown profile (allowed === null): untouched
    expect(filterMcpToolsForProfile(tools, 'nope')).toEqual(tools);
    // profile allowing nothing: only user servers
    setManagedProfileResolver(makeResolver([makeProfile({ mcpServers: [] })]));
    expect(filterMcpToolsForProfile(tools, 'legal').map((t) => t.serverName)).toEqual(['github']);
  });

  it('signature changes with instructions/mcp/skills and is absent without profile', () => {
    setManagedProfileResolver(makeResolver([makeProfile()]));
    const a = getProfileSignature('legal');
    expect(a).toMatch(/^legal:/);
    setManagedProfileResolver(makeResolver([makeProfile({ instructions: 'changed' })]));
    expect(getProfileSignature('legal')).not.toBe(a);
    setManagedProfileResolver(makeResolver([makeProfile({ mcpServers: ['erp'] })]));
    expect(getProfileSignature('legal')).not.toBe(a);
    setManagedProfileResolver(makeResolver([makeProfile()], undefined, { legal: ['/s'] }));
    expect(getProfileSignature('legal')).not.toBe(a);
    expect(getProfileSignature(undefined)).toBeUndefined();
  });

  it('runtime signature is identical to standalone when profile is undefined', () => {
    const base = { configProvider: 'custom', effectiveCwd: '/w', apiKey: 'k' };
    expect(buildPiSessionRuntimeSignature({ ...base, profile: undefined })).toBe(
      buildPiSessionRuntimeSignature(base)
    );
    expect(buildPiSessionRuntimeSignature({ ...base, profile: 'legal:abc' })).not.toBe(
      buildPiSessionRuntimeSignature(base)
    );
    expect(buildPiSessionRuntimeSignature({ ...base, profile: 'legal:abc' })).not.toBe(
      buildPiSessionRuntimeSignature({ ...base, profile: 'legal:def' })
    );
  });

  it('agent-runner wires the bridge into prompt, skills, MCP and signature', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/main/agent/agent-runner.ts'), 'utf8');
    expect(src).toContain('getProfilePromptSection(session.profileId)');
    expect(src).toContain('getProfileSkillPaths(session.profileId)');
    expect(src).toContain('filterMcpToolsForProfile(mcpManager.getTools(), profileId)');
    expect(src).toContain('buildMcpCustomTools(this.mcpManager, session.profileId)');
    expect(src).toContain('profile: getProfileSignature(session.profileId)');
  });
});

// better-sqlite3 is built for Electron's ABI in this repo; skip the real-DB tests when it cannot load in plain Node.
const sqliteLoads = (() => {
  try {
    const Db = createRequire(import.meta.url)('better-sqlite3');
    new Db(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!sqliteLoads)('sessions.profile_id column', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-profile-db-'));
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    }));
    vi.doMock('../src/main/utils/logger', () => ({
      log: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
  });
  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('../src/main/utils/logger');
    fs.rmSync(root, { recursive: true, force: true });
  });

  const row = (id: string, profile_id?: string | null) => ({
    id,
    title: 't',
    claude_session_id: null,
    openai_thread_id: null,
    status: 'idle',
    cwd: null,
    mounted_paths: '[]',
    allowed_tools: '[]',
    memory_enabled: 0,
    model: null,
    ...(profile_id === undefined ? {} : { profile_id }),
    created_at: 1,
    updated_at: 1,
  });

  it('stores and loads profile_id; sessions without it load as null', async () => {
    const mod = await import('../src/main/db/database');
    const db = mod.initDatabase();
    db.sessions.create(row('a', 'legal'));
    db.sessions.create(row('b'));
    expect(db.sessions.get('a')?.profile_id).toBe('legal');
    expect(db.sessions.get('b')?.profile_id ?? null).toBeNull();
    db.sessions.update('b', { profile_id: 'sales' });
    expect(db.sessions.get('b')?.profile_id).toBe('sales');
    mod.closeDatabase();
  });

  it('adds the column to a legacy table without it, idempotently', async () => {
    const mod = await import('../src/main/db/database');
    const first = mod.initDatabase();
    first.sessions.create(row('old'));
    first.raw.exec('ALTER TABLE sessions DROP COLUMN profile_id');
    mod.closeDatabase();
    const migrated = mod.initDatabase();
    expect(migrated.sessions.get('old')?.profile_id ?? null).toBeNull();
    migrated.sessions.update('old', { profile_id: 'legal' });
    expect(migrated.sessions.get('old')?.profile_id).toBe('legal');
    mod.closeDatabase();
    const again = mod.initDatabase();
    expect(again.sessions.get('old')?.profile_id).toBe('legal');
    mod.closeDatabase();
  });
});

describe('subagent MCP profile filter', () => {
  afterEach(() => setManagedProfileResolver(null));
  it('subagent-extension filters MCP tools with the parent session profile', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/main/agent/subagent-extension.ts'),
      'utf8'
    );
    expect(src).toContain('filterMcpToolsForProfile(mcpManager.getTools(), profileId)');
    expect(src).toContain('context.session.profileId');
  });
  it('the filter drops managed servers outside the profile', () => {
    setManagedProfileResolver(makeResolver([makeProfile()]));
    expect(filterMcpToolsForProfile(tools, 'legal').map((t) => t.serverName)).not.toContain('aion_erp');
  });
});
