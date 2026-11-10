import { useRef, useCallback, useEffect } from 'react';
import { Bold, Heading1, Heading2, Heading3, Highlighter, Italic, ListOrdered, Pilcrow, Underline, List } from 'lucide-react';
import { htmlToMd, auditTextToEditorHtml, markdownToEditorHtml } from '../../lib/audit-markdown';
import { HIGHLIGHT_SHORTCUT_LABEL, isHighlightShortcut, toggleSelectionHighlight } from '../../lib/entity-editor';
import type { EntityType } from '../../lib/entity-tags';
import { usePlatformSettings } from '../../contexts/PlatformSettingsContext';

interface SimpleRichEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  entityTags?: boolean;
  entityLookup?: Map<string, EntityType>;
  autoTagEntities?: boolean;
  /** Show heading + numbered-list controls (for document-style bodies). */
  richBlocks?: boolean;
}

export default function SimpleRichEditor({
  value,
  onChange,
  rows = 4,
  placeholder,
  entityTags = true,
  entityLookup,
  richBlocks = false,
}: SimpleRichEditorProps) {
  const { entityHighlightsEnabled } = usePlatformSettings();
  const editorRef = useRef<HTMLDivElement>(null);
  const isInternalUpdate = useRef(false);

  useEffect(() => {
    if (!editorRef.current || isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    // Safe to assign as HTML: both converters escape all stored text and only
    // add their own formatting tags.
    const html = entityTags
      ? auditTextToEditorHtml(value || '', entityLookup, false, entityHighlightsEnabled)
      : markdownToEditorHtml(value || '');
    if (editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html;
    }
  }, [value, entityTags, entityLookup, entityHighlightsEnabled]);

  const handleInput = useCallback(() => {
    if (!editorRef.current) return;
    isInternalUpdate.current = true;
    const md = htmlToMd(editorRef.current.innerHTML);
    onChange(md);
  }, [onChange]);

  const exec = useCallback((cmd: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false);
    handleInput();
  }, [handleInput]);

  const formatBlock = useCallback((tag: string) => {
    editorRef.current?.focus();
    document.execCommand('formatBlock', false, tag);
    handleInput();
  }, [handleInput]);

  const toggleHighlight = useCallback(() => {
    if (!entityLookup?.size) return;
    if (toggleSelectionHighlight(editorRef.current, entityLookup)) {
      editorRef.current?.focus();
      handleInput();
    }
  }, [entityLookup, handleInput]);

  const minH = Math.max(rows * 24, 72);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden focus-within:border-brand-primary focus-within:ring-1 focus-within:ring-brand-primary/20 transition-colors">
      <div className="flex items-center gap-0.5 px-2 py-1 bg-gray-50 border-b border-gray-200 flex-wrap">
        <ToolbarBtn onClick={() => exec('bold')} title="Bold (Ctrl+B)">
          <Bold className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn onClick={() => exec('italic')} title="Italic (Ctrl+I)">
          <Italic className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn onClick={() => exec('underline')} title="Underline (Ctrl+U)">
          <Underline className="w-3.5 h-3.5" />
        </ToolbarBtn>
        {richBlocks && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <ToolbarBtn onClick={() => formatBlock('<h1>')} title="Heading 1">
              <Heading1 className="w-3.5 h-3.5" />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => formatBlock('<h2>')} title="Heading 2">
              <Heading2 className="w-3.5 h-3.5" />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => formatBlock('<h3>')} title="Heading 3">
              <Heading3 className="w-3.5 h-3.5" />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => formatBlock('<p>')} title="Normal text">
              <Pilcrow className="w-3.5 h-3.5" />
            </ToolbarBtn>
          </>
        )}
        <div className="w-px h-4 bg-gray-200 mx-1" />
        <ToolbarBtn onClick={() => exec('insertUnorderedList')} title="Bullet list">
          <List className="w-3.5 h-3.5" />
        </ToolbarBtn>
        {richBlocks && (
          <ToolbarBtn onClick={() => exec('insertOrderedList')} title="Numbered list">
            <ListOrdered className="w-3.5 h-3.5" />
          </ToolbarBtn>
        )}
        {entityTags && entityLookup && entityLookup.size > 0 && entityHighlightsEnabled && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <ToolbarBtn
              onClick={toggleHighlight}
              title={`Highlight Klaviyo flow, segment, or campaign (${HIGHLIGHT_SHORTCUT_LABEL})`}
            >
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold">
                <Highlighter className="w-3 h-3" />
                Highlight
              </span>
            </ToolbarBtn>
          </>
        )}
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={e => {
          if (
            entityTags &&
            entityHighlightsEnabled &&
            entityLookup?.size &&
            isHighlightShortcut(e)
          ) {
            e.preventDefault();
            toggleHighlight();
          }
        }}
        data-placeholder={placeholder}
        className="px-3 py-2 text-sm text-gray-800 leading-relaxed outline-none [&_strong]:font-semibold [&_em]:italic [&_u]:underline [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4 [&_li]:mb-0.5 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:text-gray-900 [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-gray-900 [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-gray-900 [&_h3]:mt-2 [&_h3]:mb-1 empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 [&_.entity-tag]:pointer-events-none"
        style={{ minHeight: minH, maxHeight: 400, overflowY: 'auto' }}
      />
    </div>
  );
}

function ToolbarBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      title={title}
      className="p-1.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
    >
      {children}
    </button>
  );
}
