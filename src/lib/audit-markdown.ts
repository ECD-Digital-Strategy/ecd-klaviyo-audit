/** Markdown-lite format used across audit copy: **bold**, *italic*, `type:entity`, newlines. */

import {
  ENTITY_CHIP_CLASS,
  ENTITY_LABELS,
  isInsideEntityMarkerAt,
  prepareAuditText,
  repairEntityMarkers,
  stripEntityMarkers,
  type EntityType,
} from './entity-tags';

const ENTITY_TYPES = ['flow', 'campaign', 'segment', 'form'] as const;

// A BARE url, not [label](href): markdown link syntax cannot survive the
// contentEditable round trip (auditTextToEditorHtml -> innerHTML -> htmlToMd),
// so a link written that way would be mangled the first time someone edited the
// block. A plain URL is just text on the way in and out, and only becomes an
// anchor when rendered, which is lossless.
const INLINE_MARKDOWN_REGEX =
  /(`(flow|campaign|segment|form):([^`]+)`|\*\*([^*]+?)\*\*|\*([^*]+?)\*|(https?:\/\/[^\s<>()\[\]]+))/g;

export type InlineMarkdownToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'entity'; entityType: EntityType; name: string }
  | { type: 'link'; href: string; value: string };

/** Fix legacy triple-asterisk bold markers (e.g. ***Why Upgrade:***) to standard **bold**. */
export function normalizeInlineMarkdown(text: string): string {
  if (!text) return text;

  return text.replace(/\*{3,}([^*\n]+?)\*{2,3}/g, '**$1**');
}

export function prepareAuditMarkdown(text: string): string {
  let result = normalizeInlineMarkdown(text || '');
  result = repairEntityMarkers(result);
  result = repairFlattenedMarkdown(result);
  return repairEntityMarkers(result);
}

export function tokenizeInlineMarkdown(text: string): InlineMarkdownToken[] {
  const normalized = normalizeInlineMarkdown(text);
  const tokens: InlineMarkdownToken[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  INLINE_MARKDOWN_REGEX.lastIndex = 0;
  while ((match = INLINE_MARKDOWN_REGEX.exec(normalized)) !== null) {
    if (match.index > last) {
      tokens.push({ type: 'text', value: normalized.slice(last, match.index) });
    }
    if (match[2] !== undefined && match[3] !== undefined) {
      tokens.push({ type: 'entity', entityType: match[2] as EntityType, name: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ type: 'bold', value: match[4] });
    } else if (match[5] !== undefined) {
      tokens.push({ type: 'italic', value: match[5] });
    } else if (match[6] !== undefined) {
      // Trailing sentence punctuation is not part of the URL.
      const raw = match[6];
      const trimmed = raw.replace(/[.,;:!?]+$/, '');
      tokens.push({ type: 'link', href: trimmed, value: trimmed });
      if (trimmed.length !== raw.length) {
        tokens.push({ type: 'text', value: raw.slice(trimmed.length) });
      }
    }
    last = INLINE_MARKDOWN_REGEX.lastIndex;
  }

  if (last < normalized.length) {
    tokens.push({ type: 'text', value: normalized.slice(last) });
  }

  return tokens;
}

/** Escape text for HTML. Stored copy is markdown, never HTML, so anything that
 * looks like a tag must land in the editor as text, not as live markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function entitySpan(type: EntityType, name: string): string {
  const label = ENTITY_LABELS[type];
  return `<span data-entity-type="${type}" class="${ENTITY_CHIP_CLASS[type]}" title="${label}">${escapeHtml(name)}</span>`;
}

export function mdToHtml(md: string): string {
  return markdownToEditorHtml(md);
}

/** Inline markdown to editor HTML. Every piece of text is escaped first; the
 * only tags in the output are the ones added here. */
export function inlineMdToHtml(md: string): string {
  return tokenizeInlineMarkdown(md)
    .map(token => {
      switch (token.type) {
        case 'entity':
          return entitySpan(token.entityType, token.name);
        case 'bold':
          return `<strong>${escapeHtml(token.value)}</strong>`;
        case 'italic':
          return `<em>${escapeHtml(token.value)}</em>`;
        case 'link':
          // Plain text while editing: an anchor here would come back through
          // htmlToMd as something other than the URL that went in.
          return escapeHtml(token.value);
        default:
          return escapeHtml(token.value);
      }
    })
    .join('');
}

/** Repair legacy content where bullet lines were saved without newlines between them. */
export function repairFlattenedMarkdown(text: string): string {
  if (!text?.trim()) return text || '';
  const bulletMarkers = text.match(/- /g)?.length ?? 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  if (bulletMarkers < 2 && newlines > 0) return text;

  let repaired = text;
  if (bulletMarkers >= 2 && newlines < bulletMarkers) {
    repaired = repaired.replace(/([^\n])- (?=[A-Za-z*])/g, (match, before, offset, whole) => {
      const splitAt = offset + String(before).length;
      if (isInsideEntityMarkerAt(whole, splitAt)) return match;
      return `${before}\n- `;
    });
  }
  repaired = repaired.replace(/([a-z.])(ECD Pricing:)/gi, '$1\n\n$2');
  repaired = repaired.replace(/(ECD Pricing:)- (?=[A-Za-z*])/g, '$1\n- ');
  return repaired.replace(/\n{3,}/g, '\n\n').trim();
}

/** Convert markdown blocks to HTML for contentEditable editors (lists, paragraphs, inline bold). */
export function markdownToEditorHtml(md: string): string {
  const normalized = prepareAuditMarkdown(md);
  const blocks = parseRichAuditBlocks(normalized);
  if (!blocks.length) return inlineMdToHtml(normalized);

  return blocks
    .map(block => {
      if (block.type === 'list') {
        const items = block.items.map(item => `<li>${inlineMdToHtml(item)}</li>`).join('');
        if (!block.ordered) return `<ul>${items}</ul>`;
        return block.start ? `<ol start="${block.start}">${items}</ol>` : `<ol>${items}</ol>`;
      }
      if (block.type === 'heading') {
        const tag = `h${Math.min(block.level, 3)}`;
        return `<${tag}>${inlineMdToHtml(block.text)}</${tag}>`;
      }
      if (block.type === 'table') {
        const head = block.header.map(cell => `<th>${inlineMdToHtml(cell)}</th>`).join('');
        const body = block.rows
          .map(row => `<tr>${row.map(cell => `<td>${inlineMdToHtml(cell)}</td>`).join('')}</tr>`)
          .join('');
        return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      }
      return `<div>${inlineMdToHtml(block.text)}</div>`;
    })
    .join('');
}

// &amp; goes last so an escaped entity ("&amp;lt;") decodes once, to "&lt;".
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function inlineHtmlToMd(html: string): string {
  let md = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<u>(.*?)<\/u>/gi, '$1')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(md);
}

/** Render a bullet string array as HTML for rich editors (admin templates). */
export function bulletsArrayToEditorHtml(bullets: string[]): string {
  const items = bullets
    .map(v => v.trim())
    .filter(Boolean)
    .map(bullet => `<li>${inlineMdToHtml(bullet)}</li>`);

  if (!items.length) return '';
  return `<ul>${items.join('')}</ul>`;
}

/** Parse rich-editor output back into a bullet string array. */
export function editorValueToBulletsArray(value: string): string[] {
  if (!value.trim()) return [];

  if (/<li[\s>]/i.test(value)) {
    return [...value.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(match => inlineHtmlToMd(match[1]).trim())
      .filter(Boolean);
  }

  return value
    .split('\n')
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}

export function auditTextToEditorHtml(
  text: string,
  lookup?: Map<string, EntityType>,
  autoTag = true,
  highlightsEnabled = true,
): string {
  if (!highlightsEnabled) {
    const plain = lookup?.size
      ? stripEntityMarkers(prepareAuditText(text || '', lookup, false))
      : stripEntityMarkers(text || '');
    return markdownToEditorHtml(plain);
  }
  const processed = lookup?.size ? prepareAuditText(text || '', lookup, autoTag) : (text || '');
  return markdownToEditorHtml(processed);
}

export function htmlToMd(html: string): string {
  let md = html;

  md = md.replace(
    /<span[^>]*data-entity-type="(flow|campaign|segment|form)"[^>]*>([\s\S]*?)<\/span>/gi,
    (_, type: EntityType, inner: string) => {
      const name = inner
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      return `\`${type}:${decodeHtmlEntities(name).trim()}\``;
    },
  );

  // Tables back to pipe markdown, before the generic tag stripping below would
  // flatten them into a run of bare words.
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, table: string) => {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(rowMatch =>
      [...rowMatch[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(cell =>
        inlineHtmlToMd(cell[1]).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(),
      ),
    );
    if (!rows.length) return '';
    const width = Math.max(...rows.map(r => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    const [header, ...body] = rows;
    return `\n${line(header)}\n| ${Array(width).fill('---').join(' | ')} |\n${body.map(line).join('\n')}\n`;
  });

  md = md.replace(
    /<ul[^>]*>([\s\S]*?)<\/ul>/gi,
    (_, inner: string) =>
      '\n' +
      [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map(match => `- ${inlineHtmlToMd(match[1]).trim()}`)
        .join('\n') +
      '\n',
  );

  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner: string) => {
    let n = 0;
    return (
      '\n' +
      [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map(match => `${(n += 1)}. ${inlineHtmlToMd(match[1]).trim()}`)
        .join('\n') +
      '\n'
    );
  });

  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `- ${inlineHtmlToMd(inner).trim()}\n`);

  // ATX headings from contentEditable formatBlock (<h1>-<h3>) back to Markdown.
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => {
    const hashes = '#'.repeat(Math.min(Number(lvl), 3));
    return `\n\n${hashes} ${inlineHtmlToMd(inner).trim()}\n\n`;
  });

  md = md
    .replace(/<\/(div|p|h[1-6]|blockquote|section|article|header|footer|tr)>/gi, '\n')
    .replace(/<(div|p|h[1-6]|blockquote|section|article|header|footer|tr)(\s[^>]*)?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<u>(.*?)<\/u>/gi, '$1')
    .replace(/<[^>]+>/g, '');
  md = decodeHtmlEntities(md)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return repairEntityMarkers(normalizeInlineMarkdown(md));
}

