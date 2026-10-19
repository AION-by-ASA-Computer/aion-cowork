import type { EnterpriseAPI } from '../../shared/enterprise-types';

/**
 * Typed accessor for window.electronAPI.enterprise. Works even when the global
 * electronAPI typing has not been extended yet (preload wiring is separate).
 */
export function getEnterpriseApi(): EnterpriseAPI | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: { enterprise?: EnterpriseAPI } }).electronAPI;
  return api?.enterprise ?? null;
}
