import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';

/**
 * A bar that floats at the bottom of the screen while a form has unsaved changes
 * (Emil, 2026-11-03: the Save button at the top of a long settings page is easy
 * to miss). Shows Discard and Save, and the browser asks before leaving the page
 * with changes unsaved. Use it on any page whose edits only stick on Save.
 */
export default function UnsavedChangesBar({
  show,
  saving = false,
  onSave,
  onDiscard,
  message = 'You have unsaved changes',
}: {
  show: boolean;
  saving?: boolean;
  onSave: () => void;
  /** Puts the form back as it was saved. Omit to hide Discard. */
  onDiscard?: () => void;
  message?: string;
}) {
  // Leaving or reloading the page with unsaved changes asks first.
  useEffect(() => {
    if (!show) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [show]);

  if (!show) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-lg ring-1 ring-black/5 animate-slide-up"
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">{message}</p>
        {onDiscard && (
          <button
            type="button"
            disabled={saving}
            onClick={onDiscard}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800 disabled:opacity-50"
          >
            Discard
          </button>
        )}
        <button
          type="button"
          disabled={saving}
          onClick={onSave}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
