import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, UserCog } from 'lucide-react';
import type { ManagedProfile } from '../../shared/enterprise-sync-types';

interface Props {
  profiles: ManagedProfile[];
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}

/** Compact profile dropdown for the new-chat box. Hidden when there are no profiles. */
export function ProfileSelector({ profiles, selectedSlug, onSelect }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (profiles.length === 0) return null;
  const selected = profiles.find((p) => p.slug === selectedSlug) ?? null;

  const choose = (slug: string | null) => {
    onSelect(slug);
    setOpen(false);
  };
  const itemCls = (active: boolean) =>
    `w-full flex items-start gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover ${
      active ? 'text-text-primary' : 'text-text-secondary'
    }`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.description || t('profile.selectorTitle')}
        className={`flex items-center gap-2 text-sm transition-colors ${
          selected ? 'text-accent' : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <UserCog className="w-4 h-4" />
        <span className="max-w-[10rem] truncate">{selected?.name ?? t('profile.none')}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t('profile.selectorTitle')}
          className="absolute bottom-full left-0 mb-2 z-20 w-72 max-h-72 overflow-y-auto rounded-xl border border-border-subtle bg-background shadow-lg py-1"
        >
          <button
            type="button"
            role="option"
            aria-selected={!selected}
            className={itemCls(!selected)}
            onClick={() => choose(null)}
          >
            <Check className={`w-4 h-4 mt-0.5 flex-shrink-0 ${selected ? 'invisible' : ''}`} />
            <span>
              <span className="block">{t('profile.none')}</span>
              <span className="block text-xs text-text-muted">{t('profile.noneDesc')}</span>
            </span>
          </button>
          {profiles.map((p) => (
            <button
              key={p.slug}
              type="button"
              role="option"
              aria-selected={p.slug === selectedSlug}
              title={p.description}
              className={itemCls(p.slug === selectedSlug)}
              onClick={() => choose(p.slug)}
            >
              <Check
                className={`w-4 h-4 mt-0.5 flex-shrink-0 ${p.slug === selectedSlug ? '' : 'invisible'}`}
              />
              <span className="min-w-0">
                <span className="block truncate">{p.name}</span>
                {p.description && (
                  <span className="block text-xs text-text-muted line-clamp-2">
                    {p.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
