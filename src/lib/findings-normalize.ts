/** Max lengths enforced in ai_analyze_audit JSON schema (keep in sync). */
export const FINDINGS_MAX_LENGTH = 600;
export const CONCERNS_MAX_LENGTH = 500;

/** True when `next` looks like a schema-truncated continuation of `prev`. */
export function isFindingContinuation(prev: string, next: string): boolean {
  const p = prev.trim();
  const n = next.trim();
  if (!p || !n) return false;

  // Continuation fragments often start with a lowercase word tail (e.g. "ush**, while …").
  if (/^[a-z]{1,8}(\*\*)?[,\s]/.test(n)) return true;

  const boldCount = (p.match(/\*\*/g) ?? []).length;
  if (boldCount % 2 === 1 && /^[a-z]/.test(n)) return true;

  if (/[a-zA-Z]$/.test(p) && !/[.!?]$/.test(p)) {
    if (/^[a-z]/.test(n)) return true;
    if (/ [A-Z]$/.test(p)) return true;
  }

  return false;
}

export function mergeFindingContinuation(prev: string, next: string): string {
  const p = prev.trimEnd();
  const n = next.trimStart();
  if (/[a-zA-Z]$/.test(p) && /^[a-z]/.test(n)) return p + n;
  return `${p} ${n}`;
}

export function repairBrokenBoldMarkers(text: string): string {
  const count = (text.match(/\*\*/g) ?? []).length;
  if (count % 2 === 1) return `${text}**`;
  return text;
}

/**
 * Merge array items that were split mid-sentence by AI schema length limits.
 * Only for fresh AI output, before it is stored. Never run it on stored or
 * edited findings: it can merge a real bullet into the one above it, and the
 * hidden flags index into the stored array.
 */
export function repairSplitFindings(items: string[]): string[] {
  const raw = items.map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];

  for (const item of raw) {
    if (out.length === 0) {
      out.push(item);
      continue;
    }
    const prev = out[out.length - 1];
    if (isFindingContinuation(prev, item)) {
      out[out.length - 1] = repairBrokenBoldMarkers(mergeFindingContinuation(prev, item));
    } else {
      out.push(item);
    }
  }

  return out.map(repairBrokenBoldMarkers);
}

/**
 * Drop trailing blank rows (padded slots), keeping one empty draft row when the
 * list ended in a blank. Positions of the remaining items never change, so
 * hidden flags stay aligned.
 */
export function trimTrailingBlankItems(items: string[], keepDraft = true): string[] {
  const out = items.map((item) => String(item ?? ''));
  let end = out.length;
  while (end > 0 && !out[end - 1].trim()) end--;
  const kept = out.slice(0, end);
  return keepDraft && end > 0 && end < out.length ? [...kept, ''] : kept;
}

/** Raw findings for workspace mutations (concerns fallback when no stored findings). */
export function getExecutiveFindingsForEdit(
  findings?: string[],
  concerns?: string[],
): string[] {
  // Same choice as the display, so positions match what the editor shows.
  if (Array.isArray(findings) && findings.some((f) => String(f ?? '').trim())) return [...findings];
  if (Array.isArray(concerns) && concerns.some((c) => String(c ?? '').trim())) {
    return [...concerns];
  }
  return Array.isArray(findings) ? [...findings] : [];
}

/**
 * Findings shown in the workspace editor: the stored items as they are, minus
 * trailing padded blanks, plus at most one trailing draft row after "Add finding".
 * No merging, so typing never touches another bullet.
 */
export function normalizeWorkspaceKeyFindings(
  findings?: string[],
  concerns?: string[],
): string[] {
  if (Array.isArray(findings) && findings.some((f) => String(f ?? '').trim())) {
    return trimTrailingBlankItems(findings);
  }
  if (Array.isArray(concerns) && concerns.some((c) => String(c ?? '').trim())) {
    return trimTrailingBlankItems(concerns, false);
  }
  return [];
}

/**
 * Findings for display (findings preferred, concerns fallback). Same positions
 * as the stored array, so findingsHidden[i] matches item i. Blank items are
 * kept; the renderer skips them.
 */
export function resolveExecutiveFindings(findings?: string[], concerns?: string[]): string[] {
  const base =
    Array.isArray(findings) && findings.some((f) => String(f ?? '').trim())
      ? findings
      : Array.isArray(concerns)
        ? concerns
        : [];
  return base.map((item) => repairBrokenBoldMarkers(String(item ?? '')));
}
