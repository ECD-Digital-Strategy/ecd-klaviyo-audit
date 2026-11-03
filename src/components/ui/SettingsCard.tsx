import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * A settings section: icon, title and a line of explanation in the header, the
 * fields below. Collapsible ones (Proposal settings, 2026-11-02) fold to the
 * header, and remember open or closed per browser under storageKey.
 */
export default function SettingsCard({
  icon,
  title,
  description,
  badge,
  action,
  control,
  collapsible = false,
  defaultOpen = true,
  storageKey,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  /** A small status pill next to the title (e.g. "Sending off"). */
  badge?: ReactNode;
  /** A button on the right of the header; shown only while open. */
  action?: ReactNode;
  /** A control on the right of the header, shown open or folded (e.g. an on/off switch). */
  control?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  storageKey?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    if (!collapsible) return true;
    try {
      const saved = storageKey ? localStorage.getItem(storageKey) : null;
      return saved === null ? defaultOpen : saved === '1';
    } catch {
      return defaultOpen;
    }
  });

  const toggle = () => {
    setOpen(o => {
      try {
        if (storageKey) localStorage.setItem(storageKey, o ? '0' : '1');
      } catch {
        // private mode: remembering is a nicety
      }
      return !o;
    });
  };

  const heading = (
    <>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-brand-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1 text-left">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-900">
          {title}
          {badge}
        </h3>
        {description && <p className="text-xs text-gray-500">{description}</p>}
      </div>
    </>
  );

  return (
    <section className="overflow-hidden rounded-xl bg-white card-shadow">
      <div className={cn('flex items-center gap-3 bg-gray-50/60 px-5 py-4', open && 'border-b border-gray-100')}>
        {collapsible ? (
          <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3">
            {heading}
            <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform', open && 'rotate-180')} />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{heading}</div>
        )}
        {open && action}
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {open && children}
    </section>
  );
}
