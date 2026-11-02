import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** The app's on/off switch (the same look as Platform report settings). */
export default function ToggleSwitch({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/30 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-primary' : 'bg-gray-200',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/** A setting with a switch: title, a line of explanation, and anything under it. */
export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  children,
}: {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{title}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{description}</p>}
        {children}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} aria-label={title} />
    </div>
  );
}
