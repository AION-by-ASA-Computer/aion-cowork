/**
 * Shared types for the Enterprise (AION Agent) mode.
 * IPC surface between main (src/main/enterprise/*) and renderer.
 * HTTP contract: docs/enterprise-api-contract.md
 */

export const ENTERPRISE_API_VERSION = 1;

export type EnterpriseMode = 'standalone' | 'enterprise';

export interface EnterpriseUser {
  userId: string;
  identifier: string;
  displayName: string;
  roles: string[];
}

export interface EnterpriseStatus {
  mode: EnterpriseMode;
  /** True when the first-run chooser must be shown (nothing chosen yet and no usable config). */
  onboardingRequired: boolean;
  /** Normalized endpoint (no trailing slash), when enterprise is configured. */
  endpoint?: string;
  loggedIn: boolean;
  user?: EnterpriseUser;
  /** ISO 8601 UTC expiry of the access token. */
  expiresAt?: string;
  /** Token expired or rejected (401): UI must ask for login again. */
  sessionExpired?: boolean;
  mustChangePassword?: boolean;
  /** Slug of the AION LLM provider selected for the managed config set. */
  selectedModel?: string;
  serverVersion?: string;
}

export interface EnterpriseError {
  code: string;
  message: string;
  /** Seconds, for rate limits such as mfa_locked. */
  retryAfter?: number;
}

export interface EnterpriseProbeResult {
  ok: boolean;
  endpoint: string;
  /** True when /v1/client/info answered and identified an AION Agent server. */
  verified: boolean;
  product?: string;
  apiVersion?: number;
  serverVersion?: string;
  loginMode?: string;
  passwordAuthEnabled?: boolean;
  ssoEnabled?: boolean;
  twoFactorRequired?: boolean;
  llmProxy?: boolean;
  /** Web login page of the server (chat-ui), from /v1/client/info `login_url`; undefined on older servers. */
  loginUrl?: string;
  /** Server supports browser login (PKCE + loopback): `features.desktop_login`. */
  desktopLogin?: boolean;
  /** Client too old / server API too new, etc. */
  warning?: string;
  error?: EnterpriseError;
}

export interface EnterpriseLoginRequest {
  endpoint: string;
  username: string;
  password: string;
}

export type EnterpriseLoginResult =
  | { status: 'ok'; statusSnapshot: EnterpriseStatus }
  | { status: 'mfa_required'; mfaStage: 'enroll' | 'verify'; mfaToken: string; expiresIn?: number }
  | { status: 'error'; error: EnterpriseError };

export interface EnterpriseMfaVerifyRequest {
  mfaToken: string;
  code: string;
}

export interface EnterpriseMfaEnrollInfo {
  otpauthUri: string;
  qrSvg?: string;
  secret: string;
}

export interface EnterpriseChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface EnterpriseModel {
  /** Provider slug, passed as `model` to /v1/llm/chat/completions. */
  id: string;
  name: string;
  modelName: string;
  description?: string;
  isDefault: boolean;
}

export type EnterpriseResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: EnterpriseError };

/** Renderer-facing API, exposed as window.electronAPI.enterprise */
export interface EnterpriseAPI {
  getStatus(): Promise<EnterpriseStatus>;
  probe(endpoint: string): Promise<EnterpriseProbeResult>;
  login(request: EnterpriseLoginRequest): Promise<EnterpriseLoginResult>;
  verifyMfa(request: EnterpriseMfaVerifyRequest): Promise<EnterpriseLoginResult>;
  startMfaEnroll(mfaToken: string): Promise<EnterpriseResult<EnterpriseMfaEnrollInfo>>;
  confirmMfaEnroll(request: EnterpriseMfaVerifyRequest): Promise<EnterpriseLoginResult>;
  changePassword(request: EnterpriseChangePasswordRequest): Promise<EnterpriseResult>;
  refresh(): Promise<EnterpriseResult<EnterpriseStatus>>;
  logout(): Promise<EnterpriseStatus>;
  listModels(): Promise<EnterpriseResult<EnterpriseModel[]>>;
  selectModel(slug: string): Promise<EnterpriseResult<EnterpriseStatus>>;
  /** Records the "standalone" choice so the first-run chooser is not shown again. */
  chooseStandalone(): Promise<EnterpriseStatus>;
  /** Logs out, removes the managed config set and forgets the endpoint. */
  disconnect(): Promise<EnterpriseStatus>;
  /**
   * Browser login (PKCE + loopback callback): opens the server web login page in the system
   * browser (password, SSO and 2FA are all handled by the web UI) and resolves once the
   * callback has been exchanged. Error codes: login_cancelled, login_timeout, state_mismatch,
   * exchange_failed.
   */
  loginWithBrowser(endpoint: string): Promise<EnterpriseLoginResult>;
  cancelBrowserLogin(): Promise<void>;
  /**
   * Subscribes to status pushes on a dedicated IPC channel (ENTERPRISE_STATUS_CHANNEL).
   * Independent from electronAPI.on, which only allows a single listener.
   */
  onStatus(callback: (status: EnterpriseStatus) => void): () => void;
}

/** Dedicated IPC channel for status pushes (main -> renderer). */
export const ENTERPRISE_STATUS_CHANNEL = 'enterprise-status';

/** IPC channel names (ipcMain.handle / ipcRenderer.invoke). */
export const ENTERPRISE_CHANNELS = {
  getStatus: 'enterprise.getStatus',
  probe: 'enterprise.probe',
  login: 'enterprise.login',
  verifyMfa: 'enterprise.verifyMfa',
  startMfaEnroll: 'enterprise.startMfaEnroll',
  confirmMfaEnroll: 'enterprise.confirmMfaEnroll',
  changePassword: 'enterprise.changePassword',
  refresh: 'enterprise.refresh',
  logout: 'enterprise.logout',
  listModels: 'enterprise.listModels',
  selectModel: 'enterprise.selectModel',
  chooseStandalone: 'enterprise.chooseStandalone',
  disconnect: 'enterprise.disconnect',
  loginWithBrowser: 'enterprise.loginWithBrowser',
  cancelBrowserLogin: 'enterprise.cancelBrowserLogin',
} as const;

/** ServerEvent type pushed to the renderer when status changes; payload is EnterpriseStatus. */
export const ENTERPRISE_STATUS_EVENT = 'enterprise.status';

/**
 * Managed config set API (config-store.ts), used by the enterprise module.
 * The managed set has id MANAGED_AION_SET_ID and `managed: 'aion'`.
 */
export const MANAGED_AION_SET_ID = 'aion-enterprise';

export interface ManagedAionSetInput {
  /** Normalized endpoint, e.g. https://host/api */
  endpoint: string;
  /** Current access token (used as apiKey). */
  token: string;
  /** Provider slug (used as model id). */
  model: string;
  /** Display name of the selected model, for UI. */
  modelLabel?: string;
}
