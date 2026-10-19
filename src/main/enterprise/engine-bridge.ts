/**
 * Bridge between the agent engine (session-manager / agent-runner) and the enterprise sync module.
 * The engine imports ONLY this file; the enterprise module registers its resolver at startup via
 * setManagedProfileResolver(). With no resolver registered every helper is a no-op, so standalone
 * behaviour is unchanged.
 */
import { createHash } from 'node:crypto';
import type { ManagedProfile, ManagedProfileResolver } from '../../shared/enterprise-sync-types';

let resolver: ManagedProfileResolver | null = null;

export function setManagedProfileResolver(next: ManagedProfileResolver | null): void {
  resolver = next;
}

export function getManagedProfileResolver(): ManagedProfileResolver | null {
  return resolver;
}

/** Profile for a slug, or null when there is no slug / no resolver / unknown slug. Never throws. */
export function getProfileForSlug(slug: string | null | undefined): ManagedProfile | null {
  if (!slug || !resolver) return null;
  try {
    return resolver.getProfile(slug);
  } catch {
    return null;
  }
}

/** True when the slug is known by the registered resolver. */
export function isKnownProfileSlug(slug: string | null | undefined): boolean {
  return getProfileForSlug(slug) !== null;
}

export function buildProfilePromptSection(profile: ManagedProfile): string {
  const body = (profile.instructions || '').trim();
  return `## AION profile: ${profile.name}\n${body}`.trim();
}

/** Profile prompt section for a session's profile slug, or undefined (no profile / unknown). */
export function getProfilePromptSection(slug: string | null | undefined): string | undefined {
  const profile = getProfileForSlug(slug);
  return profile ? buildProfilePromptSection(profile) : undefined;
}

/** Extra skill directories for a profile (empty without a known profile). */
export function getProfileSkillPaths(slug: string | null | undefined): string[] {
  if (!slug || !resolver || !getProfileForSlug(slug)) return [];
  try {
    return resolver.getSkillPaths(slug) ?? [];
  } catch {
    return [];
  }
}

/**
 * Keep every tool except those of managed MCP servers that the profile does not allow.
 * No profile / unknown profile / no resolver: tools unchanged (all connected managed servers available).
 * Tools from user-configured servers are always kept.
 */
export function filterMcpToolsForProfile<T extends { serverName: string }>(
  tools: T[],
  slug: string | null | undefined
): T[] {
  if (!slug || !resolver) return tools;
  let allowed: string[] | null;
  try {
    allowed = resolver.getAllowedManagedMcpNames(slug);
  } catch {
    return tools;
  }
  if (allowed === null) return tools;
  const allowedSet = new Set(allowed);
  return tools.filter(
    (tool) => !resolver!.isManagedMcpName(tool.serverName) || allowedSet.has(tool.serverName)
  );
}

/**
 * Stable fingerprint of everything a profile contributes to a cached pi session (prompt, skills, MCP set).
 * undefined when the session has no known profile, so the runtime signature stays identical to standalone.
 */
export function getProfileSignature(slug: string | null | undefined): string | undefined {
  const profile = getProfileForSlug(slug);
  if (!profile || !resolver) return undefined;
  let allowed: string[] | null = null;
  let skills: string[] = [];
  try {
    allowed = resolver.getAllowedManagedMcpNames(profile.slug);
    skills = resolver.getSkillPaths(profile.slug) ?? [];
  } catch {
    // fall through with defaults
  }
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        name: profile.name,
        instructions: profile.instructions || '',
        mcp: allowed ? [...allowed].sort() : null,
        skills: [...skills].sort(),
      })
    )
    .digest('hex')
    .slice(0, 16);
  return `${profile.slug}:${hash}`;
}
