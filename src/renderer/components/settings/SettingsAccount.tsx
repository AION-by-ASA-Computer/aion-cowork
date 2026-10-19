import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { EnterpriseError, EnterpriseStatus } from '../../../shared/enterprise-types';
import { getEnterpriseApi } from '../../utils/enterprise-api';
import { formatExpiry, getEnterpriseViewState } from '../../utils/enterprise-helpers';
import { setEnterpriseStatus, useEnterpriseStatus } from '../../hooks/useEnterpriseStatus';
import {
  EnterpriseLoginPanel,
  EnterpriseModelPicker,
  EnterpriseOnboarding,
  describeEnterpriseError,
} from '../EnterpriseOnboarding';
import { SettingsContentSection } from './shared';

const primaryBtn =
  'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors';
const secondaryBtn =
  'inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border-subtle text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 transition-colors';
const dangerBtn =
  'inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-error/30 text-sm text-error hover:bg-error/5 disabled:opacity-50 transition-colors';

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-text-muted flex-shrink-0">{label}</span>
      <span className="text-text-primary text-right break-all select-text">{value || '-'}</span>
    </div>
  );
}

export function SettingsAccount() {
  const { t, i18n } = useTranslation();
  const { status, reload } = useEnterpriseStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<EnterpriseError | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const api = getEnterpriseApi();
  const view = getEnterpriseViewState(status);

  const act = async (name: string, fn: () => Promise<void>) => {
    if (!api || busy) return;
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError({ code: 'unexpected', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const refresh = () =>
    act('refresh', async () => {
      const res = await api!.refresh();
      if (res.ok) {
        setEnterpriseStatus(res.data);
        setNotice(t('enterprise.account.refreshed'));
      } else {
        setError(res.error);
        void reload();
      }
    });

  const logout = () =>
    act('logout', async () => {
      setEnterpriseStatus(await api!.logout());
    });

  const disconnect = () =>
    act('disconnect', async () => {
      setEnterpriseStatus(await api!.disconnect());
      setConfirmDisconnect(false);
    });

  if (!api) {
    return <p className="py-5 text-sm text-text-muted">{t('enterprise.account.unavailable')}</p>;
  }

  if (!status) {
    return (
      <div className="py-5 flex items-center gap-2 text-sm text-text-muted" role="status">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  const isEnterprise = status.mode === 'enterprise';
  const modeLabel = isEnterprise
    ? t('enterprise.account.modeEnterprise')
    : t('enterprise.account.modeStandalone');

  return (
    <div>
      <SettingsContentSection
        title={t('enterprise.account.connection')}
        description={t('enterprise.account.connectionDesc')}
      >
        <div className="rounded-lg border border-border-subtle px-4 py-2 divide-y divide-border-muted">
          <Row label={t('enterprise.account.mode')} value={modeLabel} />
          {isEnterprise && (
            <>
              <Row label={t('enterprise.account.endpoint')} value={status.endpoint} />
              <Row
                label={t('enterprise.account.user')}
                value={
                  status.loggedIn
                    ? status.user?.displayName || status.user?.identifier
                    : t('enterprise.account.notLoggedIn')
                }
              />
              <Row
                label={t('enterprise.account.expiresAt')}
                value={formatExpiry(status.expiresAt, i18n.language)}
              />
              <Row label={t('enterprise.account.serverVersion')} value={status.serverVersion} />
              <Row label={t('enterprise.account.model')} value={status.selectedModel} />
            </>
          )}
        </div>
        {notice && (
          <p role="status" className="text-xs text-success">
            {notice}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-sm text-error"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="break-words">{describeEnterpriseError(t, error)}</span>
          </div>
        )}
      </SettingsContentSection>

      {!isEnterprise && (
        <SettingsContentSection
          title={t('enterprise.account.connectTitle')}
          description={t('enterprise.account.connectDesc')}
        >
          <button type="button" className={primaryBtn} onClick={() => setShowWizard(true)}>
            {t('enterprise.account.connect')}
          </button>
        </SettingsContentSection>
      )}

      {isEnterprise && (view === 'session-expired' || view === 'logged-out') && (
        <SettingsContentSection
          title={
            view === 'session-expired'
              ? t('enterprise.account.sessionExpiredTitle')
              : t('enterprise.account.loginTitle')
          }
          description={
            view === 'session-expired' ? t('enterprise.account.sessionExpiredDesc') : undefined
          }
        >
          <div className="max-w-sm">
            <EnterpriseLoginPanel
              endpoint={status.endpoint ?? ''}
              initialUsername={status.user?.identifier ?? ''}
              onSuccess={(s: EnterpriseStatus) => setEnterpriseStatus(s)}
            />
          </div>
        </SettingsContentSection>
      )}

      {isEnterprise && view === 'must-change-password' && (
        <SettingsContentSection title={t('enterprise.changePassword.title')}>
          <div className="max-w-sm">
            <EnterpriseLoginPanel
              endpoint={status.endpoint ?? ''}
              startAtChangePassword
              onSuccess={(s: EnterpriseStatus) => setEnterpriseStatus(s)}
            />
          </div>
        </SettingsContentSection>
      )}

      {isEnterprise && view === 'connected' && (
        <SettingsContentSection title={t('enterprise.account.actions')}>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryBtn}
              onClick={() => void refresh()}
              disabled={busy !== null}
            >
              {busy === 'refresh' && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('enterprise.account.refresh')}
            </button>
            <button
              type="button"
              className={secondaryBtn}
              onClick={() => setShowModelPicker((v) => !v)}
              disabled={busy !== null}
              aria-expanded={showModelPicker}
            >
              {t('enterprise.account.changeModel')}
            </button>
            <button
              type="button"
              className={secondaryBtn}
              onClick={() => void logout()}
              disabled={busy !== null}
            >
              {busy === 'logout' && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('enterprise.account.logout')}
            </button>
          </div>
          {showModelPicker && (
            <div className="max-w-md rounded-lg border border-border-subtle p-4">
              <EnterpriseModelPicker
                selected={status.selectedModel}
                submitLabel={t('common.save')}
                onCancel={() => setShowModelPicker(false)}
                onDone={() => {
                  setShowModelPicker(false);
                  setNotice(t('enterprise.account.modelChanged'));
                }}
              />
            </div>
          )}
        </SettingsContentSection>
      )}

      {isEnterprise && (
        <SettingsContentSection
          title={t('enterprise.account.disconnectTitle')}
          description={t('enterprise.account.disconnectDesc')}
        >
          {confirmDisconnect ? (
            <div
              role="alertdialog"
              aria-label={t('enterprise.account.disconnectTitle')}
              className="rounded-lg border border-error/20 bg-error/5 p-4 space-y-3"
            >
              <p className="text-sm text-text-primary">
                {t('enterprise.account.disconnectConfirm')}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={secondaryBtn}
                  onClick={() => setConfirmDisconnect(false)}
                  disabled={busy !== null}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className={dangerBtn}
                  onClick={() => void disconnect()}
                  disabled={busy !== null}
                >
                  {busy === 'disconnect' && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('enterprise.account.disconnect')}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className={dangerBtn} onClick={() => setConfirmDisconnect(true)}>
              {t('enterprise.account.disconnect')}
            </button>
          )}
        </SettingsContentSection>
      )}

      {showWizard && (
        <EnterpriseOnboarding initialStep="endpoint" force onClose={() => setShowWizard(false)} />
      )}
    </div>
  );
}
