import { useCallback, useEffect, useRef, useState } from 'react';
import { htmlToMd, auditTextToEditorHtml } from '../../../lib/audit-markdown';
import { cn } from '../../../lib/utils';
import { RichAuditContent } from '../../ui/RichAuditText';
import FloatingFormatToolbar, { useFloatingToolbarPosition } from '../../report/edit/FloatingFormatToolbar';
import { useProposalEdit } from './ProposalEditContext';

type ProposalRichTextProps = {
  value: string;
  onSave?: (value: string) => void;
  className?: string;
  placeholder?: string;
};

/**
 * Markdown rich-text renderer/editor for proposal documents. Same
 * contentEditable mechanics as the report's EditableRichText, but reads
 * ProposalEditContext and has no audit entity coupling.
 */
export default function ProposalRichText({
  value,
  onSave,
  className,
  placeholder,
}: ProposalRichTextProps) {
  const { editMode } = useProposalEdit();
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
    const html = auditTextToEditorHtml(value || '', undefined, false, false);
    if (editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html;
    }
  }, [value, canEdit]);

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

  if (!canEdit) {
    return <RichAuditContent text={value} className={className} autoTagEntities={false} />;
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
          if (e.key === 'Escape') editorRef.current?.blur();
        }}
        className={cn(
          className,
          'outline-none rounded-md transition-shadow',
          'ring-0 focus:ring-2 focus:ring-brand-primary/30 focus:ring-offset-1',
          'hover:ring-1 hover:ring-brand-primary/20 hover:ring-offset-1',
          'empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 empty:before:pointer-events-none',
          '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-2',
        )}
      />
      <FloatingFormatToolbar
        visible={focused}
        top={toolbarPos.top}
        left={toolbarPos.left}
        onBold={() => exec('bold')}
        onItalic={() => exec('italic')}
        onList={() => exec('insertUnorderedList')}
      />
    </>
  );
}
