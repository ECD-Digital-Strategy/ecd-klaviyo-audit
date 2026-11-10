import { describe, expect, it } from 'vitest';
import { describeProposalExpiry, proposalExpiryLabel } from './proposal-status';

// valid_until is a DATE and the cutoff is the end of that day, so these cases
// pin down the day arithmetic around the boundary. Times are New York (EDT)
// so the result does not depend on the machine's time zone.
const at = (iso: string) => new Date(iso);
const p = (valid_until: string | null, status = 'viewed') =>
  ({ status, valid_until } as Parameters<typeof describeProposalExpiry>[0]);

describe('describeProposalExpiry', () => {
  it('has not started before the client opens it', () => {
    const e = describeProposalExpiry(p(null), at('2026-08-01T12:00:00-04:00'));
    expect(e.state).toBe('not_started');
    expect(proposalExpiryLabel(e)).toBe('Starts when opened');
  });

  it('counts the last day as Today, not expired', () => {
    const e = describeProposalExpiry(p('2026-08-01'), at('2026-08-01T09:00:00-04:00'));
    expect(e.state).toBe('active');
    expect(proposalExpiryLabel(e)).toBe('Today');
  });

  it('is still active late on the final day', () => {
    const e = describeProposalExpiry(p('2026-08-01'), at('2026-08-01T23:59:00-04:00'));
    expect(e.state).toBe('active');
  });

  it('expires once the day has passed', () => {
    const e = describeProposalExpiry(p('2026-08-01'), at('2026-08-02T00:30:00-04:00'));
    expect(e.state).toBe('expired');
    expect(proposalExpiryLabel(e)).toBe('Expired yesterday');
  });

  it('says Tomorrow the day before', () => {
    const e = describeProposalExpiry(p('2026-08-02'), at('2026-08-01T09:00:00-04:00'));
    expect(proposalExpiryLabel(e)).toBe('Tomorrow');
  });

  it('counts whole days out', () => {
    const e = describeProposalExpiry(p('2026-08-31'), at('2026-08-01T09:00:00-04:00'));
    expect(e.state).toBe('active');
    expect(proposalExpiryLabel(e)).toBe('in 30 days');
  });

  it('has no countdown once won or lost', () => {
    expect(describeProposalExpiry(p('2026-08-01', 'won')).state).toBe('no_expiry');
    expect(describeProposalExpiry(p('2026-08-01', 'lost')).state).toBe('no_expiry');
  });
});

describe('New York clock', () => {
  it('is still active after midnight in Europe while it is the last day in New York', () => {
    const e = describeProposalExpiry(p('2026-08-01'), at('2026-08-02T02:00:00+02:00'));
    expect(e.state).toBe('active');
    expect(proposalExpiryLabel(e)).toBe('Today');
  });

  it('expires at midnight New York', () => {
    expect(describeProposalExpiry(p('2026-08-01'), at('2026-08-02T00:00:00-04:00')).state).toBe('expired');
  });
});
