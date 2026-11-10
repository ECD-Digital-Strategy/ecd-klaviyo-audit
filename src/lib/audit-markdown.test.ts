/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  bulletsArrayToEditorHtml,
  editorValueToBulletsArray,
  htmlToMd,
  inlineMdToHtml,
  markdownToEditorHtml,
  parseRichAuditBlocks,
  prepareAuditMarkdown,
  tokenizeInlineMarkdown,
} from './audit-markdown';

describe('inlineMdToHtml escaping', () => {
  it('escapes raw HTML in plain text', () => {
    expect(inlineMdToHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes inside bold and italic but keeps the formatting tags', () => {
    expect(inlineMdToHtml('**<script>x</script>** and *"q" & \'s\'*')).toBe(
      '<strong>&lt;script&gt;x&lt;/script&gt;</strong> and <em>&quot;q&quot; &amp; &#39;s&#39;</em>',
    );
  });

  it('escapes entity chip names so they cannot break out of the span', () => {
    const html = inlineMdToHtml('`flow:a"><img src=x onerror=1>`');
    expect(html).not.toContain('<img');
    expect(html).toContain('a&quot;&gt;&lt;img src=x onerror=1&gt;');
  });

  it('keeps bare URLs as escaped text', () => {
    expect(inlineMdToHtml('see https://x.com/a?b=1&c=2.')).toBe('see https://x.com/a?b=1&amp;c=2.');
  });

  it('escapes block content in lists, headings and tables', () => {
    const html = markdownToEditorHtml('# <b>h</b>\n- <i>x</i>\n\n| <a> | b |\n| --- | --- |\n| <c> | d |');
    expect(html).not.toMatch(/<(b|i|a|c)>/);
    expect(html).toContain('<h1>&lt;b&gt;h&lt;/b&gt;</h1>');
    expect(html).toContain('<li>&lt;i&gt;x&lt;/i&gt;</li>');
  });

  it('round-trips escaped text back to the same markdown', () => {
    const md = 'Use <b> & "quotes" it\'s **bold <x>** fine';
    expect(htmlToMd(markdownToEditorHtml(md))).toBe(md);
    expect(editorValueToBulletsArray(bulletsArrayToEditorHtml(['a < b & "c"']))).toEqual(['a < b & "c"']);
  });
});

describe('parseRichAuditBlocks numbered lists', () => {
  it('keeps counting when items are separated by blank lines', () => {
    const blocks = parseRichAuditBlocks('Gaps:\n\n1. **SEO.** Big one.\n\n2. **Paid media.** Clean.\n\n3. **Phone orders.** Clarify.');
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Gaps:' },
      { type: 'list', ordered: true, items: ['**SEO.** Big one.', '**Paid media.** Clean.', '**Phone orders.** Clarify.'] },
    ]);
  });

  it('continues from the source number when prose splits a list', () => {
    const blocks = parseRichAuditBlocks('1. First\n2. Second\n\nAside.\n\n3. Third');
    expect(blocks[2]).toEqual({ type: 'list', ordered: true, items: ['Third'], start: 3 });
  });

  it('still ends a list at a blank line followed by prose', () => {
    const blocks = parseRichAuditBlocks('- a\n- b\n\nAfter.');
    expect(blocks).toEqual([
      { type: 'list', ordered: false, items: ['a', 'b'] },
      { type: 'paragraph', text: 'After.' },
    ]);
  });
});

describe('prepareAuditMarkdown', () => {
  it('repairs entity markers split across bullet newlines inside campaign names', () => {
    const broken =
      '**Operational duplication** `campaign:MM | Community Roundup\n- June 08`, `campaign:MM | Community Roundup\n- June 08 (clone)`, and noise.';
    const repaired = prepareAuditMarkdown(broken);

    expect(repaired).toContain('`campaign:MM | Community Roundup - June 08`');
    expect(repaired).toContain('`campaign:MM | Community Roundup - June 08 (clone)`');
    expect(repaired).not.toMatch(/Roundup\n- June/);

    const tokens = tokenizeInlineMarkdown(repaired);
    const entities = tokens.filter(token => token.type === 'entity');
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({
      type: 'entity',
      entityType: 'campaign',
      name: 'MM | Community Roundup - June 08',
    });
  });

  it('does not split hyphenated campaign names inside entity markers', () => {
    const input =
      'Recent sends include `campaign:MM | Summer Solstice Wellness Hacks - June 13` and `campaign:Smart Burn (Backup) | 6/18`.';
    const repaired = prepareAuditMarkdown(input);

    expect(repaired).not.toMatch(/Hacks\n- June/);
    expect(tokenizeInlineMarkdown(repaired).filter(token => token.type === 'entity')).toHaveLength(2);
  });
});
