/**
 * HTTP client for the AION Agent enterprise API (docs/enterprise-api-contract.md).
 * Stateless: the caller supplies endpoint/token. Never logs tokens or passwords.
 */
import {
  ENTERPRISE_API_VERSION,
  type EnterpriseError,
  type EnterpriseModel,
  type EnterpriseMfaEnrollInfo,
  type EnterpriseProbeResult,
  type EnterpriseUser,
} from '../../shared/enterprise-types';

export const REQUEST_TIMEOUT_MS = 15000;
export const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REFRESH_TTL_FRACTION = 0.1;
/** Do not schedule timers longer than this (setTimeout max is ~24.8 days). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

type FetchFn = typeof fetch;
let fetchImpl: FetchFn | null = null;
/** Test hook. */
export function setFetchImplementation(fn: FetchFn | null): void {
  fetchImpl = fn;
}
function doFetch(): FetchFn {
  return fetchImpl ?? (globalThis.fetch as FetchFn);
}

export class EnterpriseHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: EnterpriseError
  ) {
    super(error.message);
    this.name = 'EnterpriseHttpError';
  }
}

export interface LoginPayload {
  accessToken: string;
  expiresAt: string;
  user: EnterpriseUser;
  mustChangePassword: boolean;
}

export type LoginOutcome =
  | { kind: 'ok'; login: LoginPayload }
  | { kind: 'mfa'; mfaStage: 'enroll' | 'verify'; mfaToken: string; expiresIn?: number };

export function normalizeEndpoint(raw: string): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Endpoint is empty');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Invalid endpoint URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Endpoint must use http or https');
  }
  if (url.search || url.hash) throw new Error('Endpoint must not contain query or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** True for localhost / loopback / RFC1918 / .local / .internal hosts. */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !h.includes('.'); // single-label intranet names
}

function networkError(err: unknown): EnterpriseError {
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'timeout', message: 'The server did not respond in time' };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'network_error', message: `Cannot reach the server: ${message}` };
}

