/**
 * Phase 2: server-managed profiles, MCP servers and skills synced from AION Agent.
 * HTTP contract: docs/enterprise-api-contract.md ("GET /v1/client/bootstrap").
 */

export interface ManagedProfile {
  /** Profile slug (file stem on the server). */
  slug: string;
  name: string;
  description: string;
  /** Full system instructions (placeholders such as {{current_date}} already rendered by the server or left as-is). */
  instructions: string;
  maxAgentSteps?: number;
  /** Skill names (wildcards already expanded by the server). */
  skills: string[];
  /** MCP server slugs this profile uses (ManagedMcpServer.slug). */
  mcpServers: string[];
  nativeToolGroups: string[];
  updatedAt?: string;
}

export interface ManagedSkill {
  name: string;
  description: string;
  tags: string[];
  version: number;
  status?: string;
  /** Full SKILL.md content including frontmatter. */
  content: string;
  updatedAt?: string;
}

export type ManagedMcpExecution = 'client_remote' | 'client_local' | 'server_only';

export interface ManagedMcpTransport {
  type: 'sse' | 'streamable-http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  /** Non-secret environment entries only. */
  env?: Record<string, string>;
}

export interface ManagedMcpServer {
  slug: string;
  displayName: string;
  description?: string;
  category?: string;
  /** client_* servers run/connect from Cowork; server_only servers exist only inside AION and are never started locally. */
  execution: ManagedMcpExecution;
  transport?: ManagedMcpTransport;
  /** 'aion_token': Cowork sends the user's AION access token as Authorization: Bearer to the url. */
  auth: 'none' | 'aion_token';
}

export interface EnterpriseSyncStatus {
  state: 'idle' | 'syncing' | 'error';
  lastSyncAt?: string;
  revision?: string;
  error?: { code: string; message: string };
  counts: { profiles: number; skills: number; mcpServers: number };
  /** User opted in to managed MCP servers that run local commands (client_local). */
  allowLocalMcp: boolean;
  /** Number of client_local servers offered by the server (whether or not allowed). */
  localMcpCount: number;
  /** Server does not offer /v1/client/bootstrap (older version). */
  unsupported?: boolean;
}

/** Shape of GET /v1/client/bootstrap after mapping from the snake_case wire format. */
export interface ClientBootstrap {
  revision: string;
  profiles: ManagedProfile[];
  skills: ManagedSkill[];
  mcpServers: ManagedMcpServer[];
  policy: { syncIntervalSec: number };
}

/** Name used for a managed MCP server inside Cowork's MCP config / tool names (mcp__<name>__tool). */
export function managedMcpName(slug: string): string {
  return `aion_${slug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export const MANAGED_MCP_ID_PREFIX = 'aion-managed-';

/**
 * Read-only view of the synced data used by the agent engine (session-manager / agent-runner).
 * Implemented by the enterprise module; the engine must treat a missing provider or an unknown
 * profile as "no profile" (standalone behaviour unchanged).
 */
export interface ManagedProfileResolver {
  listProfiles(): ManagedProfile[];
  getProfile(slug: string): ManagedProfile | null;
  /** Absolute skill directories to add for a profile (already written to disk by the sync). */
  getSkillPaths(slug: string): string[];
  /** Cowork MCP server names (managedMcpName) a profile may use; null = profile unknown. */
  getAllowedManagedMcpNames(slug: string): string[] | null;
  /** True when the Cowork MCP server name belongs to the managed set (filtered by profile). */
  isManagedMcpName(name: string): boolean;
}
