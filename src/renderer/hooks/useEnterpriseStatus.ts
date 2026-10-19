import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { EnterpriseStatus } from '../../shared/enterprise-types';
import { getEnterpriseApi } from '../utils/enterprise-api';

// Module-level shared state so App and the Account tab always see the same status.
let current: EnterpriseStatus | null = null;
const listeners = new Set<() => void>();
let subscribers = 0;
let unsubscribeEvents: (() => void) | null = null;

function emit(next: EnterpriseStatus) {
  current = next;
  listeners.forEach((l) => l());
}

export function setEnterpriseStatus(next: EnterpriseStatus) {
  emit(next);
}

async function fetchStatus() {
  const api = getEnterpriseApi();
  if (!api) return;
  try {
    emit(await api.getStatus());
  } catch (err) {
    console.error('[enterprise] getStatus failed', err);
  }
}

function start() {
  void fetchStatus();
  // Dedicated channel: electronAPI.on only supports a single listener (owned by useIPC).
  const api = getEnterpriseApi();
  if (typeof api?.onStatus === 'function') {
    unsubscribeEvents = api.onStatus(emit);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  subscribers += 1;
  if (subscribers === 1) start();
  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0) {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
    }
  };
}

export function useEnterpriseStatus() {
  const status = useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
  const reload = useCallback(() => fetchStatus(), []);
  useEffect(() => {
    // Re-sync on mount in case an event was missed between hook instances.
    if (subscribers > 1) void fetchStatus();
  }, []);
  return { status, setStatus: setEnterpriseStatus, reload };
}
