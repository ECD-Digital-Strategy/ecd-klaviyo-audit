import { useCallback, useEffect, useRef, useState } from 'react';
import { htmlToMd, auditTextToEditorHtml } from '../../../lib/audit-markdown';
import { isHighlightShortcut, toggleSelectionHighlight } from '../../../lib/entity-editor';
import { cn } from '../../../lib/utils';
import { RichAuditContent } from '../../ui/RichAuditText';
import FloatingFormatToolbar, { useFloatingToolbarPosition } from './FloatingFormatToolbar';
import { useReportEdit } from './ReportEditContext';
import { useReportEntities } from './ReportEntityContext';
import { usePlatformSettings } from '../../../contexts/PlatformSettingsContext';

type EditableRichTextProps = {
  value: string;
  onSave?: (value: string) => void;
  className?: string;
  placeholder?: string;
  singleLine?: boolean;
};

export default function EditableRichText({
  value,
  onSave,
  className,
  placeholder,
  singleLine,
}: EditableRichTextProps) {
  const { editMode } = useReportEdit();
  const { entityLookup, autoTagEntities } = useReportEntities();
  const { entityHighlightsEnabled } = usePlatformSettings();
  const editorRef = useRef<HTMLDivElement>(null);
  const isInternalUpdate = useRef(false);
  const [focused, setFocused] = useState(false);
  const toolbarPos = useFloatingToolbarPosition(editorRef, focused);

  const canEdit = editMode && Boolean(onSave);

  useEffect(() => {
    if (!canEdit || !editorRef.current || isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    // Safe to assign as HTML: auditTextToEditorHtml escapes all stored text and
    // only adds its own formatting tags.
    const html = auditTextToEditorHtml(value || '', entityLookup, false, entityHighlightsEnabled);
    if (editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html;
    }
  }, [value, canEdit, entityLookup, entityHighlightsEnabled]);

  const persist = useCallback(() => {
    if (!editorRef.current || !onSave) return;
    isInternalUpdate.current = true;
    onSave(htmlToMd(editorRef.current.innerHTML));
  }, [onSave]);

  const exec = (cmd: string) => {
    document.execCommand(cmd, false);
    editorRef.current?.focus();
    persist();
  };

  const toggleHighlight = () => {
    if (toggleSelectionHighlight(editorRef.current, entityLookup)) {
      editorRef.current?.focus();
      persist();
    }
  };

  if (!canEdit) {
    return (
      <RichAuditContent
        text={value}
        className={className}
        entityLookup={entityLookup}
        autoTagEntities={autoTagEntities}
      />
    );
  }

  return (
    <>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        data-placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          persist();
        }}
        onInput={persist}
        onKeyDown={e => {
          if (entityHighlightsEnabled && isHighlightShortcut(e)) {
            e.preventDefault();
            toggleHighlight();
            return;
          }
          if (singleLine && e.key === 'Enter') {
            e.preventDefault();
            editorRef.current?.blur();
          }
          if (e.key === 'Escape') editorRef.current?.blur();
        }}
        className={cn(
          className,
          'outline-none rounded-md transition-shadow',
          'ring-0 focus:ring-2 focus:ring-brand-primary/30 focus:ring-offset-1',
          'hover:ring-1 hover:ring-brand-primary/20 hover:ring-offset-1',
          'empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 empty:before:pointer-events-none',
          '[&_.entity-tag]:pointer-events-none',
          '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-2',
        )}
      />
      <FloatingFormatToolbar
        visible={focused}
        top={toolbarPos.top}
        left={toolbarPos.left}
        onBold={() => exec('bold')}
        onItalic={() => exec('italic')}
        onHighlight={entityHighlightsEnabled ? toggleHighlight : undefined}
        onList={() => exec('insertUnorderedList')}
      />
    </>
  );
}
