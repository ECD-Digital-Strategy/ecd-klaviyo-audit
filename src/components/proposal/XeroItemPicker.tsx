import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { listXeroItems, type XeroItem } from '../../lib/xero';
import { cn } from '../../lib/utils';

const NONE = '__none__';

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
  // A code saved earlier that Xero no longer lists still shows, so it can be seen and replaced.
  const known = !value || items.some(i => i.code === value);
  return (
    <Select value={value || NONE} onValueChange={v => onChange(v === NONE ? null : v)}>
      <SelectTrigger className={cn(size === 'sm' ? 'h-8 text-xs' : 'h-10 text-sm', invalid && 'border-amber-400 ring-1 ring-amber-200')}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <SelectItemText>{placeholder}</SelectItemText>
        </SelectItem>
        {!known && value && (
          <SelectItem value={value}>
            <SelectItemText>{value} (not in Xero)</SelectItemText>
          </SelectItem>
        )}
        {items.map(item => (
          <SelectItem key={item.code} value={item.code}>
            <SelectItemText>{item.code} · {item.name}</SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
