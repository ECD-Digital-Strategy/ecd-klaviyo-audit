/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  materializeSectionKeyFindingsHidden,
  normalizeWorkspaceSectionKeyFindings,
  resolveSectionKeyFindings,
} from './section-key-findings';

describe('section-key-findings', () => {
  it('does not merge a lowercase bullet into the one above', () => {
    const kf = { items: ['First bullet without stop', 'second bullet'], items_hidden: [] };
    expect(resolveSectionKeyFindings(kf)).toHaveLength(2);
    expect(normalizeWorkspaceSectionKeyFindings(kf)).toHaveLength(2);
  });

  it('keeps positions so items_hidden lines up with what is shown', () => {
    const kf = { items: ['A.', '', 'c lowercase', 'D.'], items_hidden: [false, false, false, true] };
    const items = resolveSectionKeyFindings(kf);
    const hidden = materializeSectionKeyFindingsHidden(kf, items.length);
    expect(items).toHaveLength(4);
    expect(hidden[3]).toBe(true);
    expect(items[3]).toBe('D.');
  });

  it('workspace keeps one trailing draft row and falls back to legacy prose', () => {
    expect(normalizeWorkspaceSectionKeyFindings({ items: ['A.', '', ''], items_hidden: [] })).toEqual(['A.', '']);
    expect(normalizeWorkspaceSectionKeyFindings({ items: [], items_hidden: [] }, 'Legacy text')).toEqual(['Legacy text']);
  });
});
