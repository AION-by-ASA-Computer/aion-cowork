/**
 * IPC handlers for Enterprise mode. One handler per channel in ENTERPRISE_CHANNELS.
 */
import { app, ipcMain } from 'electron';
import * as path from 'path';
import { ENTERPRISE_CHANNELS, type EnterpriseStatus } from '../../shared/enterprise-types';
import { EnterpriseService, type EnterpriseConfigPort } from './enterprise-service';
import { EnterpriseStore } from './enterprise-store';
import { ManagedStore } from './managed-store';
import { ManagedSkillsWriter } from './managed-skills';
import { ManagedMcpApplier, type ManagedMcpRuntimePort } from './managed-mcp';
import { SyncService } from './sync';
import { createManagedProfileResolver, setManagedProfileResolver } from './profile-resolver';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import { setManagedHeaderProvider } from '../mcp/mcp-manager';

export interface EnterpriseIpcDeps {
  config: EnterpriseConfigPort;
  syncConfigAfterMutation: (previousConfig: never) => Promise<unknown> | unknown;
  /** Called on every status change; index.ts forwards it on ENTERPRISE_STATUS_CHANNEL. */
  emitStatus: (status: EnterpriseStatus) => void;
  clientVersion?: string;
  openExternal?: (url: string) => Promise<void> | void;
  focusWindow?: () => void;
  log?: (...args: unknown[]) => void;
  /** Live MCP runtime hooks (mcp-manager reconnect + session cache invalidation). */
  mcpRuntime?: ManagedMcpRuntimePort;
}

let service: EnterpriseService | null = null;

export function getEnterpriseService(): EnterpriseService | null {
  return service;
}

export function registerEnterpriseIpc(deps: EnterpriseIpcDeps): EnterpriseService {
  const store = new EnterpriseStore();
  const managed = new ManagedStore();
  const userData = app.getPath('userData');
  const skills = new ManagedSkillsWriter(
    path.join(userData, 'aion-managed-skills'),
    path.join(userData, 'aion-managed-skill-sets')
  );
  const mcp = new ManagedMcpApplier(
    mcpConfigStore,
    () => store.getAccessToken(),
    deps.mcpRuntime,
    (...a) => deps.log?.(...a),
    managed.get('mcpServers'),
    () => store.get('allowLocalMcp') === true
  );
  setManagedHeaderProvider(mcp.headerProvider);
  setManagedProfileResolver(
    createManagedProfileResolver({
      getProfiles: () => (store.get('endpoint') ? managed.get('profiles') : []),
      getMcpServers: () => (store.get('endpoint') ? managed.get('mcpServers') : []),
      getSkillPaths: (slug) => skills.getSkillPaths(slug),
    })
  );
  // eslint-disable-next-line prefer-const
  let svc: EnterpriseService;
  const sync = new SyncService({
    getEndpoint: () => store.get('endpoint'),
    getToken: () => store.getAccessToken(),
    managed,
    skills,
    mcp: {
      apply: (servers) => mcp.apply(servers),
      clear: () => mcp.clear(),
    },
    onSessionExpired: () => svc.onSyncSessionExpired(),
    onChange: () => svc.notifySyncChanged(),
    getAllowLocalMcp: () => store.get('allowLocalMcp') === true,
    log: deps.log,
  });
  svc = new EnterpriseService({
    ...deps,
    store,
    sync: {
      getStatus: () => sync.getStatus(),
      syncNow: () => sync.syncNow(),
      start: () => sync.start(),
      stop: () => sync.stop(),
      clear: () => sync.clear(),
      listProfiles: () => sync.listProfiles(),
      reapplyMcp: () => sync.reapplyMcp(),
      onTokenChanged: () => mcp.onTokenChanged(),
    },
  });
  service = svc;
  const c = ENTERPRISE_CHANNELS;
  ipcMain.handle(c.getStatus, () => svc.getStatus());
  ipcMain.handle(c.probe, (_e, endpoint: string) => svc.probe(String(endpoint ?? '')));
  ipcMain.handle(c.login, (_e, req) => svc.login(req));
  ipcMain.handle(c.loginWithBrowser, (_e, endpoint: string) =>
    svc.loginWithBrowser(String(endpoint ?? ''))
  );
  ipcMain.handle(c.cancelBrowserLogin, () => svc.cancelBrowserLogin());
  ipcMain.handle(c.verifyMfa, (_e, req) => svc.verifyMfa(req));
  ipcMain.handle(c.startMfaEnroll, (_e, mfaToken: string) => svc.startMfaEnroll(mfaToken));
  ipcMain.handle(c.confirmMfaEnroll, (_e, req) => svc.confirmMfaEnroll(req));
  ipcMain.handle(c.changePassword, (_e, req) => svc.changePassword(req));
  ipcMain.handle(c.refresh, () => svc.refresh());
  ipcMain.handle(c.logout, () => svc.logout());
  ipcMain.handle(c.listModels, () => svc.listModels());
  ipcMain.handle(c.selectModel, (_e, slug: string) => svc.selectModel(slug));
  ipcMain.handle(c.chooseStandalone, () => svc.chooseStandalone());
  ipcMain.handle(c.disconnect, () => svc.disconnect());
  ipcMain.handle(c.listProfiles, () => svc.listProfiles());
  ipcMain.handle(c.syncNow, () => svc.syncNow());
  ipcMain.handle(c.setAllowLocalMcp, (_e, allow: boolean) => svc.setAllowLocalMcp(allow === true));
  // Entries created before the opt-in existed must disappear even if the next sync answers 304.
  if (store.get('endpoint')) void sync.reapplyMcp().catch((e) => deps.log?.('reapplyMcp failed', e));
  return svc;
}
