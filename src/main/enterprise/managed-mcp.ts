/**
 * Applies the server-managed MCP list to Cowork's MCP config store.
 *
 * - Only client_* servers are created (server_only servers never exist locally).
 * - client_local servers (server-supplied stdio command) are created only when the user opted in
 *   (allowLocalMcp); turning it off removes them on the next apply.
 * - Entries are id `aion-managed-<slug>`, name `aion_<slug>`, `managed: true` (read-only for the user).
 * - The AION token is NEVER persisted in the MCP store: for auth 'aion_token' it is injected at
 *   connect time through the header provider consumed by mcp-manager.
 */
import {
  MANAGED_MCP_ID_PREFIX,
  managedMcpName,
  type ManagedMcpServer,
} from '../../shared/enterprise-sync-types';
import type { MCPServerConfig } from '../mcp/mcp-manager';

export interface ManagedMcpStorePort {
  getManagedServers(): MCPServerConfig[];
  saveManagedServer(config: MCPServerConfig): void;
  deleteManagedServer(serverId: string): void;
}

/** Hooks into the live MCP runtime (mcp-manager + session cache); all optional. */
export interface ManagedMcpRuntimePort {
  updateServer?(config: MCPServerConfig): Promise<void>;
  removeServer?(serverId: string): Promise<void>;
  invalidateCache?(): void;
}

export function managedMcpId(slug: string): string {
  return `${MANAGED_MCP_ID_PREFIX}${slug}`;
}

/** Maps a managed server to a Cowork config, or null for servers that must not run locally. */
export function toMcpConfig(server: ManagedMcpServer): MCPServerConfig | null {
  if (server.execution === 'server_only' || !server.transport) return null;
  const t = server.transport;
  const base = { id: managedMcpId(server.slug), name: managedMcpName(server.slug), enabled: true, managed: true };
  if (t.type === 'stdio') {
    if (!t.command) return null;
    return {
      ...base,
      type: 'stdio',
      command: t.command,
      ...(t.args?.length ? { args: [...t.args] } : {}),
      ...(t.env && Object.keys(t.env).length ? { env: { ...t.env } } : {}),
    };
  }
  if (!t.url) return null;
  return { ...base, type: t.type, url: t.url };
}

function sameConfig(a: MCPServerConfig, b: MCPServerConfig): boolean {
  const pick = (c: MCPServerConfig) =>
    JSON.stringify([c.id, c.name, c.type, c.command ?? '', c.args ?? [], sortObj(c.env), c.url ?? '', sortObj(c.headers), c.enabled, c.managed === true]);
  return pick(a) === pick(b);
}

function sortObj(o?: Record<string, string>): Array<[string, string]> {
  return Object.entries(o ?? {}).sort(([x], [y]) => x.localeCompare(y));
}

export interface ApplyMcpResult {
  added: string[];
  updated: string[];
  removed: string[];
}

export class ManagedMcpApplier {
  /** config id -> auth mode of the last applied set. */
  private authById = new Map<string, 'none' | 'aion_token'>();

  constructor(
    private readonly store: ManagedMcpStorePort,
    private readonly getToken: () => string,
    private readonly runtime: ManagedMcpRuntimePort = {},
    private readonly log: (...args: unknown[]) => void = () => {},
    initial: ManagedMcpServer[] = [],
    /** client_local servers run a server-supplied command on this machine: only when the user opted in. */
    private readonly getAllowLocal: () => boolean = () => false
  ) {
    this.rememberAuth(initial);
  }

  private rememberAuth(servers: ManagedMcpServer[]): void {
    this.authById.clear();
    for (const s of servers) {
      if (s.execution !== 'server_only') this.authById.set(managedMcpId(s.slug), s.auth);
    }
  }

  /** Header provider for mcp-manager (setManagedHeaderProvider). */
  headerProvider = (config: MCPServerConfig): Record<string, string> | undefined => {
    if (!config.managed || this.authById.get(config.id) !== 'aion_token') return undefined;
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  };

  async apply(servers: ManagedMcpServer[]): Promise<ApplyMcpResult> {
    const result: ApplyMcpResult = { added: [], updated: [], removed: [] };
    const desired = new Map<string, MCPServerConfig>();
    const allowLocal = this.getAllowLocal() === true;
    for (const s of servers) {
      if (s.execution === 'client_local' && !allowLocal) continue;
      const cfg = toMcpConfig(s);
      if (cfg) desired.set(cfg.id, cfg);
    }
    this.rememberAuth(servers.filter((s) => desired.has(managedMcpId(s.slug))));

    const existing = new Map(this.store.getManagedServers().map((s) => [s.id, s]));
    for (const [id] of existing) {
      if (desired.has(id)) continue;
      this.store.deleteManagedServer(id);
      result.removed.push(id);
      await this.safe(() => this.runtime.removeServer?.(existing.get(id)!.id));
    }
    for (const [id, cfg] of desired) {
      const prev = existing.get(id);
      if (prev && sameConfig(prev, cfg)) continue;
      this.store.saveManagedServer(cfg);
      (prev ? result.updated : result.added).push(id);
      await this.safe(() => this.runtime.updateServer?.(cfg));
    }
    if (result.added.length || result.updated.length || result.removed.length) {
      this.safeSync(() => this.runtime.invalidateCache?.());
    }
    return result;
  }

  /** The AION token changed: reconnect the servers that use it so they pick up the new header. */
  async onTokenChanged(): Promise<void> {
    let any = false;
    for (const cfg of this.store.getManagedServers()) {
      if (this.authById.get(cfg.id) !== 'aion_token' || !cfg.enabled) continue;
      any = true;
      await this.safe(() => this.runtime.updateServer?.(cfg));
    }
    if (any) this.safeSync(() => this.runtime.invalidateCache?.());
  }

  /** Removes every managed entry (logout/disconnect). */
  async clear(): Promise<void> {
    const ids = this.store.getManagedServers().map((s) => s.id);
    for (const id of ids) {
      this.store.deleteManagedServer(id);
      await this.safe(() => this.runtime.removeServer?.(id));
    }
    this.authById.clear();
    if (ids.length) this.safeSync(() => this.runtime.invalidateCache?.());
  }

  private async safe(fn: () => Promise<void> | undefined): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log('[ManagedMcp] runtime update failed:', err instanceof Error ? err.message : String(err));
    }
  }
  private safeSync(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log('[ManagedMcp] runtime hook failed:', err instanceof Error ? err.message : String(err));
    }
  }
}