export type RichAuditBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  /** `start` is the first item's own number, so a list the source broke up still counts on. */
  | { type: 'list'; ordered: boolean; items: string[]; start?: number }
  | { type: 'table'; header: string[]; rows: string[][] };

/** `| a | b |` -> ['a', 'b'], tolerating missing outer pipes. */
function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim());
}

/** The `| --- | :--: |` separator that marks the line above as a header row. */
function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{1,}:?$/.test(cell));
}

/** Split markdown into headings (`#`), bullet lists (`- `), numbered lists (`1. `), pipe tables, and paragraphs. */
export function parseRichAuditBlocks(text: string): RichAuditBlock[] {
  const blocks: RichAuditBlock[] = [];
  let listItems: string[] | null = null;
  let listOrdered = false;
  let listStart = 1;

  const flushList = () => {
    if (listItems?.length) {
      blocks.push(
        listOrdered && listStart !== 1
          ? { type: 'list', ordered: true, items: listItems, start: listStart }
          : { type: 'list', ordered: listOrdered, items: listItems },
      );
      listItems = null;
    }
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) {
      // A blank line between items ("1. a", "", "2. b") is a loose list, not the
      // end of one. Flushing here restarted every item at 1.
      if (listItems) {
        let k = i + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        const next = k < lines.length ? lines[k].trim() : '';
        const nextIsSameList = listOrdered ? /^\d+\.\s+/.test(next) : /^[-*•]\s+/.test(next);
        if (nextIsSameList) continue;
      }
      flushList();
      continue;
    }

    // A pipe table: a header row, a `| --- |` separator, then body rows. Without
    // this the raw pipes render as ordinary paragraphs, one per line.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flushList();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const rowLine = lines[j].trim();
        if (!rowLine || !rowLine.includes('|')) break;
        const cells = splitTableRow(rowLine);
        // Pad or trim so every row matches the header width.
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
      }
      blocks.push({ type: 'table', header, rows });
      i = j - 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const ordered = /^\d+\.\s+/.test(line);
    const unordered = /^[-*•]\s+/.test(line);
    if (ordered || unordered) {
      if (listItems && listOrdered !== ordered) flushList();
      if (!listItems) {
        listItems = [];
        listOrdered = ordered;
        listStart = ordered ? parseInt(line, 10) || 1 : 1;
      }
      listItems.push(line.replace(ordered ? /^\d+\.\s+/ : /^[-*•]\s+/, '').trim());
      continue;
    }

    flushList();
    blocks.push({ type: 'paragraph', text: line });
  }

  flushList();
  return blocks;
}

export function hasRichAuditMarkup(text: string): boolean {
  if (/(<(b|strong|i|em|u|span)[>\s/])/i.test(text)) return true;
  if (/(\*\*|__|\*|_|~~)/.test(text)) return true;
  if (new RegExp(`\`(${ENTITY_TYPES.join('|')}):`).test(text)) return true;
  return false;
}
