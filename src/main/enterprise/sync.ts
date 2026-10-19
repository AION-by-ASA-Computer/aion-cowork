/**
 * Phase 2 sync: pulls GET /v1/client/bootstrap and applies it idempotently
 * (managed store + skills on disk + managed MCP entries).
 */
import type {
  ClientBootstrap,
  EnterpriseSyncStatus,
  ManagedProfile,
} from '../../shared/enterprise-sync-types';
import * as auth from './auth';
import type { ManagedSkillMeta, ManagedStorePort } from './managed-store';
import type { ApplyMcpResult } from './managed-mcp';
import type { ManagedMcpServer, ManagedSkill } from '../../shared/enterprise-sync-types';

export interface SyncSkillsPort {
  apply(skills: ManagedSkill[], profiles: ManagedProfile[]): ManagedSkillMeta[];
  clear(): void;
}
export interface SyncMcpPort {
  apply(servers: ManagedMcpServer[]): Promise<ApplyMcpResult>;
  clear(): Promise<void>;
}

export interface SyncServiceDeps {
  getEndpoint(): string;
  getToken(): string;
  managed: ManagedStorePort;
  skills: SyncSkillsPort;
  mcp: SyncMcpPort;
  /** A 401 arrived: the session is no longer valid. */
  onSessionExpired(): void;
  /** Sync status changed (push to renderer). */
  onChange(): void;
  /** Opt-in flag for client_local MCP servers (default off when not provided). */
  getAllowLocalMcp?(): boolean;
  log?: (...args: unknown[]) => void;
  /** Test hooks. */
  fetchBootstrap?: typeof auth.fetchBootstrap;
  random?: () => number;
}

export class SyncService {
  private state: EnterpriseSyncStatus['state'] = 'idle';
  private error: { code: string; message: string } | undefined;
  private inflight: Promise<EnterpriseSyncStatus> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Bumped by clear()/stop() so a sync in flight discards its result. */
  private generation = 0;

  constructor(private readonly deps: SyncServiceDeps) {}

  private log(...args: unknown[]) {
    this.deps.log?.('[EnterpriseSync]', ...args);
  }

  getStatus(): EnterpriseSyncStatus {
    const m = this.deps.managed;
    const status: EnterpriseSyncStatus = {
      state: this.state,
      counts: {
        profiles: m.get('profiles').length,
        skills: m.get('skills').length,
        mcpServers: m.get('mcpServers').filter((s) => s.execution !== 'server_only').length,
      },
      allowLocalMcp: this.deps.getAllowLocalMcp?.() === true,
      localMcpCount: m.get('mcpServers').filter((s) => s.execution === 'client_local').length,
    };
    if (m.get('lastSyncAt')) status.lastSyncAt = m.get('lastSyncAt');
    if (m.get('revision')) status.revision = m.get('revision');
    if (this.error) status.error = this.error;
    if (m.get('unsupported')) status.unsupported = true;
    return status;
  }

  /** Re-applies the last stored MCP list (e.g. after the local-MCP opt-in changed). */
  async reapplyMcp(): Promise<void> {
    await this.deps.mcp.apply(this.deps.managed.get('mcpServers'));
    this.changed();
  }

  listProfiles(): ManagedProfile[] {
    return this.deps.managed.get('profiles');
  }

  private changed() {
    try {
      this.deps.onChange();
    } catch (err) {
      this.log('onChange failed', err);
    }
  }

  syncNow(): Promise<EnterpriseSyncStatus> {
    if (!this.inflight) {
      this.inflight = this.doSync().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doSync(): Promise<EnterpriseSyncStatus> {
    const endpoint = this.deps.getEndpoint();
    const token = this.deps.getToken();
    if (!endpoint || !token) return this.getStatus();
    const gen = this.generation;
    this.state = 'syncing';
    this.changed();
    const fetchFn = this.deps.fetchBootstrap ?? auth.fetchBootstrap;
    const m = this.deps.managed;
    try {
      const res = await fetchFn(endpoint, token, m.get('etag') || undefined);
      if (gen !== this.generation) return this.getStatus();
      if (res.status === 'ok') {
        await this.applyBootstrap(res.data, res.etag, gen);
        if (gen !== this.generation) return this.getStatus();
      } else {
        m.set({ lastSyncAt: new Date().toISOString(), unsupported: false });
      }
      this.state = 'idle';
      this.error = undefined;
    } catch (err) {
      if (gen !== this.generation) return this.getStatus();
      const e = auth.toEnterpriseError(err);
      if (e.code === 'bootstrap_unsupported') {
        m.set({ unsupported: true });
        this.state = 'idle';
        this.error = undefined;
      } else {
        this.state = 'error';
        this.error = { code: e.code, message: e.message };
        this.log('sync failed:', e.code);
        if (err instanceof auth.EnterpriseHttpError && err.status === 401) {
          this.stop();
          this.deps.onSessionExpired();
        }
      }
    }
    this.changed();
    return this.getStatus();
  }

  private async applyBootstrap(data: ClientBootstrap, etag: string, gen: number): Promise<void> {
    const m = this.deps.managed;
    const metas = this.deps.skills.apply(data.skills, data.profiles);
    await this.deps.mcp.apply(data.mcpServers);
    if (gen !== this.generation) return;
    // Persisted last: if anything above throws, the etag is not stored and the next sync retries.
    m.set({
      profiles: data.profiles,
      skills: metas,
      mcpServers: data.mcpServers,
      revision: data.revision,
      etag,
      lastSyncAt: new Date().toISOString(),
      syncIntervalSec: data.policy.syncIntervalSec,
      unsupported: false,
    });
  }

  // ---- scheduler ----------------------------------------------------------------

  /** Starts syncing now and then every policy.syncIntervalSec (min 60 s, jittered). */
  start(): void {
    if (this.running) {
      void this.syncNow();
      return;
    }
    this.running = true;
    void this.syncNow().finally(() => this.scheduleNext());
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const intervalSec = Math.max(
      auth.MIN_SYNC_INTERVAL_SEC,
      this.deps.managed.get('syncIntervalSec') || auth.DEFAULT_SYNC_INTERVAL_SEC
    );
    const jitter = 0.9 + (this.deps.random ?? Math.random)() * 0.2; // +-10%
    const delay = Math.min(Math.round(intervalSec * 1000 * jitter), auth.MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      void this.syncNow().finally(() => this.scheduleNext());
    }, delay);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  /** Removes all managed data (profiles, MCP entries, skills on disk) and stops syncing. */
  async clear(): Promise<void> {
    this.stop();
    this.generation += 1;
    this.state = 'idle';
    this.error = undefined;
    try {
      await this.deps.mcp.clear();
    } catch (err) {
      this.log('mcp clear failed', err);
    }
    try {
      this.deps.skills.clear();
    } catch (err) {
      this.log('skills clear failed', err);
    }
    this.deps.managed.clear();
    this.changed();
  }
}
