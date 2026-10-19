/**
 * Orchestrates enterprise store + auth + managed config set.
 */
import type {
  EnterpriseChangePasswordRequest,
  EnterpriseLoginRequest,
  EnterpriseLoginResult,
  EnterpriseMfaEnrollInfo,
  EnterpriseMfaVerifyRequest,
  EnterpriseModel,
  EnterpriseProbeResult,
  EnterpriseResult,
  EnterpriseStatus,
  ManagedAionSetInput,
} from '../../shared/enterprise-types';
import * as auth from './auth';
import type { EnterpriseStore } from './enterprise-store';

/** Subset of ConfigStore used here (injected for testability). */
export interface EnterpriseConfigPort {
  isConfigured(): boolean;
  getAll(): unknown;
  applyManagedAionSet(input: ManagedAionSetInput): unknown;
  removeManagedAionSet(): unknown;
}

export interface EnterpriseServiceDeps {
  store: Pick<
    EnterpriseStore,
    'get' | 'set' | 'getAccessToken' | 'hasToken' | 'clearSession' | 'clearConnection'
  >;
  config: EnterpriseConfigPort;
  /** Same post-mutation sync as the config IPC handlers (receives the config before mutation). */
  syncConfigAfterMutation: (previousConfig: never) => Promise<unknown> | unknown;
  emitStatus: (status: EnterpriseStatus) => void;
  clientVersion?: string;
  log?: (...args: unknown[]) => void;
}

/** Floor between scheduled refresh attempts, to avoid refresh storms. */
export const MIN_REFRESH_DELAY_MS = 30_000;
export const REFRESH_RETRY_MS = 15 * 60_000;

