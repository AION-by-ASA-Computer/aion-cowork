import type { EnterpriseSyncStatus, ManagedProfile } from '../../shared/enterprise-sync-types';

const STORAGE_PREFIX = 'aion.enterprise.profile:';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function profileStorageKey(endpoint: string | undefined): string {
  return `${STORAGE_PREFIX}${(endpoint ?? '').replace(/\/+$/, '')}`;
}

/** Reads the stored slug; never throws (storage may be blocked or missing). */
export function readStoredProfile(
  storage: StorageLike | null | undefined,
  endpoint: string | undefined
): string | null {
  try {
    const v = storage?.getItem(profileStorageKey(endpoint));
    return v ? v : null;
  } catch {
    return null;
  }
}

/** Persists (or clears, with null) the selection; never throws. */
export function writeStoredProfile(
  storage: StorageLike | null | undefined,
  endpoint: string | undefined,
  slug: string | null
): void {
  try {
    if (!storage) return;
    const key = profileStorageKey(endpoint);
    if (slug) storage.setItem(key, slug);
    else storage.removeItem(key);
  } catch {
    // ignore: selection simply will not persist
  }
}

/** Keeps a slug only if the profile still exists. */
export function validateProfileSelection(
  slug: string | null | undefined,
  profiles: ManagedProfile[]
): string | null {
  if (!slug) return null;
  return profiles.some((p) => p.slug === slug) ? slug : null;
}

export function getProfileLabel(slug: string, profiles: ManagedProfile[]): string {
  return profiles.find((p) => p.slug === slug)?.name || slug;
}

export type SyncViewState = 'idle' | 'syncing' | 'error' | 'unsupported' | 'never';

export interface SyncViewModel {
  state: SyncViewState;
  lastSyncAt?: string;
  counts: { profiles: number; skills: number; mcpServers: number };
  errorCode?: string;
  errorMessage?: string;
  canSync: boolean;
}

export function getSyncViewModel(sync: EnterpriseSyncStatus | undefined): SyncViewModel {
  const counts = sync?.counts ?? { profiles: 0, skills: 0, mcpServers: 0 };
  if (!sync) return { state: 'never', counts, canSync: true };
  let state: SyncViewState;
  if (sync.unsupported) state = 'unsupported';
  else if (sync.state === 'syncing') state = 'syncing';
  else if (sync.state === 'error') state = 'error';
  else state = sync.lastSyncAt ? 'idle' : 'never';
  return {
    state,
    lastSyncAt: sync.lastSyncAt,
    counts,
    errorCode: sync.error?.code,
    errorMessage: sync.error?.message,
    canSync: sync.state !== 'syncing',
  };
}

/** i18n key for well-known sync error codes; undefined means "show the raw message". */
export function getSyncErrorKey(code: string | undefined): string | undefined {
  switch (code) {
    case 'unreachable':
    case 'network_error':
    case 'timeout':
      return 'enterprise.sync.errors.unreachable';
    case 'unauthorized':
    case 'session_expired':
      return 'enterprise.sync.errors.unauthorized';
    case 'invalid_response':
    case 'invalid_bootstrap':
      return 'enterprise.sync.errors.invalidResponse';
    case 'write_failed':
    case 'storage_error':
      return 'enterprise.sync.errors.writeFailed';
    default:
      return undefined;
  }
}

/** Relative time ("3 minuti fa"); null for missing/invalid input. */
export function formatRelativeTime(
  iso: string | undefined,
  now: number = Date.now(),
  locale?: string
): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  const diffSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  return rtf.format(Math.round(diffSec / 86400), 'day');
}
