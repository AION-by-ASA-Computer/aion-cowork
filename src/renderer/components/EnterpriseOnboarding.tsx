import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  KeyRound,
  Loader2,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  EnterpriseError,
  EnterpriseLoginResult,
  EnterpriseMfaEnrollInfo,
  EnterpriseModel,
  EnterpriseProbeResult,
  EnterpriseStatus,
} from '../../shared/enterprise-types';
import { getEnterpriseApi } from '../utils/enterprise-api';
import {
  getEnterpriseErrorKey,
  isSsoOnlyError,
  normalizeEndpointInput,
  probeBlocksPasswordLogin,
} from '../utils/enterprise-helpers';
import { setEnterpriseStatus } from '../hooks/useEnterpriseStatus';

const inputClass =
  'w-full px-3 py-2 rounded-lg bg-background border border-border-subtle text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent disabled:opacity-60';
const primaryBtn =
  'inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const secondaryBtn =
  'inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border-subtle text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 transition-colors';

export function describeEnterpriseError(t: TFunction, error: EnterpriseError): string {
  const key = getEnterpriseErrorKey(error.code);
  if (key) return t(key, { seconds: error.retryAfter ?? 0 });
  return error.message || t('enterprise.errors.generic');
}

function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-sm text-error"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function InfoBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-hover px-3 py-2 text-sm text-text-secondary"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-accent" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-text-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

// ==================== Login (login / MFA / change password) ====================

type LoginSubStep = 'login' | 'mfa' | 'enroll' | 'password';

interface EnterpriseLoginPanelProps {
  endpoint: string;
  initialUsername?: string;
  /** Called when the user is fully authenticated (after MFA / password change). */
  onSuccess: (status: EnterpriseStatus) => void;
  /** Start directly at the change-password step (status.mustChangePassword). */
  startAtChangePassword?: boolean;
}