export class EnterpriseService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingEndpoint: string | null = null;
  private ttlMs: number | undefined;
  private refreshing: Promise<EnterpriseResult<EnterpriseStatus>> | null = null;

  constructor(private readonly deps: EnterpriseServiceDeps) {}

  private get store() {
    return this.deps.store;
  }
  private log(...args: unknown[]) {
    this.deps.log?.('[Enterprise]', ...args);
  }

  getStatus(): EnterpriseStatus {
    const s = this.store;
    const endpoint = s.get('endpoint');
    const hasToken = s.hasToken();
    const user = s.get('user');
    const status: EnterpriseStatus = {
      mode: endpoint ? 'enterprise' : 'standalone',
      onboardingRequired: !s.get('onboardingDone') && !this.deps.config.isConfigured(),
      loggedIn: hasToken && !s.get('sessionExpired'),
    };
    if (endpoint) status.endpoint = endpoint;
    if (hasToken && user) status.user = user;
    if (hasToken && s.get('expiresAt')) status.expiresAt = s.get('expiresAt');
    if (s.get('sessionExpired')) status.sessionExpired = true;
    if (hasToken && s.get('mustChangePassword')) status.mustChangePassword = true;
    if (s.get('selectedModel')) status.selectedModel = s.get('selectedModel');
    if (s.get('serverVersion')) status.serverVersion = s.get('serverVersion');
    return status;
  }

  private emit(): EnterpriseStatus {
    const status = this.getStatus();
    try {
      this.deps.emitStatus(status);
    } catch (err) {
      this.log('emitStatus failed', err);
    }
    return status;
  }

  async probe(endpoint: string): Promise<EnterpriseProbeResult> {
    return auth.probe(endpoint, this.deps.clientVersion);
  }

  // ---- login flows -------------------------------------------------------

  async login(req: EnterpriseLoginRequest): Promise<EnterpriseLoginResult> {
    let endpoint: string;
    try {
      endpoint = auth.normalizeEndpoint(req.endpoint);
    } catch (err) {
      return { status: 'error', error: { code: 'invalid_endpoint', message: (err as Error).message } };
    }
    try {
      const outcome = await auth.login(endpoint, req.username, req.password);
      return await this.handleOutcome(endpoint, outcome);
    } catch (err) {
      return { status: 'error', error: auth.toEnterpriseError(err) };
    }
  }

  async verifyMfa(req: EnterpriseMfaVerifyRequest): Promise<EnterpriseLoginResult> {
    return this.mfaStep((ep) => auth.verifyMfa(ep, req.mfaToken, req.code));
  }

  async confirmMfaEnroll(req: EnterpriseMfaVerifyRequest): Promise<EnterpriseLoginResult> {
    return this.mfaStep((ep) => auth.confirmMfaEnroll(ep, req.mfaToken, req.code));
  }

  async startMfaEnroll(mfaToken: string): Promise<EnterpriseResult<EnterpriseMfaEnrollInfo>> {
    const endpoint = this.pendingEndpoint ?? this.store.get('endpoint');
    if (!endpoint) return noEndpoint();
    try {
      return { ok: true, data: await auth.startMfaEnroll(endpoint, mfaToken) };
    } catch (err) {
      return { ok: false, error: auth.toEnterpriseError(err) };
    }
  }

  private async mfaStep(
    fn: (endpoint: string) => Promise<auth.LoginOutcome>
  ): Promise<EnterpriseLoginResult> {
    const endpoint = this.pendingEndpoint ?? this.store.get('endpoint');
    if (!endpoint) return { status: 'error', error: noEndpoint().error };
    try {
      return await this.handleOutcome(endpoint, await fn(endpoint));
    } catch (err) {
      return { status: 'error', error: auth.toEnterpriseError(err) };
    }
  }

  private async handleOutcome(
    endpoint: string,
    outcome: auth.LoginOutcome
  ): Promise<EnterpriseLoginResult> {
    if (outcome.kind === 'mfa') {
      this.pendingEndpoint = endpoint;
      return {
        status: 'mfa_required',
        mfaStage: outcome.mfaStage,
        mfaToken: outcome.mfaToken,
        expiresIn: outcome.expiresIn,
      };
    }
    this.pendingEndpoint = null;
    await this.completeLogin(endpoint, outcome.login);
    return { status: 'ok', statusSnapshot: this.getStatus() };
  }

  private async completeLogin(endpoint: string, login: auth.LoginPayload): Promise<void> {
    const endpointChanged = this.store.get('endpoint') !== endpoint;
    this.store.set({
      endpoint,
      accessToken: login.accessToken,
      expiresAt: login.expiresAt,
      user: login.user,
      mustChangePassword: login.mustChangePassword,
      sessionExpired: false,
      onboardingDone: true,
      ...(endpointChanged ? { selectedModel: '' } : {}),
    });
    this.ttlMs = login.expiresAt ? Date.parse(login.expiresAt) - Date.now() : undefined;

    // Best effort: learn server version and default model.
    if (!login.mustChangePassword) {
      try {
        const info = await auth.probe(endpoint, this.deps.clientVersion);
        if (info.serverVersion) this.store.set({ serverVersion: info.serverVersion });
      } catch {
        // ignore
      }
      if (!this.store.get('selectedModel')) {
        try {
          const models = await auth.listModels(endpoint, login.accessToken);
          const pick = models.find((m) => m.isDefault) ?? models[0];
          if (pick) this.store.set({ selectedModel: pick.id });
        } catch (err) {
          this.log('model discovery failed', auth.toEnterpriseError(err).code);
        }
      }
    }
    await this.applyManagedSet();
    this.scheduleRefresh();
    this.emit();
  }

  /** Writes/updates the managed config set when logged in with a model selected. */
  private async applyManagedSet(modelLabel?: string): Promise<void> {
    const endpoint = this.store.get('endpoint');
    const token = this.store.getAccessToken();
    const model = this.store.get('selectedModel');
    if (!endpoint || !token || !model || this.store.get('mustChangePassword')) return;
    const previous = this.deps.config.getAll();
    this.deps.config.applyManagedAionSet({ endpoint, token, model, modelLabel });
    await this.deps.syncConfigAfterMutation(previous as never);
  }

  async changePassword(req: EnterpriseChangePasswordRequest): Promise<EnterpriseResult> {
    const endpoint = this.store.get('endpoint');
    if (!endpoint || !this.store.hasToken()) return noEndpoint();
    try {
      await auth.changePassword(
        endpoint,
        this.store.getAccessToken(),
        req.oldPassword,
        req.newPassword
      );
    } catch (err) {
      return this.failAuthed(err);
    }
    this.store.set({ mustChangePassword: false });
    // Models could not be discovered while the password was temporary.
    if (!this.store.get('selectedModel')) {
      try {
        const models = await auth.listModels(endpoint, this.store.getAccessToken());
        const pick = models.find((m) => m.isDefault) ?? models[0];
        if (pick) this.store.set({ selectedModel: pick.id });
      } catch {
        // ignore
      }
    }
    await this.applyManagedSet();
    this.scheduleRefresh();
    this.emit();
    return { ok: true, data: undefined };
  }

  // ---- token refresh -------------------------------------------------------

  refresh(): Promise<EnterpriseResult<EnterpriseStatus>> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<EnterpriseResult<EnterpriseStatus>> {
    const endpoint = this.store.get('endpoint');
    if (!endpoint || !this.store.hasToken()) return noEndpoint();
    try {
      const login = await auth.refresh(endpoint, this.store.getAccessToken());
      this.store.set({
        accessToken: login.accessToken,
        expiresAt: login.expiresAt,
        user: login.user,
        mustChangePassword: login.mustChangePassword,
        sessionExpired: false,
      });
      this.ttlMs = login.expiresAt ? Date.parse(login.expiresAt) - Date.now() : this.ttlMs;
      await this.applyManagedSet();
      this.scheduleRefresh();
      return { ok: true, data: this.emit() };
    } catch (err) {
      const result = this.failAuthed(err);
      this.scheduleRefresh(auth.toEnterpriseError(err).code === 'network_error' ? REFRESH_RETRY_MS : undefined);
      return result;
    }
  }

  /** Handles an authed-call failure: 401 marks the session expired. */
  private failAuthed(err: unknown): { ok: false; error: ReturnType<typeof auth.toEnterpriseError> } {
    if (err instanceof auth.EnterpriseHttpError && err.status === 401) {
      this.markSessionExpired();
    }
    return { ok: false, error: auth.toEnterpriseError(err) };
  }

  private markSessionExpired(): void {
    if (!this.store.get('sessionExpired')) {
      this.store.set({ sessionExpired: true });
      this.clearTimer();
      this.emit();
    }
  }

  startScheduler(): void {
    if (this.store.hasToken() && !this.store.get('sessionExpired')) this.scheduleRefresh();
  }

  stopScheduler(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Schedules a single timer (replacing any existing one). */
  scheduleRefresh(forcedDelayMs?: number): void {
    this.clearTimer();
    if (!this.store.hasToken() || this.store.get('sessionExpired')) return;
    let delay = forcedDelayMs;
    if (delay === undefined) {
      const computed = auth.computeRefreshDelayMs(this.store.get('expiresAt'), Date.now(), this.ttlMs);
      if (computed === null) {
        // Expiry unknown or already past: let the server decide.
        if (this.store.get('expiresAt') && Date.parse(this.store.get('expiresAt')) <= Date.now()) {
          this.markSessionExpired();
        }
        return;
      }
      delay = computed;
    }
    delay = Math.max(delay, MIN_REFRESH_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  // ---- misc ------------------------------------------------------------------

  async logout(): Promise<EnterpriseStatus> {
    const endpoint = this.store.get('endpoint');
    const token = this.store.getAccessToken();
    this.clearTimer();
    if (endpoint && token) await auth.logout(endpoint, token);
    this.store.clearSession();
    this.pendingEndpoint = null;
    // Keep the managed set (without a valid token it simply fails); the user re-logs in to refresh it.
    return this.emit();
  }

  async listModels(): Promise<EnterpriseResult<EnterpriseModel[]>> {
    const endpoint = this.store.get('endpoint');
    if (!endpoint || !this.store.hasToken()) return noEndpoint();
    try {
      return { ok: true, data: await auth.listModels(endpoint, this.store.getAccessToken()) };
    } catch (err) {
      return this.failAuthed(err);
    }
  }

  async selectModel(slug: string): Promise<EnterpriseResult<EnterpriseStatus>> {
    if (!slug) return { ok: false, error: { code: 'invalid_model', message: 'Model is required' } };
    let label: string | undefined;
    const models = await this.listModels();
    if (models.ok) {
      const found = models.data.find((m) => m.id === slug);
      if (!found) {
        return { ok: false, error: { code: 'model_not_found', message: `Unknown model: ${slug}` } };
      }
      label = found.name;
    } else if (this.store.get('sessionExpired')) {
      return models;
    }
    this.store.set({ selectedModel: slug });
    await this.applyManagedSet(label);
    return { ok: true, data: this.emit() };
  }

  async chooseStandalone(): Promise<EnterpriseStatus> {
    this.store.set({ onboardingDone: true });
    return this.emit();
  }

  async disconnect(): Promise<EnterpriseStatus> {
    await this.logout();
    const previous = this.deps.config.getAll();
    this.deps.config.removeManagedAionSet();
    await this.deps.syncConfigAfterMutation(previous as never);
    this.store.clearConnection();
    this.ttlMs = undefined;
    return this.emit();
  }
}

function noEndpoint(): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: 'not_connected', message: 'Not connected to an enterprise server' } };
}
