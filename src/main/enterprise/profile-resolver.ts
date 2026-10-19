/**
 * Read-only view of the synced profiles for the agent engine. Deliberately free of electron
 * imports so the engine can import it anywhere.
 */
import {
  managedMcpName,
  type ManagedProfileResolver,
  type ManagedMcpServer,
  type ManagedProfile,
} from '../../shared/enterprise-sync-types';
import { setManagedProfileResolver as setEngineProfileResolver } from './engine-bridge';

export interface ResolverSource {
  getProfiles(): ManagedProfile[];
  getMcpServers(): ManagedMcpServer[];
  getSkillPaths(slug: string): string[];
}

export function createManagedProfileResolver(src: ResolverSource): ManagedProfileResolver {
  const clientServers = () => src.getMcpServers().filter((s) => s.execution !== 'server_only');
  return {
    listProfiles: () => src.getProfiles(),
    getProfile: (slug) => src.getProfiles().find((p) => p.slug === slug) ?? null,
    getSkillPaths: (slug) => (src.getProfiles().some((p) => p.slug === slug) ? src.getSkillPaths(slug) : []),
    getAllowedManagedMcpNames: (slug) => {
      const profile = src.getProfiles().find((p) => p.slug === slug);
      if (!profile) return null;
      const wanted = new Set(profile.mcpServers);
      return clientServers()
        .filter((s) => wanted.has(s.slug))
        .map((s) => managedMcpName(s.slug));
    },
    isManagedMcpName: (name) => clientServers().some((s) => managedMcpName(s.slug) === name),
  };
}

let current: ManagedProfileResolver | null = null;

export function setManagedProfileResolver(resolver: ManagedProfileResolver | null): void {
  current = resolver;
  // The engine reads the resolver through engine-bridge (its own registry): keep them in sync.
  setEngineProfileResolver(resolver);
}

/** Returns the resolver once enterprise IPC is registered; null before (standalone behaviour). */
export function getManagedProfileResolver(): ManagedProfileResolver | null {
  return current;
}
