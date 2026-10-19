import { useEffect, useState } from 'react';
import SearchableSelect from '../ui/SearchableSelect';
import { listXeroItems, type XeroItem } from '../../lib/xero';
import { cn } from '../../lib/utils';

/** Xero's sold Items, loaded once and shared by every picker on the page. */
export function useXeroItems(): { items: XeroItem[] | null; error: string } {
  const [items, setItems] = useState<XeroItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    listXeroItems()
      .then(rows => { if (!cancelled) setItems(rows); })
      .catch(e => {
        if (cancelled) return;
        setItems([]);
        setError(e instanceof Error ? e.message : 'Could not load the Xero Items');
      });
    return () => { cancelled = true; };
  }, []);
  return { items, error };
}

/** Pick the Xero Item a one-time or monthly price is invoiced as. */
export default function XeroItemPicker({
  value,
  items,
  onChange,
  placeholder = 'Choose a Xero Item',
  invalid = false,
  size = 'md',
}: {
  value: string | null | undefined;
  items: XeroItem[] | null;
  onChange: (code: string | null) => void;
  placeholder?: string;
  /** Required and missing: outlined so it is the thing to fix. */
  invalid?: boolean;
  size?: 'sm' | 'md';
}) {
  if (items === null) {
    return <div className={cn('animate-pulse rounded-lg bg-gray-100', size === 'sm' ? 'h-8' : 'h-10')} />;
  }
  const options = items.map(item => ({
    value: item.code,
    label: `${item.code} · ${item.name}`,
    keywords: item.account ?? '',
  }));
  // A code saved earlier that Xero no longer lists still shows, so it can be seen and replaced.
  if (value && !items.some(i => i.code === value)) options.unshift({ value, label: `${value} (not in Xero)`, keywords: '' });
  return (
    <SearchableSelect
      value={value}
      options={options}
      onChange={onChange}
      placeholder={placeholder}
      searchPlaceholder="Search Items by name or code"
      noneLabel={placeholder}
      size={size}
      invalid={invalid}
    />
  );
}
