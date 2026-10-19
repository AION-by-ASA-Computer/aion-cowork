import type {
  EnterpriseError,
  EnterpriseProbeResult,
  EnterpriseStatus,
} from '../../shared/enterprise-types';

export type EndpointNormalization =
  | { ok: true; endpoint: string; insecure: boolean }
  | { ok: false; reason: 'empty' | 'invalid' };

/**
 * Normalizes the endpoint typed by the user: trims spaces, drops trailing slashes,
 * defaults to https:// when no scheme is given. Never adds or removes `/api`.
 */
export function normalizeEndpointInput(raw: string): EndpointNormalization {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid' };
  }
  const endpoint = withScheme.replace(/\/+$/, '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return { ok: true, endpoint, insecure: url.protocol === 'http:' && !local };
}

export type EnterpriseViewState =
  | 'loading'
  | 'onboarding'
  | 'standalone'
  | 'session-expired'
  | 'must-change-password'
  | 'logged-out'
  | 'connected';

/** Maps the main-process status to the view state used by the UI. */
export function getEnterpriseViewState(status: EnterpriseStatus | null): EnterpriseViewState {
  if (!status) return 'loading';
  if (status.onboardingRequired) return 'onboarding';
  if (status.mode !== 'enterprise') return 'standalone';
  if (status.sessionExpired) return 'session-expired';
  if (!status.loggedIn) return 'logged-out';
  if (status.mustChangePassword) return 'must-change-password';
  return 'connected';
}

/** i18n key for well-known error codes; undefined means "show the raw message". */
export function getEnterpriseErrorKey(code: string | undefined): string | undefined {
  switch (code) {
    case 'password_login_disabled':
    case 'sso_required':
      return 'enterprise.errors.ssoNotAvailable';
    case 'temp_password_expired':
      return 'enterprise.errors.tempPasswordExpired';
    case 'mfa_locked':
      return 'enterprise.errors.mfaLocked';
    case 'unreachable':
    case 'network_error':
    case 'timeout':
      return 'enterprise.errors.unreachable';
    case 'not_aion':
    case 'not_aion_agent':
      return 'enterprise.errors.notAion';
    case 'insecure_http':
    case 'http_insecure':
      return 'enterprise.errors.insecureHttp';
    case 'login_timeout':
      return 'enterprise.errors.loginTimeout';
    case 'state_mismatch':
      return 'enterprise.errors.stateMismatch';
    case 'invalid_code':
    case 'code_expired':
    case 'code_already_used':
    case 'invalid_verifier':
    case 'exchange_failed':
      return 'enterprise.errors.exchangeFailed';
    case 'desktop_login_unsupported':
      return 'enterprise.errors.desktopLoginUnsupported';
    case 'browser_open_failed':
      return 'enterprise.errors.browserOpenFailed';
    case 'session_expired':
    case 'unauthorized':
      return 'enterprise.errors.sessionExpired';
    default:
      return undefined;
  }
}

export function isSsoOnlyError(error: EnterpriseError | undefined): boolean {
  return error?.code === 'password_login_disabled' || error?.code === 'sso_required';
}

/** True when the probe says password login cannot be used from the desktop client. */
export function probeBlocksPasswordLogin(probe: EnterpriseProbeResult | null): boolean {
  if (!probe || !probe.ok) return false;
  return probe.passwordAuthEnabled === false;
}

export function formatExpiry(iso: string | undefined, locale?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(locale);
}

/** Silent outcome: the user pressed "Annulla" while waiting for the browser. */
export function isLoginCancelled(error: EnterpriseError | undefined): boolean {
  return error?.code === 'login_cancelled';
}

export interface LoginMethods {
  /** Show the "Accedi con il browser" button. */
  browser: boolean;
  /** Show the (secondary) username/password form. */
  password: boolean;
}

/**
 * Which login methods to offer. Unknown probe (not run yet / failed) keeps both available;
 * a verified server without `desktopLogin` falls back to password only (today's behaviour).
 * The password form is hidden for SSO-only servers or when loginMode is not 'password'.
 */
export function resolveLoginMethods(probe: EnterpriseProbeResult | null): LoginMethods {
  if (!probe || !probe.ok) return { browser: true, password: true };
  const passwordAllowed =
    probe.passwordAuthEnabled !== false &&
    !(probe.ssoEnabled === true && probe.passwordAuthEnabled !== true) &&
    (probe.loginMode === undefined || probe.loginMode === 'password');
  return { browser: probe.desktopLogin === true, password: passwordAllowed };
}
