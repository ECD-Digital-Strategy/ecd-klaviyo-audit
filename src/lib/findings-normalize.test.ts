/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  getExecutiveFindingsForEdit,
  isFindingContinuation,
  mergeFindingContinuation,
  normalizeWorkspaceKeyFindings,
  repairSplitFindings,
  resolveExecutiveFindings,
  trimTrailingBlankItems,
} from './findings-normalize';

describe('findings-normalize', () => {
  it('merges schema-split subscription lifecycle finding', () => {
    const split = [
      '**Subscription lifecycle is fragmented right now**, you have multiple draft flows sitting idle, including **Nightcap Drops to Gummy Subscription**, **Detox Enzyme Subscription Upsell (8.11.23)**, **Nightcap Gummy > Subscription**, **Gut Therapy Subscription Upsell**, and **Night Gummy Subscription P',
      'ush**, while **MM | Subscription Upsell** is still manual.',
      '**Your highest-volume welcome flow is under-converting**, **Evergreen New Subscriber Flow** reached **24,891 recipients** but converted at just **0.15%**.',
    ];
    const repaired = repairSplitFindings(split);
    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toContain('**Night Gummy Subscription Push**, while **MM | Subscription Upsell**');
    expect(repaired[1]).toMatch(/^\*\*Your highest-volume welcome flow/);
  });

  it('does not merge distinct findings', () => {
    const items = [
      '**No post-purchase flow**, repeat revenue is uncaptured.',
      '**Welcome flow under-converts**, only **0.15%** conversion.',
    ];
    expect(repairSplitFindings(items)).toEqual(items);
  });

  it('getExecutiveFindingsForEdit returns stored arrays without padding empty slots', () => {
    expect(getExecutiveFindingsForEdit(['One', ''], [])).toEqual(['One', '']);
    expect(getExecutiveFindingsForEdit(undefined, [])).toEqual([]);
  });

  it('normalizeWorkspaceKeyFindings hides padded blanks but keeps one trailing draft row', () => {
    expect(normalizeWorkspaceKeyFindings(['One', 'Two', ''], [])).toEqual(['One', 'Two', '']);
    expect(normalizeWorkspaceKeyFindings(['', '', ''], [])).toEqual([]);
    expect(normalizeWorkspaceKeyFindings(['Only'], [])).toEqual(['Only']);
  });

  it('resolveExecutiveFindings prefers findings then falls back to concerns, without merging', () => {
    const concerns = [
      '**First concern part A',
      'part B**, with more detail.',
      '**Second concern**, detail.',
    ];
    const resolved = resolveExecutiveFindings([], concerns);
    expect(resolved).toHaveLength(3);
    expect(resolved[1].startsWith('part B')).toBe(true);
    expect(resolveExecutiveFindings(['A.', 'B.'], concerns)).toEqual(['A.', 'B.']);
  });

  it('never merges a user bullet that starts lowercase into the previous one', () => {
    const stored = ['**First finding** without a full stop', 'new bullet typed by the user'];
    expect(resolveExecutiveFindings(stored, [])).toHaveLength(2);
    expect(normalizeWorkspaceKeyFindings(stored, [])).toEqual(stored);
  });

  it('keeps stored positions so hidden flags line up', () => {
    const stored = ['One.', '', 'three lowercase', 'Four'];
    const resolved = resolveExecutiveFindings(stored, []);
    expect(resolved).toEqual(stored);
    expect(normalizeWorkspaceKeyFindings(stored, [])).toEqual(stored);
  });

  it('trimTrailingBlankItems drops padded blanks and keeps one draft row', () => {
    expect(trimTrailingBlankItems(['A', '', '', ''])).toEqual(['A', '']);
    expect(trimTrailingBlankItems(['A', '', 'B'])).toEqual(['A', '', 'B']);
    expect(trimTrailingBlankItems(['A', ''], false)).toEqual(['A']);
    expect(trimTrailingBlankItems(['', ''])).toEqual([]);
  });

  it('getExecutiveFindingsForEdit uses concerns as stored when findings are blank', () => {
    expect(getExecutiveFindingsForEdit(['', ''], ['c1', 'part two'])).toEqual(['c1', 'part two']);
  });

  it('detects mid-word continuation', () => {
    expect(isFindingContinuation('ends with P', 'ush**, while next')).toBe(true);
    expect(mergeFindingContinuation('ends with P', 'ush**, while next')).toBe('ends with Push**, while next');
  });
});
