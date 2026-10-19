import { useTranslation } from 'react-i18next';
import { UserCog } from 'lucide-react';
import { useManagedProfiles } from '../hooks/useManagedProfiles';
import { getProfileLabel } from '../utils/enterprise-profiles';

/** Small badge with the managed profile of a session; renders nothing without a profileId. */
export function ProfileBadge({ profileId }: { profileId?: string }) {
  const { t } = useTranslation();
  const { profiles } = useManagedProfiles();
  if (!profileId) return null;
  const label = getProfileLabel(profileId, profiles);
  return (
    <span
      className="inline-flex items-center gap-1 max-w-[10rem] px-2 py-0.5 rounded-full bg-accent/10 text-accent text-[11px] font-medium normal-case tracking-normal"
      title={t('profile.badgeTitle', { name: label })}
    >
      <UserCog className="w-3 h-3 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
