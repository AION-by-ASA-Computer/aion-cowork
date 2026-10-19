import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
        ...mocks.seed,
      };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = {
        ...this.store,
        ...key,
      };
    }

    clear(): void {
      this.store = {};
    }
  }

  return {
    default: MockStore,
  };
});

import { ConfigStore } from '../src/main/config/config-store';
import { buildAgentRuntimeSignature } from '../src/main/config/agent-runtime-signature';
import { MANAGED_AION_SET_ID } from '../src/shared/enterprise-types';

const INPUT = { endpoint: 'https://aion.example.com/api/', token: 'tok-1', model: 'glm-5' };

function persisted(store: ConfigStore): Record<string, unknown> {
  return (store as unknown as { store: { store: Record<string, unknown> } }).store.store;
}

describe('ConfigStore managed AION set', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('creates the managed set once, activates it, and updates idempotently', () => {
    const store = new ConfigStore();
    const first = store.applyManagedAionSet(INPUT);
    const managed = first.configSets.filter((s) => s.id === MANAGED_AION_SET_ID);
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({
      name: 'AION Enterprise',
      managed: 'aion',
      provider: 'custom',
      customProtocol: 'openai',
      activeProfileKey: 'custom:openai',
    });
    expect(managed[0].profiles['custom:openai']).toMatchObject({
      apiKey: 'tok-1',
      baseUrl: 'https://aion.example.com/api/v1/llm',
      model: 'glm-5',
    });
    expect(first.activeConfigSetId).toBe(MANAGED_AION_SET_ID);
    expect(first.apiKey).toBe('tok-1');
    expect(store.hasUsableCredentialsForActiveSet()).toBe(true);

    store.applyManagedAionSet(INPUT);
    const second = store.applyManagedAionSet({ ...INPUT, token: 'tok-2', model: 'glm-6' });
    expect(second.configSets.filter((s) => s.managed)).toHaveLength(1);
    expect(second.apiKey).toBe('tok-2');
    expect(second.model).toBe('glm-6');
  });

  it('does not steal the active set after the user switched away', () => {
    const store = new ConfigStore();
    store.applyManagedAionSet(INPUT);
    store.switchSet({ id: 'default' });
    store.update({ apiKey: 'sk-user', baseUrl: 'https://api.anthropic.com' });
    const next = store.applyManagedAionSet({ ...INPUT, token: 'tok-2' });
    expect(next.activeConfigSetId).toBe('default');
    expect(next.apiKey).toBe('sk-user');
    expect(next.configSets.find((s) => s.managed)?.profiles['custom:openai']?.apiKey).toBe('tok-2');
  });

  it('is not blocked by the config set limit and survives round trips', () => {
    const store = new ConfigStore();
    for (let i = 0; i < 19; i += 1) store.createSet({ name: `S${i}`, mode: 'blank' });
    expect(() => store.applyManagedAionSet(INPUT)).not.toThrow();
    mocks.seed = structuredClone(persisted(store));
    expect(new ConfigStore().getAll().configSets.some((s) => s.managed === 'aion')).toBe(true);
  });

  it('rejects rename/delete/clone of the managed set', () => {
    const store = new ConfigStore();
    store.applyManagedAionSet(INPUT);
    expect(() => store.renameSet({ id: MANAGED_AION_SET_ID, name: 'x' })).toThrow(/Managed/);
    expect(() => store.deleteSet({ id: MANAGED_AION_SET_ID })).toThrow(/Managed/);
    expect(() =>
      store.createSet({ name: 'copy', mode: 'clone', fromSetId: MANAGED_AION_SET_ID })
    ).toThrow(/Managed/);
    const cloned = store.createSet({ name: 'copy', mode: 'clone' });
    expect(cloned.configSets.filter((s) => s.managed)).toHaveLength(1);
    expect(cloned.configSets.find((s) => s.name === 'copy')?.profiles['custom:openai']?.apiKey).not.toBe(
      'tok-1'
    );
  });

  it('update() from the renderer cannot overwrite, remove, or forge the managed set', () => {
    const store = new ConfigStore();
    store.applyManagedAionSet(INPUT);
    const snapshot = store.getAll();
    const tampered = structuredClone(snapshot.configSets).map((s) =>
      s.managed
        ? {
            ...s,
            name: 'Hacked',
            profiles: { ...s.profiles, 'custom:openai': { apiKey: '', baseUrl: 'http://evil', model: 'x' } },
          }
        : s
    );
    store.update({ configSets: tampered, apiKey: '', baseUrl: 'http://evil', model: 'x' });
    const after = store.getAll();
    const managed = after.configSets.find((s) => s.managed)!;
    expect(managed.name).toBe('AION Enterprise');
    expect(managed.profiles['custom:openai']).toMatchObject({
      apiKey: 'tok-1',
      baseUrl: 'https://aion.example.com/api/v1/llm',
      model: 'glm-5',
    });
    expect(after.apiKey).toBe('tok-1');

    // dropping it
    store.update({ configSets: snapshot.configSets.filter((s) => !s.managed) });
    expect(store.getAll().configSets.some((s) => s.managed)).toBe(true);

    // forging a managed set
    store.removeManagedAionSet();
    store.update({ configSets: snapshot.configSets });
    expect(store.getAll().configSets.some((s) => s.managed)).toBe(false);

    // switching to and from it stays allowed
    store.applyManagedAionSet(INPUT);
    store.update({ activeConfigSetId: 'default' });
    expect(store.getAll().activeConfigSetId).toBe('default');
    store.switchSet({ id: MANAGED_AION_SET_ID });
    expect(store.getAll().activeConfigSetId).toBe(MANAGED_AION_SET_ID);
  });

  it('redacts the managed token for the renderer but not for main-process readers', () => {
    const store = new ConfigStore();
    store.applyManagedAionSet(INPUT);
    expect(store.getAll().apiKey).toBe('tok-1');
    const redacted = store.getAllRedacted();
    expect(JSON.stringify(redacted)).not.toContain('tok-1');
    expect(redacted.apiKey).toBe('');
    expect(redacted.configSets.find((s) => s.managed)?.profiles['custom:openai']?.model).toBe('glm-5');
    // redaction must not mutate stored data
    expect(store.getAll().apiKey).toBe('tok-1');
  });

  it('excludes managed fields from export and ignores them on import', async () => {
    const store = new ConfigStore();
    store.applyManagedAionSet(INPUT);
    const fsMod = await import('fs');
    const file = store.getPublicConfigPath();
    store.exportSafeConfig();
    const exported = fsMod.readFileSync(file, 'utf-8');
    expect(exported).not.toContain('tok-1');
    expect(exported).not.toContain('glm-5');
    expect(exported).not.toContain('aion-enterprise');

    fsMod.writeFileSync(
      file,
      JSON.stringify({
        model: 'evil',
        provider: 'openai',
        apiKey: 'evil',
        configSets: [{ id: MANAGED_AION_SET_ID, name: 'x' }],
        theme: 'dark',
      })
    );
    expect(store.importSafeConfig()).toBe(true);
    const after = store.getAll();
    expect(after.theme).toBe('dark');
    expect(after.model).toBe('glm-5');
    expect(after.apiKey).toBe('tok-1');
    expect(after.configSets.find((s) => s.managed)?.name).toBe('AION Enterprise');
  });

  it('removeManagedAionSet falls back to the system set', () => {
    const store = new ConfigStore();
    store.applyManagedAionSet(INPUT);
    const after = store.removeManagedAionSet();
    expect(after.configSets.some((s) => s.managed)).toBe(false);
    expect(after.activeConfigSetId).toBe('default');
    expect(persisted(store)).toBeTruthy();
    expect(() => store.removeManagedAionSet()).not.toThrow();
  });

  it('runtime signature ignores token rotation for the managed set only', () => {
    const store = new ConfigStore();
    const a = buildAgentRuntimeSignature(store.applyManagedAionSet(INPUT));
    const b = buildAgentRuntimeSignature(store.applyManagedAionSet({ ...INPUT, token: 'tok-2' }));
    expect(a).toBe(b);
    const c = buildAgentRuntimeSignature(store.applyManagedAionSet({ ...INPUT, model: 'other' }));
    expect(c).not.toBe(b);
  });
});
