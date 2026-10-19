/**
 * Encrypted persistence for Enterprise (AION Agent) mode.
 * The access token is only readable through getAccessToken() inside the main process;
 * it is never part of anything returned to the renderer.
 */
import Store from 'electron-store';
import { log, logWarn } from '../utils/logger';
import { createEncryptedStoreWithKeyRotation } from '../utils/store-encryption';
import type { EnterpriseUser } from '../../shared/enterprise-types';

export interface EnterpriseStoreData extends Record<string, unknown> {
  endpoint: string;
  accessToken: string;
  expiresAt: string;
  user: EnterpriseUser | null;
  mustChangePassword: boolean;
  selectedModel: string;
  serverVersion: string;
  onboardingDone: boolean;
  sessionExpired: boolean;
  /** Opt-in: allow server-managed MCP servers that run a local stdio command (client_local). */
  allowLocalMcp: boolean;
}

export const DEFAULT_ENTERPRISE_DATA: EnterpriseStoreData = {
  endpoint: '',
  accessToken: '',
  expiresAt: '',
  user: null,
  mustChangePassword: false,
  selectedModel: '',
  serverVersion: '',
  onboardingDone: false,
  sessionExpired: false,
  allowLocalMcp: false,
};

/** Redacted view, safe to log or hand to the renderer. */
export type EnterpriseStoreSnapshot = Omit<EnterpriseStoreData, 'accessToken'> & {
  hasToken: boolean;
};

export class EnterpriseStore {
  private store: Store<EnterpriseStoreData>;

  constructor() {
    this.store = createEncryptedStoreWithKeyRotation<EnterpriseStoreData>({
      stableKey: 'open-cowork-enterprise-stable-v1',
      legacyKeys: [],
      storeOptions: {
        name: 'enterprise-config',
        projectName: 'open-cowork',
        defaults: { ...DEFAULT_ENTERPRISE_DATA },
      },
      logPrefix: '[EnterpriseStore]',
      log,
      warn: logWarn,
    });
  }

  get<K extends keyof EnterpriseStoreData>(key: K): EnterpriseStoreData[K] {
    const value = this.store.get(key);
    return (value === undefined ? DEFAULT_ENTERPRISE_DATA[key] : value) as EnterpriseStoreData[K];
  }

  set(patch: Partial<EnterpriseStoreData>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      this.store.set(key, value);
    }
  }

  getAccessToken(): string {
    return this.get('accessToken');
  }

  hasToken(): boolean {
    return Boolean(this.get('accessToken'));
  }

  /** Drops the session (token, user, expiry) but keeps endpoint and preferences. */
  clearSession(): void {
    this.set({
      accessToken: '',
      expiresAt: '',
      user: null,
      mustChangePassword: false,
      sessionExpired: false,
    });
  }

  /** Forgets everything about the enterprise connection except the onboarding choice. */
  clearConnection(): void {
    this.clearSession();
    this.set({ endpoint: '', selectedModel: '', serverVersion: '', allowLocalMcp: false });
  }

  snapshot(): EnterpriseStoreSnapshot {
    const { accessToken, ...rest } = {
      ...DEFAULT_ENTERPRISE_DATA,
      ...(this.store.store as Partial<EnterpriseStoreData>),
    };
    return { ...rest, hasToken: Boolean(accessToken) };
  }
}
