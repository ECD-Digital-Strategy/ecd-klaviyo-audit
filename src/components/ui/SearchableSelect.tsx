import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../../lib/utils';

export type SearchableOption = {
  value: string;
  label: string;
  /** Extra words that match a search but are not shown (a code, an account). */
  keywords?: string;
};

/**
 * A dropdown with a search box, for lists too long to scroll (Xero's Items).
 * Looks like the app's Select; the menu is portalled and placed below or above
 * the trigger, whichever has room, so it is never cut off by a card. Arrow keys
 * move, Enter picks, Escape closes.
 */
export default function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = 'Choose',
  searchPlaceholder = 'Search',
  noneLabel,
  size = 'md',
  invalid = false,
  disabled = false,
  className,
}: {
  value: string | null | undefined;
  options: SearchableOption[];
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** When set, a first option that clears the value. */
  noneLabel?: string;
  size?: 'sm' | 'md';
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find(o => o.value === value);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = words.length
      ? options.filter(o => {
          const hay = `${o.label} ${o.keywords ?? ''}`.toLowerCase();
          return words.every(w => hay.includes(w));
        })
      : options;
    return noneLabel && !words.length ? [{ value: '', label: noneLabel }, ...matches] : matches;
  }, [options, query, noneLabel]);

  // Placed against the trigger each time it opens, on the side with room.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 240 && above > below;
      const width = Math.min(Math.max(r.width, 260), window.innerWidth - 32);
      const left = Math.min(Math.max(16, r.left), window.innerWidth - width - 16);
      setPlace({ top: up ? r.top - 4 : r.bottom + 4, left, width, maxHeight: Math.min(320, up ? above : below), up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, shown.findIndex(o => o.value === (value ?? ''))));
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    const outside = (e: MouseEvent) => {
      const t2 = e.target as Node;
      if (!menuRef.current?.contains(t2) && !triggerRef.current?.contains(t2)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', outside);
    };
    // Only on opening: the active row resets while the search is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (v: string) => {
    onChange(v || null);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-200 bg-white px-3 text-gray-900',
          'focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary',
          'disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-8 text-xs' : 'h-10 text-sm',
          invalid && 'border-amber-400 ring-1 ring-amber-200',
          className,
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate text-left', !selected && 'text-gray-400')}>
          {selected ? selected.label : value ? value : placeholder}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </button>
      {open && place && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          onKeyDown={onKey}
          style={{
            position: 'fixed',
            left: place.left,
            width: place.width,
            ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }),
            maxHeight: place.maxHeight,
          }}
          className={cn('z-[60] flex flex-col overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg', place.up && 'flex-col-reverse')}
        >
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
            />
          </div>
          <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
            {shown.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">No matches</li>}
            {shown.map((o, i) => (
              <li
                key={o.value || '__none__'}
                data-index={i}
                role="option"
                aria-selected={o.value === (value ?? '')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(o.value)}
                className={cn(
                  'relative flex cursor-pointer select-none items-center rounded-lg py-2 pl-8 pr-2 text-sm text-gray-700',
                  i === active && 'bg-brand-primary/5 text-gray-900',
                  !o.value && 'text-gray-400',
                )}
              >
                {o.value === (value ?? '') && o.value && (
                  <Check className="absolute left-2 h-4 w-4 text-brand-primary" />
                )}
                {o.label}
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
