/**
 * IPC handlers for Enterprise mode. One handler per channel in ENTERPRISE_CHANNELS.
 */
import { ipcMain } from 'electron';
import { ENTERPRISE_CHANNELS, type EnterpriseStatus } from '../../shared/enterprise-types';
import { EnterpriseService, type EnterpriseConfigPort } from './enterprise-service';
import { EnterpriseStore } from './enterprise-store';

export interface EnterpriseIpcDeps {
  config: EnterpriseConfigPort;
  syncConfigAfterMutation: (previousConfig: never) => Promise<unknown> | unknown;
  /** Called on every status change; index.ts forwards it on ENTERPRISE_STATUS_CHANNEL. */
  emitStatus: (status: EnterpriseStatus) => void;
  clientVersion?: string;
  log?: (...args: unknown[]) => void;
}

let service: EnterpriseService | null = null;

export function getEnterpriseService(): EnterpriseService | null {
  return service;
}

export function registerEnterpriseIpc(deps: EnterpriseIpcDeps): EnterpriseService {
  const svc = new EnterpriseService({ ...deps, store: new EnterpriseStore() });
  service = svc;
  const c = ENTERPRISE_CHANNELS;
  ipcMain.handle(c.getStatus, () => svc.getStatus());
  ipcMain.handle(c.probe, (_e, endpoint: string) => svc.probe(String(endpoint ?? '')));
  ipcMain.handle(c.login, (_e, req) => svc.login(req));
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
  return svc;
}
