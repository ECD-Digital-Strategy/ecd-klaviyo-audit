import { Lock, CalendarDays } from 'lucide-react';
import type { AuditSection } from '../../../lib/types';

// The teaser around an outreach audit's public link (Emil, 2026-11-01). The server
// (audit_public, _shared/outreach-teaser.ts) has already cut each page to its
// strongest finding and left only a count of the rest in
// section_details.web.locked_findings; this just tells the reader so, and how to
// get the full picture.

/** Where "go through the rest" leads. A booking link replaces this once there is one. */
export const OUTREACH_CONTACT_URL = 'mailto:emil@ecdigitalstrategy.com?subject=Website%20audit%20walkthrough';
export const OUTREACH_CONTACT_LABEL = 'Book a walkthrough with Emil';

type Locked = { desktop?: number; mobile?: number };

export function lockedFindings(section: AuditSection | undefined | null): Locked | null {
  const web = (section?.section_details as { web?: { locked_findings?: Locked } } | null | undefined)?.web;
  return web?.locked_findings ?? null;
}

/** Whether these sections are the teaser (only the public link of an outreach audit is). */
export function isTeaser(sections: AuditSection[]): boolean {
  return sections.some((s) => lockedFindings(s) !== null);
}

function lockedTotal(sections: AuditSection[]): number {
  return sections.reduce((n, s) => {
    const l = lockedFindings(s);
    return n + Math.max(l?.desktop ?? 0, l?.mobile ?? 0);
  }, 0);
}

export function OutreachTeaserBanner({ sections, companyName }: { sections: AuditSection[]; companyName: string }) {
  const more = lockedTotal(sections);
  return (
    <div className="rounded-2xl border border-brand-primary/20 bg-white p-6 shadow-sm sm:flex sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-primary/80">A free preview</p>
        <h2 className="mt-1 text-lg font-bold text-gray-900">
          We looked at {companyName}&apos;s storefront on desktop and mobile.
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
          Below is the top issue we found on each page.
          {more > 0 ? ` There are ${more} more we'd like to walk you through,` : ' We would be glad to walk you through it,'} along with
          what to fix first. It takes about 20 minutes.
        </p>
      </div>
      <a
        href={OUTREACH_CONTACT_URL}
        className="mt-4 inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary-dark sm:mt-0"
      >
        <CalendarDays className="h-4 w-4" />
        {OUTREACH_CONTACT_LABEL}
      </a>
    </div>
  );
}

/** Under a page's findings: how many more there are on this screen size. */
export function LockedFindingsCard({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <a
      href={OUTREACH_CONTACT_URL}
      className="mt-3 flex items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-gray-50/70 px-4 py-3 text-sm text-gray-600 transition-colors hover:border-brand-primary/40 hover:text-brand-primary"
    >
      <Lock className="h-4 w-4 shrink-0 text-gray-400" />
      <span>
        <span className="font-semibold text-gray-800">
          {count} more {count === 1 ? 'finding' : 'findings'} on this page.
        </span>{' '}
        We'll go through {count === 1 ? 'it' : 'them'} with you on a quick call.
      </span>
    </a>
  );
}
