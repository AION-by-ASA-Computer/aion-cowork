/**
 * Encrypted persistence of the last synced bootstrap (profiles, skill metadata, MCP servers).
 * Skill contents live on disk (managed-skills.ts); the access token is never stored here.
 */
import Store from 'electron-store';
import { log, logWarn } from '../utils/logger';
import { createEncryptedStoreWithKeyRotation } from '../utils/store-encryption';
import type {
  ManagedMcpServer,
  ManagedProfile,
} from '../../shared/enterprise-sync-types';

export interface ManagedSkillMeta {
  name: string;
  description: string;
  tags: string[];
  version: number;
  /** sha256 of the SKILL.md content written to disk. */
  contentHash: string;
}

export interface ManagedStoreData extends Record<string, unknown> {
  profiles: ManagedProfile[];
  skills: ManagedSkillMeta[];
  mcpServers: ManagedMcpServer[];
  revision: string;
  etag: string;
  lastSyncAt: string;
  syncIntervalSec: number;
  unsupported: boolean;
}

export const DEFAULT_MANAGED_DATA: ManagedStoreData = {
  profiles: [],
  skills: [],
  mcpServers: [],
  revision: '',
  etag: '',
  lastSyncAt: '',
  syncIntervalSec: 900,
  unsupported: false,
};

/** Port used by sync/resolver (injectable in tests). */
export interface ManagedStorePort {
  get<K extends keyof ManagedStoreData>(key: K): ManagedStoreData[K];
  set(patch: Partial<ManagedStoreData>): void;
  clear(): void;
}

export class ManagedStore implements ManagedStorePort {
  private store: Store<ManagedStoreData>;

  constructor() {
    this.store = createEncryptedStoreWithKeyRotation<ManagedStoreData>({
      stableKey: 'open-cowork-enterprise-managed-stable-v1',
      legacyKeys: [],
      storeOptions: {
        name: 'enterprise-managed',
        projectName: 'open-cowork',
        defaults: { ...DEFAULT_MANAGED_DATA },
      },
      logPrefix: '[ManagedStore]',
      log,
      warn: logWarn,
    });
  }

  get<K extends keyof ManagedStoreData>(key: K): ManagedStoreData[K] {
    const value = this.store.get(key);
    return (value === undefined ? DEFAULT_MANAGED_DATA[key] : value) as ManagedStoreData[K];
  }

  set(patch: Partial<ManagedStoreData>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      this.store.set(key, value);
    }
  }

  clear(): void {
    this.set({ ...DEFAULT_MANAGED_DATA });
  }
}
