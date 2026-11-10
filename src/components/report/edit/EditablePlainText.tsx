import { useEffect, useRef, useState } from 'react';
import { hasRichAuditMarkup, htmlToMd, auditTextToEditorHtml } from '../../../lib/audit-markdown';
import { isHighlightShortcut, toggleSelectionHighlight } from '../../../lib/entity-editor';
import { cn } from '../../../lib/utils';
import { renderInlineMarkdown } from '../../ui/RichAuditText';
import FloatingFormatToolbar, { useFloatingToolbarPosition } from './FloatingFormatToolbar';
import { useReportEdit } from './ReportEditContext';
import { useReportEntities } from './ReportEntityContext';
import { usePlatformSettings } from '../../../contexts/PlatformSettingsContext';

type EditablePlainTextProps = {
  value: string;
  onSave?: (value: string) => void;
  className?: string;
  as?: 'span' | 'h1' | 'h2' | 'h3' | 'h4' | 'p';
  placeholder?: string;
  rich?: boolean;
};

function hasRichMarkup(html: string) {
  return hasRichAuditMarkup(html);
}

export default function EditablePlainText({
  value,
  onSave,
  className,
  as: Tag = 'span',
  placeholder,
  rich = false,
}: EditablePlainTextProps) {
  const { editMode } = useReportEdit();
  const { entityLookup, autoTagEntities } = useReportEntities();
  const { entityHighlightsEnabled } = usePlatformSettings();
  const ref = useRef<HTMLElement>(null);
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  const isInternal = useRef(false);
  /** What we last sent upward, waiting for the parent to echo it back. */
  const pendingSave = useRef<string | null>(null);
  const toolbarPos = useFloatingToolbarPosition(ref, focused && rich);
  // A boolean rather than the callback itself: every caller passes an inline
  // arrow, so `onSave` is a new identity on every parent render, and having it
  // in the dependency list below made the effect re-run constantly.
  const canSave = Boolean(onSave);

  // Push the stored value into the contentEditable node.
  //
  // This used to run on every parent render and overwrite whatever was being
  // typed: adding a finding by hand and writing into it lost characters and
  // jumped the caret, because an autosave elsewhere re-rendered the page and
  // this effect reset innerHTML mid-sentence. Two guards now: never touch the
  // node while the caret is in it, and never write back a value the parent has
  // not caught up to yet.
  useEffect(() => {
    if (isInternal.current) {
      isInternal.current = false;
      return;
    }
    if (focused) return;
    if (pendingSave.current !== null && value !== pendingSave.current) return;
    pendingSave.current = null;
    setLocal(value);
    if (ref.current && editMode && canSave && rich) {
      ref.current.innerHTML = auditTextToEditorHtml(value, entityLookup, false, entityHighlightsEnabled);
    } else if (ref.current && editMode && canSave) {
      // Plain text: never parse a stored value as HTML.
      ref.current.textContent = value || '';
    }
  }, [value, editMode, canSave, rich, entityLookup, entityHighlightsEnabled, focused]);

  const canEdit = editMode && Boolean(onSave);

  const persist = () => {
    if (!ref.current || !onSave) return;
    const html = ref.current.innerHTML;
    const next = hasRichMarkup(html) ? htmlToMd(html) : (ref.current.textContent ?? '').trim();
    if (next !== value) onSave(next);
    // Remembered so the effect above can tell "the parent has not caught up
    // yet" from "the value genuinely changed elsewhere".
    pendingSave.current = next;
    isInternal.current = true;
    setLocal(next);
  };

  const exec = (cmd: string) => {
    document.execCommand(cmd, false);
    ref.current?.focus();
    persist();
  };

  const toggleHighlight = () => {
    if (toggleSelectionHighlight(ref.current, entityLookup)) {
      ref.current?.focus();
      persist();
    }
  };

  if (!canEdit) {
    if (rich) {
      return (
        <Tag className={className}>
          {renderInlineMarkdown(value, entityLookup, autoTagEntities, entityHighlightsEnabled)}
        </Tag>
      );
    }
    return <Tag className={className}>{value}</Tag>;
  }

  return (
    <>
      <Tag
        ref={ref as never}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        data-placeholder={placeholder}
        onFocus={() => {
          pendingSave.current = null;
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          persist();
        }}
        onKeyDown={e => {
          if (rich && entityHighlightsEnabled && isHighlightShortcut(e)) {
            e.preventDefault();
            toggleHighlight();
            return;
          }
          if (e.key === 'Escape') (e.target as HTMLElement).blur();
        }}
        className={cn(
          className,
          'outline-none rounded transition-shadow',
          'focus:ring-2 focus:ring-brand-primary/30 focus:ring-offset-1',
          'hover:ring-1 hover:ring-brand-primary/20 hover:ring-offset-1',
          'empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400',
          rich && '[&_.entity-tag]:pointer-events-none',
        )}
      >
        {hasRichAuditMarkup(local) ? undefined : local}
      </Tag>
      {rich && (
        <FloatingFormatToolbar
          visible={focused}
          top={toolbarPos.top}
          left={toolbarPos.left}
          onBold={() => exec('bold')}
          onItalic={() => exec('italic')}
          onHighlight={entityHighlightsEnabled ? toggleHighlight : undefined}
        />
      )}
    </>
  );
}