export function EnterpriseLoginPanel({
  endpoint,
  initialUsername = '',
  onSuccess,
  startAtChangePassword = false,
}: EnterpriseLoginPanelProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<LoginSubStep>(startAtChangePassword ? 'password' : 'login');
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const [enroll, setEnroll] = useState<EnterpriseMfaEnrollInfo | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EnterpriseError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const finish = useCallback(
    (snapshot: EnterpriseStatus) => {
      setEnterpriseStatus(snapshot);
      if (snapshot.mustChangePassword) {
        setError(null);
        setStep('password');
        return;
      }
      onSuccess(snapshot);
    },
    [onSuccess]
  );

  const handleResult = useCallback(
    async (result: EnterpriseLoginResult) => {
      const api = getEnterpriseApi();
      if (result.status === 'ok') {
        finish(result.statusSnapshot);
      } else if (result.status === 'mfa_required') {
        setMfaToken(result.mfaToken);
        setCode('');
        if (result.mfaStage === 'enroll' && api) {
          const info = await api.startMfaEnroll(result.mfaToken);
          if (info.ok) {
            setEnroll(info.data);
            setStep('enroll');
          } else {
            setError(info.error);
          }
        } else {
          setStep('mfa');
        }
      } else {
        setError(result.error);
      }
    },
    [finish]
  );

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setLocalError(null);
    try {
      await fn();
    } catch (err) {
      setError({ code: 'unexpected', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    const api = getEnterpriseApi();
    if (!api || busy || !username.trim() || !password) return;
    void run(async () => handleResult(await api.login({ endpoint, username: username.trim(), password })));
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    const api = getEnterpriseApi();
    if (!api || busy || !code.trim()) return;
    const request = { mfaToken, code: code.trim() };
    void run(async () =>
      handleResult(
        step === 'enroll' ? await api.confirmMfaEnroll(request) : await api.verifyMfa(request)
      )
    );
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    const api = getEnterpriseApi();
    if (!api || busy) return;
    if (!newPassword || newPassword !== confirmPassword) {
      setLocalError(t('enterprise.changePassword.mismatch'));
      return;
    }
    void run(async () => {
      const res = await api.changePassword({
        oldPassword: password || oldPassword,
        newPassword,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const status = await api.getStatus();
      setEnterpriseStatus(status);
      onSuccess(status);
    });
  };

  const errorNode = error ? (
    isSsoOnlyError(error) ? (
      <InfoBanner>{t('enterprise.login.ssoNotAvailable')}</InfoBanner>
    ) : (
      <ErrorBanner>{describeEnterpriseError(t, error)}</ErrorBanner>
    )
  ) : localError ? (
    <ErrorBanner>{localError}</ErrorBanner>
  ) : null;

  if (step === 'login') {
    return (
      <form onSubmit={submitLogin} className="space-y-4">
        <p className="text-xs text-text-muted break-all">{endpoint}</p>
        <Field id="ent-username" label={t('enterprise.login.username')}>
          <input
            id="ent-username"
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            disabled={busy}
          />
        </Field>
        <Field id="ent-password" label={t('enterprise.login.password')}>
          <input
            id="ent-password"
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />
        </Field>
        {errorNode}
        <button type="submit" className={`${primaryBtn} w-full`} disabled={busy || !username.trim() || !password}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {busy ? t('enterprise.login.signingIn') : t('enterprise.login.signIn')}
        </button>
      </form>
    );
  }

  if (step === 'mfa' || step === 'enroll') {
    return (
      <form onSubmit={submitCode} className="space-y-4">
        <div className="flex items-center gap-2 text-text-primary">
          <ShieldCheck className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold">
            {step === 'enroll' ? t('enterprise.mfa.enrollTitle') : t('enterprise.mfa.verifyTitle')}
          </h3>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {step === 'enroll' ? t('enterprise.mfa.enrollHint') : t('enterprise.mfa.verifyHint')}
        </p>
        {step === 'enroll' && enroll && (
          <div className="space-y-3">
            {enroll.qrSvg && (
              <img
                alt={t('enterprise.mfa.qrAlt')}
                className="w-44 h-44 mx-auto rounded-lg bg-white p-2"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(enroll.qrSvg)}`}
              />
            )}
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{t('enterprise.mfa.secret')}</p>
              <code className="block rounded-lg bg-surface-hover px-3 py-2 text-xs text-text-primary break-all select-text">
                {enroll.secret}
              </code>
            </div>
          </div>
        )}
        <Field id="ent-mfa-code" label={t('enterprise.mfa.code')}>
          <input
            id="ent-mfa-code"
            className={inputClass}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            disabled={busy}
          />
        </Field>
        {errorNode}
        <div className="flex gap-2">
          <button
            type="button"
            className={secondaryBtn}
            disabled={busy}
            onClick={() => {
              setError(null);
              setStep('login');
            }}
          >
            {t('enterprise.back')}
          </button>
          <button type="submit" className={`${primaryBtn} flex-1`} disabled={busy || !code.trim()}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('enterprise.mfa.confirm')}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submitPassword} className="space-y-4">
      <div className="flex items-center gap-2 text-text-primary">
        <KeyRound className="w-4 h-4 text-accent" />
        <h3 className="text-sm font-semibold">{t('enterprise.changePassword.title')}</h3>
      </div>
      <p className="text-xs leading-5 text-text-muted">{t('enterprise.changePassword.hint')}</p>
      {!password && (
        <Field id="ent-old-password" label={t('enterprise.changePassword.current')}>
          <input
            id="ent-old-password"
            type="password"
            className={inputClass}
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />
        </Field>
      )}
      <Field id="ent-new-password" label={t('enterprise.changePassword.new')}>
        <input
          id="ent-new-password"
          type="password"
          className={inputClass}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
          disabled={busy}
        />
      </Field>
      <Field id="ent-confirm-password" label={t('enterprise.changePassword.confirm')}>
        <input
          id="ent-confirm-password"
          type="password"
          className={inputClass}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
        />
      </Field>
      {errorNode}
      <button type="submit" className={`${primaryBtn} w-full`} disabled={busy || !newPassword}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {t('enterprise.changePassword.submit')}
      </button>
    </form>
  );
}

// ==================== Model picker ====================

interface EnterpriseModelPickerProps {
  selected?: string;
  submitLabel: string;
  onDone: (status: EnterpriseStatus) => void;
  onCancel?: () => void;
}

export function EnterpriseModelPicker({
  selected,
  submitLabel,
  onDone,
  onCancel,
}: EnterpriseModelPickerProps) {
  const { t } = useTranslation();
  const [models, setModels] = useState<EnterpriseModel[] | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EnterpriseError | null>(null);

  const load = useCallback(async () => {
    const api = getEnterpriseApi();
    if (!api) return;
    setModels(null);
    setError(null);
    try {
      const res = await api.listModels();
      if (!res.ok) {
        setError(res.error);
        setModels([]);
        return;
      }
      setModels(res.data);
      const pre =
        res.data.find((m) => m.id === selected) ??
        res.data.find((m) => m.isDefault) ??
        res.data[0];
      setChoice(pre?.id ?? '');
    } catch (err) {
      setError({ code: 'unexpected', message: err instanceof Error ? err.message : String(err) });
      setModels([]);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const api = getEnterpriseApi();
    if (!api || !choice || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.selectModel(choice);
      if (res.ok) {
        setEnterpriseStatus(res.data);
        onDone(res.data);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError({ code: 'unexpected', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs leading-5 text-text-muted">{t('enterprise.model.hint')}</p>
      {models === null && (
        <div className="flex items-center gap-2 text-sm text-text-muted" role="status">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('enterprise.model.loading')}
        </div>
      )}
      {models && models.length === 0 && !error && (
        <InfoBanner>{t('enterprise.model.empty')}</InfoBanner>
      )}
      {models && models.length > 0 && (
        <div role="radiogroup" aria-label={t('enterprise.model.title')} className="space-y-2 max-h-64 overflow-y-auto">
          {models.map((m) => (
            <label
              key={m.id}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                choice === m.id
                  ? 'border-accent/40 bg-accent-muted'
                  : 'border-border-subtle hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                name="enterprise-model"
                className="mt-1 accent-[var(--color-accent,currentColor)]"
                checked={choice === m.id}
                onChange={() => setChoice(m.id)}
                disabled={busy}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-primary truncate">
                  {m.name}
                  {m.isDefault && (
                    <span className="ml-2 px-1.5 py-px text-[10px] rounded bg-surface-active text-text-muted">
                      {t('enterprise.model.default')}
                    </span>
                  )}
                </span>
                <span className="block text-xs text-text-muted truncate">{m.modelName}</span>
                {m.description && (
                  <span className="block text-xs text-text-muted mt-0.5">{m.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <ErrorBanner>{describeEnterpriseError(t, error)}</ErrorBanner>}
      <div className="flex gap-2">
        {onCancel && (
          <button type="button" className={secondaryBtn} onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
        )}
        {error && models && models.length === 0 && (
          <button type="button" className={secondaryBtn} onClick={() => void load()}>
            {t('enterprise.retry')}
          </button>
        )}
        <button type="submit" className={`${primaryBtn} flex-1`} disabled={busy || !choice}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

// ==================== Wizard ====================

type WizardStep = 'choose' | 'endpoint' | 'login' | 'model' | 'done';

export interface EnterpriseOnboardingProps {
  /** First step. Defaults to 'choose'; Settings uses 'endpoint'. */
  initialStep?: 'choose' | 'endpoint';
  /** Opened on demand (can be dismissed) instead of the mandatory first-run chooser. */
  force?: boolean;
  onClose: () => void;
}

export function EnterpriseOnboarding({
  initialStep = 'choose',
  force = false,
  onClose,
}: EnterpriseOnboardingProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [endpointInput, setEndpointInput] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [probe, setProbe] = useState<EnterpriseProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [statusAfterLogin, setStatusAfterLogin] = useState<EnterpriseStatus | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!force) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [force, onClose]);

  const chooseStandalone = async () => {
    const api = getEnterpriseApi();
    if (!api || busy) return;
    setBusy(true);
    setChooseError(null);
    try {
      setEnterpriseStatus(await api.chooseStandalone());
      onClose();
    } catch (err) {
      setChooseError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runProbe = async (e?: FormEvent) => {
    e?.preventDefault();
    const api = getEnterpriseApi();
    if (!api || probing) return;
    const normalized = normalizeEndpointInput(endpointInput);
    setProbe(null);
    setProbeError(null);
    if (!normalized.ok) {
      setProbeError(
        normalized.reason === 'empty'
          ? t('enterprise.endpoint.empty')
          : t('enterprise.endpoint.invalid')
      );
      return;
    }
    setEndpointInput(normalized.endpoint);
    setProbing(true);
    try {
      const result = await api.probe(normalized.endpoint);
      setProbe(result);
      setEndpoint(result.endpoint || normalized.endpoint);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const normalizedForWarning = normalizeEndpointInput(endpointInput);
  const insecure = normalizedForWarning.ok && normalizedForWarning.insecure;
  const sso = probeBlocksPasswordLogin(probe);
  const canContinue = Boolean(probe?.ok) && !sso;

  const titleKey: Record<WizardStep, string> = {
    choose: 'enterprise.choose.title',
    endpoint: 'enterprise.endpoint.title',
    login: 'enterprise.login.title',
    model: 'enterprise.model.title',
    done: 'enterprise.done.title',
  };

  const onBack =
    step === 'endpoint' && initialStep === 'choose'
      ? () => setStep('choose')
      : step === 'login'
        ? () => setStep('endpoint')
        : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="enterprise-onboarding-title"
        className="relative w-full max-w-lg max-h-full overflow-y-auto rounded-2xl border border-border-subtle bg-surface p-6 shadow-soft focus:outline-none"
      >
        {force && step !== 'done' && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-surface-hover text-text-secondary"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <div className="mb-5">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mb-3 inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t('enterprise.back')}
            </button>
          )}
          <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
            {t('enterprise.brand')}
          </p>
          <h2
            id="enterprise-onboarding-title"
            className="mt-1 text-lg font-semibold tracking-[-0.02em] text-text-primary"
          >
            {t(titleKey[step])}
          </h2>
        </div>

        {step === 'choose' && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted">{t('enterprise.choose.subtitle')}</p>
            <button
              type="button"
              onClick={() => void chooseStandalone()}
              disabled={busy}
              className="w-full text-left rounded-xl border border-border-subtle p-4 hover:bg-surface-hover hover:border-accent/40 transition-colors disabled:opacity-60"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <KeyRound className="w-4 h-4 text-accent" />
                {t('enterprise.choose.standalone')}
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              </span>
              <span className="mt-1 block text-xs text-text-muted">
                {t('enterprise.choose.standaloneDesc')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setStep('endpoint')}
              disabled={busy}
              className="w-full text-left rounded-xl border border-border-subtle p-4 hover:bg-surface-hover hover:border-accent/40 transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Building2 className="w-4 h-4 text-accent" />
                {t('enterprise.choose.enterprise')}
              </span>
              <span className="mt-1 block text-xs text-text-muted">
                {t('enterprise.choose.enterpriseDesc')}
              </span>
            </button>
            {chooseError && <ErrorBanner>{chooseError}</ErrorBanner>}
          </div>
        )}

        {step === 'endpoint' && (
          <form onSubmit={runProbe} className="space-y-4">
            <p className="text-xs leading-5 text-text-muted">{t('enterprise.endpoint.hint')}</p>
            <Field id="ent-endpoint" label={t('enterprise.endpoint.label')}>
              <input
                id="ent-endpoint"
                className={inputClass}
                value={endpointInput}
                onChange={(e) => {
                  setEndpointInput(e.target.value);
                  setProbe(null);
                  setProbeError(null);
                }}
                placeholder="https://agent.azienda.it/api"
                autoComplete="url"
                spellCheck={false}
                autoFocus
                disabled={probing}
              />
            </Field>
            {insecure && <InfoBanner>{t('enterprise.errors.insecureHttp')}</InfoBanner>}
            {probeError && <ErrorBanner>{probeError}</ErrorBanner>}
            {probe && !probe.ok && (
              <ErrorBanner>
                {probe.error
                  ? describeEnterpriseError(t, probe.error)
                  : t('enterprise.errors.unreachable')}
              </ErrorBanner>
            )}
            {probe?.ok && (
              <div className="rounded-lg border border-border-subtle bg-surface-hover px-3 py-2.5 space-y-1 text-sm">
                <p className="flex items-center gap-2 font-medium text-text-primary">
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  {probe.verified
                    ? t('enterprise.endpoint.verified')
                    : t('enterprise.endpoint.unverified')}
                </p>
                <p className="text-xs text-text-muted">
                  {t('enterprise.endpoint.serverVersion')}: {probe.serverVersion ?? '-'}
                  {probe.loginMode ? ` · ${t('enterprise.endpoint.loginMode')}: ${probe.loginMode}` : ''}
                </p>
                {probe.warning && (
                  <p className="text-xs text-warning break-words">{probe.warning}</p>
                )}
                {probe.twoFactorRequired && (
                  <p className="text-xs text-text-muted">{t('enterprise.endpoint.twoFactor')}</p>
                )}
              </div>
            )}
            {sso && <InfoBanner>{t('enterprise.login.ssoNotAvailable')}</InfoBanner>}
            <div className="flex gap-2">
              <button
                type="submit"
                className={`${canContinue ? secondaryBtn : primaryBtn} ${canContinue ? '' : 'flex-1'}`}
                disabled={probing || !endpointInput.trim()}
              >
                {probing && <Loader2 className="w-4 h-4 animate-spin" />}
                {probing ? t('enterprise.endpoint.verifying') : t('enterprise.endpoint.verify')}
              </button>
              {canContinue && (
                <button type="button" className={`${primaryBtn} flex-1`} onClick={() => setStep('login')}>
                  {t('enterprise.next')}
                </button>
              )}
            </div>
          </form>
        )}

        {step === 'login' && (
          <EnterpriseLoginPanel
            endpoint={endpoint}
            onSuccess={(status) => {
              setStatusAfterLogin(status);
              setStep('model');
            }}
          />
        )}

        {step === 'model' && (
          <EnterpriseModelPicker
            selected={statusAfterLogin?.selectedModel}
            submitLabel={t('enterprise.model.confirm')}
            onDone={() => setStep('done')}
          />
        )}

        {step === 'done' && (
          <div className="space-y-4 text-center">
            <CheckCircle2 className="w-10 h-10 mx-auto text-success" />
            <p className="text-sm text-text-muted">{t('enterprise.done.subtitle')}</p>
            <button type="button" className={`${primaryBtn} w-full`} onClick={onClose} autoFocus>
              {t('enterprise.done.start')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default EnterpriseOnboarding;
