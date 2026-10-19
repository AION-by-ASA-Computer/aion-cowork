import { useCallback, useEffect, useState } from 'react';
import type { ManagedProfile } from '../../shared/enterprise-sync-types';
import { getEnterpriseApi } from '../utils/enterprise-api';
import {
  readStoredProfile,
  validateProfileSelection,
  writeStoredProfile,
} from '../utils/enterprise-profiles';
import { useEnterpriseStatus } from './useEnterpriseStatus';

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Server-managed profiles (enterprise mode). Empty and inert in standalone mode. */
export function useManagedProfiles() {
  const { status } = useEnterpriseStatus();
  const [profiles, setProfiles] = useState<ManagedProfile[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const active = status?.mode === 'enterprise' && status.loggedIn === true;
  const endpoint = status?.endpoint;
  const syncKey = `${status?.sync?.lastSyncAt ?? ''}|${status?.sync?.revision ?? ''}`;

  useEffect(() => {
    const api = getEnterpriseApi();
    if (!active || !api || typeof api.listProfiles !== 'function') {
      setProfiles([]);
      return;
    }
    let cancelled = false;
    api
      .listProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        console.error('[enterprise] listProfiles failed', err);
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, endpoint, syncKey]);

  // Restore the stored choice and drop slugs that no longer exist.
  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedSlug(null);
      return;
    }
    setSelectedSlug((prev) => {
      const candidate = prev ?? readStoredProfile(getStorage(), endpoint);
      const valid = validateProfileSelection(candidate, profiles);
      if (candidate && !valid) writeStoredProfile(getStorage(), endpoint, null);
      return valid;
    });
  }, [profiles, endpoint]);

  const select = useCallback(
    (slug: string | null) => {
      const valid = validateProfileSelection(slug, profiles);
      setSelectedSlug(valid);
      writeStoredProfile(getStorage(), endpoint, valid);
    },
    [profiles, endpoint]
  );

  return { profiles, selectedSlug, select };
}