function parseErrorBody(status: number, body: unknown): EnterpriseError {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === 'object') {
    const d = detail as { code?: unknown; message?: unknown; retry_after?: unknown };
    const code = typeof d.code === 'string' ? d.code : `http_${status}`;
    const retryAfter = typeof d.retry_after === 'number' ? d.retry_after : undefined;
    const message = typeof d.message === 'string' ? d.message : code;
    return { code, message, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  }
  if (typeof detail === 'string') {
    if (status === 401) return { code: 'invalid_credentials', message: detail };
    return { code: `http_${status}`, message: detail };
  }
  const openAiErr = (body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  if (openAiErr && typeof openAiErr.message === 'string') {
    return {
      code: typeof openAiErr.code === 'string' ? openAiErr.code : `http_${status}`,
      message: openAiErr.message,
    };
  }
  if (status === 401) return { code: 'invalid_credentials', message: 'Invalid credentials' };
  return { code: `http_${status}`, message: `Server returned HTTP ${status}` };
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** Performs a request; resolves with parsed JSON or throws EnterpriseHttpError (status 0 = network). */
export async function requestJson<T = unknown>(
  endpoint: string,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let res: Response;
    try {
      res = await doFetch()(`${endpoint}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new EnterpriseHttpError(0, networkError(err));
    }
    let parsed: unknown = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw new EnterpriseHttpError(res.status, parseErrorBody(res.status, parsed));
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

export function toEnterpriseError(err: unknown): EnterpriseError {
  if (err instanceof EnterpriseHttpError) return err.error;
  return { code: 'unknown', message: err instanceof Error ? err.message : String(err) };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Heuristic used when the server does not publish `login_url`: the API usually lives under
 * `<host>/api` while the web login page is `<host>/login`. Callers must not treat the result as
 * proof of desktop login support (that is `features.desktop_login`).
 */
export function fallbackLoginUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '').replace(/\/api$/, '')}/login`;
}

export async function probe(
  rawEndpoint: string,
  clientVersion?: string
): Promise<EnterpriseProbeResult> {
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(rawEndpoint);
  } catch (err) {
    return {
      ok: false,
      endpoint: (rawEndpoint || '').trim(),
      verified: false,
      error: { code: 'invalid_endpoint', message: (err as Error).message },
    };
  }
  const warnings: string[] = [];
  if (new URL(endpoint).protocol === 'http:' && !isLocalOrPrivateHost(new URL(endpoint).hostname)) {
    warnings.push('Connection is not encrypted (http) on a public host');
  }

  try {
    const info = await requestJson<Record<string, unknown>>(endpoint, '/v1/client/info');
    if (info && info.product === 'aion-agent') {
      const apiVersion = typeof info.api_version === 'number' ? info.api_version : undefined;
      const features = (info.features as Record<string, unknown> | undefined) ?? {};
      const minClient = typeof info.min_client_version === 'string' ? info.min_client_version : '';
      if (apiVersion !== undefined && apiVersion > ENTERPRISE_API_VERSION) {
        warnings.push('Server API is newer than this client; please update the app');
      }
      if (minClient && clientVersion && compareVersions(clientVersion, minClient) < 0) {
        warnings.push(`This client is older than the minimum required version (${minClient})`);
      }
      return {
        ok: true,
        endpoint,
        verified: true,
        product: 'aion-agent',
        apiVersion,
        serverVersion: typeof info.version === 'string' ? info.version : undefined,
        loginMode: typeof info.login_mode === 'string' ? info.login_mode : undefined,
        passwordAuthEnabled: info.password_auth_enabled as boolean | undefined,
        ssoEnabled: info.sso_enabled as boolean | undefined,
        twoFactorRequired: info.two_factor_required as boolean | undefined,
        llmProxy: features.llm_proxy as boolean | undefined,
        loginUrl:
          typeof info.login_url === 'string' && info.login_url ? info.login_url : fallbackLoginUrl(endpoint),
        desktopLogin: features.desktop_login === true,
        ...(warnings.length ? { warning: warnings.join('; ') } : {}),
      };
    }
  } catch {
    // fall through to legacy probing
  }

  // Fallback: /health + /auth/status (older server without /v1/client/info)
  try {
    const health = await requestJson<{ status?: string }>(endpoint, '/health');
    if (health?.status !== 'ok') {
      return {
        ok: false,
        endpoint,
        verified: false,
        error: { code: 'not_aion', message: 'The endpoint is not an AION Agent server' },
      };
    }
    let status: Record<string, unknown> = {};
    try {
      status = (await requestJson<Record<string, unknown>>(endpoint, '/auth/status')) ?? {};
    } catch {
      // optional
    }
    warnings.push('Server version could not be verified (older server without client API)');
    return {
      ok: true,
      endpoint,
      verified: false,
      loginMode: typeof status.login_mode === 'string' ? status.login_mode : undefined,
      passwordAuthEnabled: status.password_auth_enabled as boolean | undefined,
      ssoEnabled: status.sso_enabled as boolean | undefined,
      twoFactorRequired: status.two_factor_required as boolean | undefined,
      warning: warnings.join('; '),
    };
  } catch (err) {
    return { ok: false, endpoint, verified: false, error: toEnterpriseError(err) };
  }
}

export function parseLoginPayload(data: unknown, now: number = Date.now()): LoginPayload {
  const d = (data ?? {}) as Record<string, unknown>;
  const accessToken = typeof d.access_token === 'string' ? d.access_token : '';
  if (!accessToken) {
    throw new EnterpriseHttpError(200, {
      code: 'invalid_response',
      message: 'Server response did not include an access token',
    });
  }
  let expiresAt = typeof d.expires_at === 'string' ? d.expires_at : '';
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    const secs = typeof d.expires_in === 'number' ? d.expires_in : 0;
    expiresAt = secs > 0 ? new Date(now + secs * 1000).toISOString() : '';
  }
  return {
    accessToken,
    expiresAt,
    mustChangePassword: Boolean(d.must_change_password),
    user: {
      userId: String(d.user_id ?? ''),
      identifier: String(d.identifier ?? ''),
      displayName: String(d.display_name ?? d.identifier ?? ''),
      roles: Array.isArray(d.roles) ? d.roles.map(String) : [],
    },
  };
}

function parseLoginOutcome(data: unknown): LoginOutcome {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.mfa_required && typeof d.mfa_token === 'string') {
    return {
      kind: 'mfa',
      mfaStage: d.mfa_stage === 'enroll' ? 'enroll' : 'verify',
      mfaToken: d.mfa_token,
      expiresIn: typeof d.expires_in === 'number' ? d.expires_in : undefined,
    };
  }
  return { kind: 'ok', login: parseLoginPayload(data) };
}

export async function login(
  endpoint: string,
  username: string,
  password: string
): Promise<LoginOutcome> {
  const data = await requestJson(endpoint, '/auth/login', {
    method: 'POST',
    body: { username, password, client: 'chat' },
  });
  return parseLoginOutcome(data);
}

/** Exchanges the one-time code obtained through the browser callback (PKCE) for a session. */
export async function exchangeDesktopCode(
  endpoint: string,
  code: string,
  codeVerifier: string
): Promise<LoginOutcome> {
  try {
    const data = await requestJson(endpoint, '/auth/desktop/exchange', {
      method: 'POST',
      body: { code, code_verifier: codeVerifier },
    });
    return parseLoginOutcome(data);
  } catch (err) {
    if (err instanceof EnterpriseHttpError && DESKTOP_EXCHANGE_ERRORS.has(err.error.code)) {
      // Same code the server sent; the renderer maps it to a localized message.
      throw new EnterpriseHttpError(err.status, {
        code: err.error.code,
        message: err.error.message || DESKTOP_EXCHANGE_ERRORS.get(err.error.code)!,
      });
    }
    throw err;
  }
}

const DESKTOP_EXCHANGE_ERRORS = new Map<string, string>([
  ['invalid_code', 'The login code is not valid'],
  ['code_expired', 'The login code has expired'],
  ['code_already_used', 'The login code was already used'],
  ['invalid_verifier', 'The login verification failed'],
]);

export async function verifyMfa(
  endpoint: string,
  mfaToken: string,
  code: string
): Promise<LoginOutcome> {
  const data = await requestJson(endpoint, '/auth/2fa/verify', {
    method: 'POST',
    body: { mfa_token: mfaToken, code },
  });
  return parseLoginOutcome(data);
}

export async function startMfaEnroll(
  endpoint: string,
  mfaToken: string
): Promise<EnterpriseMfaEnrollInfo> {
  const d = await requestJson<Record<string, unknown>>(endpoint, '/auth/2fa/enroll/start', {
    method: 'POST',
    body: { mfa_token: mfaToken },
  });
  return {
    otpauthUri: String(d.otpauth_uri ?? ''),
    qrSvg: typeof d.qr_svg === 'string' ? d.qr_svg : undefined,
    secret: String(d.secret ?? ''),
  };
}

export async function confirmMfaEnroll(
  endpoint: string,
  mfaToken: string,
  code: string
): Promise<LoginOutcome> {
  const data = await requestJson(endpoint, '/auth/2fa/enroll/confirm', {
    method: 'POST',
    body: { mfa_token: mfaToken, code },
  });
  return parseLoginOutcome(data);
}

export async function changePassword(
  endpoint: string,
  token: string,
  oldPassword: string,
  newPassword: string
): Promise<void> {
  await requestJson(endpoint, '/auth/change-password', {
    method: 'POST',
    token,
    body: { old_password: oldPassword, new_password: newPassword },
  });
}

export async function refresh(endpoint: string, token: string): Promise<LoginPayload> {
  const data = await requestJson(endpoint, '/auth/refresh', { method: 'POST', token });
  return parseLoginPayload(data);
}

/** Best effort: failures are swallowed. */
export async function logout(endpoint: string, token: string): Promise<void> {
  try {
    await requestJson(endpoint, '/auth/logout', { method: 'POST', token, timeoutMs: 5000 });
  } catch {
    // token is stateless; local removal is what matters
  }
}

export async function listModels(endpoint: string, token: string): Promise<EnterpriseModel[]> {
  const data = await requestJson<{ data?: unknown }>(endpoint, '/v1/llm/models', { token });
  const rows = Array.isArray(data?.data) ? (data.data as Record<string, unknown>[]) : [];
  return rows
    .filter((r) => typeof r.id === 'string' && r.id)
    .map((r) => ({
      id: String(r.id),
      name: String(r.name ?? r.id),
      modelName: String(r.model_name ?? r.id),
      description: typeof r.description === 'string' && r.description ? r.description : undefined,
      isDefault: Boolean(r.is_default),
    }));
}

/**
 * Milliseconds to wait before refreshing a token that expires at `expiresAt`.
 * Refresh once less than max(24h, 10% of TTL) remains, but never earlier than half the TTL
 * (so short-lived tokens do not refresh in a loop). Without a known TTL the window is capped
 * at half of the remaining lifetime. Returns 0 for "refresh now", null for unknown/past expiry.
 */
export function computeRefreshDelayMs(
  expiresAt: string,
  now: number = Date.now(),
  ttlMs?: number
): number | null {
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return null;
  const remaining = exp - now;
  if (remaining <= 0) return null;
  let window = REFRESH_WINDOW_MS;
  if (ttlMs && ttlMs > 0) {
    window = Math.min(Math.max(window, ttlMs * REFRESH_TTL_FRACTION), ttlMs / 2);
  } else {
    window = Math.min(window, remaining / 2);
  }
  return Math.min(Math.max(remaining - window, 0), MAX_TIMER_MS);
}
