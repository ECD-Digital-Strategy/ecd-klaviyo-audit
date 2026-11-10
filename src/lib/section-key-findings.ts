import { prepareAuditMarkdown } from './audit-markdown';
import { trimTrailingBlankItems } from './findings-normalize';
import type { SectionKeyFindings } from './types';

export const EMPTY_SECTION_KEY_FINDINGS: SectionKeyFindings = {
  items: [],
  items_hidden: [],
};

export function parseSectionKeyFindings(raw: unknown): SectionKeyFindings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_SECTION_KEY_FINDINGS, items_hidden: [] };
  }
  const obj = raw as Record<string, unknown>;
  const items = Array.isArray(obj.items)
    ? obj.items.map((item) => String(item ?? ''))
    : [];
  const items_hidden = Array.isArray(obj.items_hidden)
    ? obj.items_hidden.map(Boolean)
    : [];
  return { items, items_hidden };
}

/**
 * Resolve display/edit items with legacy prose fallback. Items keep their stored
 * positions (no merging, blanks kept) so items_hidden[i] matches item i.
 */
export function resolveSectionKeyFindings(
  keyFindings: SectionKeyFindings | null | undefined,
  legacyProse?: string | null,
): string[] {
  const parsed = keyFindings ?? EMPTY_SECTION_KEY_FINDINGS;
  if (parsed.items.some((item) => item.trim())) {
    return parsed.items.map(item => prepareAuditMarkdown(item));
  }
  const legacy = String(legacyProse ?? '').trim();
  return legacy ? [legacy] : [];
}

export function materializeSectionKeyFindingsHidden(
  keyFindings: SectionKeyFindings | null | undefined,
  length: number,
): boolean[] {
  const hidden = [...(keyFindings?.items_hidden ?? [])];
  while (hidden.length < length) hidden.push(false);
  return hidden.slice(0, length);
}

/** Workspace editor: real bullets only, plus at most one trailing empty row. */
export function normalizeWorkspaceSectionKeyFindings(
  keyFindings: SectionKeyFindings | null | undefined,
  legacyProse?: string | null,
): string[] {
  const resolved = resolveSectionKeyFindings(keyFindings, legacyProse);
  if (resolved.some((item) => item.trim())) return trimTrailingBlankItems(resolved);
  return [];
}

export function serializeSectionKeyFindings(
  items: string[],
  items_hidden: boolean[],
): SectionKeyFindings {
  return {
    items,
    items_hidden: items_hidden.slice(0, items.length),
  };
}

export function sectionKeyFindingsHasContent(
  keyFindings: SectionKeyFindings | null | undefined,
  legacyProse?: string | null,
): boolean {
  return resolveSectionKeyFindings(keyFindings, legacyProse).some((item) => item.trim());
}
