import { createContext, useContext } from 'react';

/**
 * The optional lines the client has ticked on the proposal page, before signing
 * (2026-10-30). Only the public page provides it, and only while the first
 * client signer can still choose; everywhere else an optional line shows what
 * was decided (client_selected) or that the client chooses when signing.
 */
export type ProposalOptionsValue = {
  picked: ReadonlySet<string>;
  canChoose: boolean;
  toggle: (lineItemId: string) => void;
};

const EMPTY: ProposalOptionsValue = { picked: new Set(), canChoose: false, toggle: () => {} };

const ProposalOptionsContext = createContext<ProposalOptionsValue>(EMPTY);

export const ProposalOptionsProvider = ProposalOptionsContext.Provider;

export function useProposalOptions(): ProposalOptionsValue {
  return useContext(ProposalOptionsContext);
}
