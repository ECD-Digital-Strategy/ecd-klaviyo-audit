import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { scheduleSavedToast, useToast } from '../../ui/Toast';
import { MSA_ON_FILE_SLUG, MSA_SLUG } from '../../../lib/msa-on-file';
import { toggleContractSelection } from '../../../lib/contract-snapshot';
import { createPatchQueue } from '../../../lib/patch-queue';
import { impliesOptional } from '../../../lib/line-optional';
import {
  createProposalLineItems,
  deleteProposalLineItem,
  refreshedContractsSnapshot,
  resolveContractsForClient,
  updateProposal,
  updateProposalLineItem,
  updateProposalTemplate,
} from '../../../lib/proposals-db';
import type {
  Proposal,
  ProposalBlock,
  ProposalDiscountAppliesTo,
  ProposalDiscountType,
  ProposalLineItem,
  ProposalTemplate,
  ProposalTemplateLineItem,
} from '../../../lib/types';

export type ProposalMode = 'edit' | 'preview' | 'public';
export type ProposalSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type ProposalEditContextValue = {
  mode: ProposalMode;
  editMode: boolean;
  saveStatus: ProposalSaveStatus;
  updateTitle: (value: string) => void;
  updateBlock: (blockKey: string, patch: Partial<Omit<ProposalBlock, 'key'>>) => void;
  addBlock: (afterKey: string | null) => void;
  removeBlock: (blockKey: string) => void;
  moveBlock: (blockKey: string, dir: -1 | 1) => void;
  updateLineItem: (itemId: string, patch: Partial<Omit<ProposalLineItem, 'id' | 'proposal_id' | 'created_at'>>) => void;
  addLineItem: (fromCatalog?: ProposalTemplateLineItem) => void;
  removeLineItem: (itemId: string) => void;
  moveLineItem: (itemId: string, dir: -1 | 1) => void;
  updateDiscount: (patch: {
    discount_type?: ProposalDiscountType;
    discount_value?: number;
    discount_applies_to?: ProposalDiscountAppliesTo;
    discount_label?: string | null;
  }) => void;
  toggleContract: (slug: string, included: boolean) => void;
  /** Override one contract body for this proposal, or null to use the catalog text. */
  setContractOverride: (slug: string, content: string | null) => void;
};

const noop = () => {};

const READ_ONLY_VALUE: Omit<ProposalEditContextValue, 'mode' | 'editMode'> = {
  saveStatus: 'idle',
  updateTitle: noop,
  updateBlock: noop,
  addBlock: noop,
  removeBlock: noop,
  moveBlock: noop,
  updateLineItem: noop,
  addLineItem: noop,
  removeLineItem: noop,
  moveLineItem: noop,
  updateDiscount: noop,
  toggleContract: noop,
  setContractOverride: noop,
};

const ProposalEditContext = createContext<ProposalEditContextValue>({
  mode: 'preview',
  editMode: false,
  ...READ_ONLY_VALUE,
});

export function useProposalEdit(): ProposalEditContextValue {
  return useContext(ProposalEditContext);
}

function blockKey(): string {
  return `block_${Math.random().toString(36).slice(2, 9)}`;
}

type LinePatch = Partial<Omit<ProposalLineItem, 'id' | 'proposal_id' | 'created_at'>>;

/** A line named "Optional ..." is saved as optional. Never flips it back to false. */
function withImpliedOptional<P extends LinePatch>(patch: P): P {
  return patch.name != null && impliesOptional(patch.name) && patch.optional !== true
    ? { ...patch, optional: true }
    : patch;
}

type ProposalEditProviderProps = {
  mode: ProposalMode;
  proposal: Proposal;
  lineItems: ProposalLineItem[];
  onProposalChange?: (next: Proposal) => void;
  onLineItemsChange?: (next: ProposalLineItem[]) => void;
  /** Any client signature exists: everything is read-only and the contract snapshot is never rebuilt. */
  clientHasSigned?: boolean;
  children: ReactNode;
};

export function ProposalEditProvider({
  mode,
  proposal,
  lineItems,
  onProposalChange,
  onLineItemsChange,
  clientHasSigned = false,
  children,
}: ProposalEditProviderProps) {
  const toast = useToast();
  const [saveStatus, setSaveStatus] = useState<ProposalSaveStatus>('idle');
  const timers = useRef<Record<string, number>>({});
  const patchQueue = useRef(createPatchQueue());
  // Content freezes at the FIRST client signature; client_signed_at waits for the last signer.
  const locked = clientHasSigned || Boolean(proposal.client_signed_at);

  const schedule = useCallback(
    (key: string, fn: () => Promise<void>) => {
      if (timers.current[key]) window.clearTimeout(timers.current[key]);
      setSaveStatus('saving');
      timers.current[key] = window.setTimeout(async () => {
        try {
          await fn();
          setSaveStatus('saved');
          scheduleSavedToast(toast);
          window.setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
        } catch {
          setSaveStatus('error');
          toast('Could not save');
        }
      }, 800) as unknown as number;
    },
    [toast],
  );

  // Edits under one key merge into one pending save (patch-queue.ts), so a second
  // partial edit inside the debounce window no longer drops the first. A failed
  // save goes back in the queue under anything newer, so the next edit retries it.
  const schedulePatch = useCallback(
    <P extends object>(key: string, patch: P, send: (merged: P) => Promise<unknown>) => {
      patchQueue.current.add(key, patch as Record<string, unknown>);
      schedule(key, async () => {
        const merged = patchQueue.current.take(key) as P | undefined;
        if (!merged) return;
        try {
          await send(merged);
        } catch (e) {
          patchQueue.current.add(key, { ...merged, ...(patchQueue.current.take(key) ?? {}) } as Record<string, unknown>);
          throw e;
        }
      });
    },
    [schedule],
  );

  const saveProposalPatch = useCallback(
    (key: string, patch: Parameters<typeof updateProposal>[1]) => {
      onProposalChange?.({ ...proposal, ...patch } as Proposal);
      schedulePatch(key, patch, merged => updateProposal(proposal.id, merged));
    },
    [onProposalChange, proposal, schedulePatch],
  );

  const updateTitle = useCallback(
    (value: string) => saveProposalPatch('title', { title: value }),
    [saveProposalPatch],
  );

  const updateBlock = useCallback(
    (key: string, patch: Partial<Omit<ProposalBlock, 'key'>>) => {
      const blocks = proposal.content_blocks.map(b => (b.key === key ? { ...b, ...patch } : b));
      saveProposalPatch('blocks', { content_blocks: blocks });
    },
    [proposal.content_blocks, saveProposalPatch],
  );

  const addBlock = useCallback(
    (afterKey: string | null) => {
      const blocks = [...proposal.content_blocks];
      const newBlock: ProposalBlock = { key: blockKey(), title: 'New section', content: '' };
      const index = afterKey ? blocks.findIndex(b => b.key === afterKey) : -1;
      if (index >= 0) blocks.splice(index + 1, 0, newBlock);
      else blocks.push(newBlock);
      saveProposalPatch('blocks', { content_blocks: blocks });
    },
    [proposal.content_blocks, saveProposalPatch],
  );

  const removeBlock = useCallback(
    (key: string) => {
      saveProposalPatch('blocks', {
        content_blocks: proposal.content_blocks.filter(b => b.key !== key),
      });
    },
    [proposal.content_blocks, saveProposalPatch],
  );

  const moveBlock = useCallback(
    (key: string, dir: -1 | 1) => {
      const blocks = [...proposal.content_blocks];
      const index = blocks.findIndex(b => b.key === key);
      const target = index + dir;
      if (index < 0 || target < 0 || target >= blocks.length) return;
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      saveProposalPatch('blocks', { content_blocks: blocks });
    },
    [proposal.content_blocks, saveProposalPatch],
  );

  const updateLineItem = useCallback(
    (itemId: string, rawPatch: Partial<Omit<ProposalLineItem, 'id' | 'proposal_id' | 'created_at'>>) => {
      const patch = withImpliedOptional(rawPatch);
      onLineItemsChange?.(lineItems.map(item => (item.id === itemId ? { ...item, ...patch } : item)));
      schedulePatch(`line-${itemId}`, patch, merged => updateProposalLineItem(itemId, merged));
    },
    [lineItems, onLineItemsChange, schedulePatch],
  );

  const addLineItem = useCallback(
    (fromCatalog?: ProposalTemplateLineItem) => {
      const nextOrder = lineItems.reduce((max, item) => Math.max(max, item.display_order), 0) + 10;
      const base = fromCatalog ?? {
        template_slug: null,
        name: 'New line item',
        description: '',
        content: '',
        one_time_price: null,
        one_time_label: null,
        monthly_price: null,
        monthly_label: null,
        image_url: null,
        display_order: nextOrder,
      };
      setSaveStatus('saving');
      createProposalLineItems([{ ...withImpliedOptional(base), display_order: nextOrder, proposal_id: proposal.id }])
        .then(created => {
          onLineItemsChange?.([...lineItems, ...created]);
          setSaveStatus('saved');
          scheduleSavedToast(toast);
          window.setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
        })
        .catch(() => {
          setSaveStatus('error');
          toast('Could not add line item');
        });
    },
    [lineItems, onLineItemsChange, proposal.id, toast],
  );

  const removeLineItem = useCallback(
    (itemId: string) => {
      onLineItemsChange?.(lineItems.filter(item => item.id !== itemId));
      // A pending edit to the removed line would only fail once it is gone.
      const pendingKey = `line-${itemId}`;
      if (timers.current[pendingKey]) window.clearTimeout(timers.current[pendingKey]);
      patchQueue.current.drop(pendingKey);
      schedule(`line-remove-${itemId}`, async () => {
        await deleteProposalLineItem(itemId);
      });
    },
    [lineItems, onLineItemsChange, schedule],
  );

  const moveLineItem = useCallback(
    (itemId: string, dir: -1 | 1) => {
      const sorted = [...lineItems].sort((a, b) => a.display_order - b.display_order);
      const index = sorted.findIndex(item => item.id === itemId);
      const target = index + dir;
      if (index < 0 || target < 0 || target >= sorted.length) return;
      [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
      const reindexed = sorted.map((item, i) => ({ ...item, display_order: (i + 1) * 10 }));
      onLineItemsChange?.(reindexed);
      const changed = reindexed.filter(item => {
        const prev = lineItems.find(p => p.id === item.id);
        return prev && prev.display_order !== item.display_order;
      });
      // Each moved line saves under its own key, merged with any other pending
      // edit to it. One shared 'line-reorder' save lost the earlier of two quick moves.
      for (const item of changed) {
        schedulePatch(`line-${item.id}`, { display_order: item.display_order }, merged =>
          updateProposalLineItem(item.id, merged),
        );
      }
    },
    [lineItems, onLineItemsChange, schedulePatch],
  );

  const updateDiscount = useCallback(
    (patch: {
      discount_type?: ProposalDiscountType;
      discount_value?: number;
      discount_applies_to?: ProposalDiscountAppliesTo;
      discount_label?: string | null;
    }) => {
      saveProposalPatch('discount', patch);
    },
    [saveProposalPatch],
  );

  const toggleContract = useCallback(
    (slug: string, included: boolean) => {
      // The MSA is one choice with two forms: the full agreement, or the short
      // "on file" reference for a client who already signed it. Turning it on
      // picks the form by the same rule as creating a proposal; turning it off
      // removes whichever form is attached.
      const isMsa = slug === MSA_SLUG || slug === MSA_ON_FILE_SLUG;
      const base = toggleContractSelection(proposal.include_contracts, slug, included);

      setSaveStatus('saving');
      (async () => {
        let next = base;
        let overrides = proposal.contract_overrides ?? {};
        if (isMsa && included) {
          const resolved = await resolveContractsForClient(proposal.client_id, base, proposal.id);
          next = resolved.include_contracts;
          overrides = { ...overrides, ...resolved.overrides };
        }
        const overridesChanged = overrides !== (proposal.contract_overrides ?? {});

        // Once a proposal has been sent, contracts render from the frozen
        // contracts_snapshot rather than the live docs (see ProposalDocument).
        // While no client has signed, toggling a contract must also refresh
        // that snapshot, otherwise a newly-added contract has no content in
        // the snapshot and silently fails to render. Built first so the
        // optimistic update and the persisted row apply together.
        const snapshot = await refreshedContractsSnapshot(proposal, next, overrides, { clientHasSigned: locked });
        const patch = {
          include_contracts: next,
          ...(overridesChanged ? { contract_overrides: overrides } : {}),
          ...(snapshot ? { contracts_snapshot: snapshot } : {}),
        };
        onProposalChange?.({ ...proposal, ...patch } as Proposal);
        await updateProposal(proposal.id, patch);
      })()
        .then(() => {
          setSaveStatus('saved');
          scheduleSavedToast(toast);
          window.setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
        })
        .catch(() => {
          setSaveStatus('error');
          toast('Could not save');
        });
    },
    [proposal, onProposalChange, toast, locked],
  );

  /** Tailor one contract's text for THIS proposal only, or pass null to drop the
   * override and fall back to the shared catalog copy. Keeps the frozen snapshot
   * in step while the proposal is still unsigned, the same as toggleContract. */
  const setContractOverride = useCallback(
    (slug: string, content: string | null) => {
      const current = proposal.contract_overrides ?? {};
      const nextOverrides = { ...current };
      if (content && content.trim()) nextOverrides[slug] = content;
      else delete nextOverrides[slug];

      if (proposal.contracts_snapshot && !locked) {
        setSaveStatus('saving');
        refreshedContractsSnapshot(proposal, proposal.include_contracts, nextOverrides, { clientHasSigned: false })
          .then(snapshot => {
            const patch = { contract_overrides: nextOverrides, ...(snapshot ? { contracts_snapshot: snapshot } : {}) };
            onProposalChange?.({ ...proposal, ...patch } as Proposal);
            return updateProposal(proposal.id, patch);
          })
          .then(() => {
            setSaveStatus('saved');
            scheduleSavedToast(toast);
            window.setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
          })
          .catch(() => {
            setSaveStatus('error');
            toast('Could not save');
          });
        return;
      }

      saveProposalPatch('contract_overrides', { contract_overrides: nextOverrides });
    },
    [proposal, onProposalChange, saveProposalPatch, toast, locked],
  );

  const value = useMemo<ProposalEditContextValue>(() => {
    // A signed proposal never offers editing, whatever mode the page asked for.
    if (mode !== 'edit' || locked) {
      return { mode: mode === 'edit' ? 'preview' : mode, editMode: false, ...READ_ONLY_VALUE };
    }
    return {
      mode,
      editMode: true,
      saveStatus,
      updateTitle,
      updateBlock,
      addBlock,
      removeBlock,
      moveBlock,
      updateLineItem,
      addLineItem,
      removeLineItem,
      moveLineItem,
      updateDiscount,
      toggleContract,
      setContractOverride,
    };
  }, [
    mode,
    locked,
    saveStatus,
    updateTitle,
    updateBlock,
    addBlock,
    removeBlock,
    moveBlock,
    updateLineItem,
    addLineItem,
    removeLineItem,
    moveLineItem,
    updateDiscount,
    toggleContract,
    setContractOverride,
  ]);

  return <ProposalEditContext.Provider value={value}>{children}</ProposalEditContext.Provider>;
}

// ---------------------------------------------------------------------------
// Template editing
//
// A proposal template stores the same editable surface as a proposal (text
// sections, line items, contracts, discount) but persists to a single
// proposal_templates row: line items live in a JSONB array rather than their
// own table, and there is no client, cover, signing, or contracts_snapshot.
// TemplateEditProvider exposes the identical ProposalEditContext so the shared
// editor components (ProposalRichBlock, ProposalPricingTable, DiscountEditor,
// contract toggles) work unchanged — only the persistence differs.

/** Client-side id for a template line item so the editor components, which key
 * line items by id, can track them. Stripped when persisted to the template. */
export function templateLineItemId(): string {
  return `tli_${Math.random().toString(36).slice(2, 9)}`;
}

function toTemplateLineItems(items: ProposalLineItem[]): ProposalTemplateLineItem[] {
  return [...items]
    .sort((a, b) => a.display_order - b.display_order)
    .map((item, index) => ({
      template_slug: item.template_slug,
      name: item.name,
      description: item.description,
      content: item.content,
      one_time_price: item.one_time_price,
      one_time_label: item.one_time_label,
      monthly_price: item.monthly_price,
      monthly_label: item.monthly_label,
      image_url: item.image_url,
      display_order: (index + 1) * 10,
    }));
}

type TemplateEditProviderProps = {
  mode: ProposalMode;
  template: ProposalTemplate;
  lineItems: ProposalLineItem[];
  onTemplateChange: (next: ProposalTemplate) => void;
  onLineItemsChange: (next: ProposalLineItem[]) => void;
  children: ReactNode;
};

export function TemplateEditProvider({
  mode,
  template,
  lineItems,
  onTemplateChange,
  onLineItemsChange,
  children,
}: TemplateEditProviderProps) {
  const toast = useToast();
  const [saveStatus, setSaveStatus] = useState<ProposalSaveStatus>('idle');
  const timers = useRef<Record<string, number>>({});
  const templatePatchQueue = useRef(createPatchQueue());

  const schedule = useCallback(
    (key: string, fn: () => Promise<void>) => {
      if (timers.current[key]) window.clearTimeout(timers.current[key]);
      setSaveStatus('saving');
      timers.current[key] = window.setTimeout(async () => {
        try {
          await fn();
          setSaveStatus('saved');
          scheduleSavedToast(toast);
          window.setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
        } catch {
          setSaveStatus('error');
          toast('Could not save');
        }
      }, 800) as unknown as number;
    },
    [toast],
  );

  const saveTemplatePatch = useCallback(
    (key: string, patch: Parameters<typeof updateProposalTemplate>[1], next: ProposalTemplate) => {
      onTemplateChange(next);
      // Merged per key like the proposal editor: the discount editor sends one field at a time.
      templatePatchQueue.current.add(key, patch as Record<string, unknown>);
      schedule(key, async () => {
        const merged = templatePatchQueue.current.take(key) as typeof patch | undefined;
        if (merged) await updateProposalTemplate(template.id, merged);
      });
    },
    [onTemplateChange, schedule, template.id],
  );

  // Template line items persist as the whole JSONB array on every change.
  const saveLineItems = useCallback(
    (next: ProposalLineItem[]) => {
      onLineItemsChange(next);
      const payload = toTemplateLineItems(next);
      schedule('template-line-items', async () => {
        await updateProposalTemplate(template.id, { default_line_items: payload });
      });
    },
    [onLineItemsChange, schedule, template.id],
  );

  const updateTitle = useCallback(
    (value: string) => saveTemplatePatch('name', { name: value }, { ...template, name: value }),
    [saveTemplatePatch, template],
  );

  const updateBlock = useCallback(
    (key: string, patch: Partial<Omit<ProposalBlock, 'key'>>) => {
      const blocks = template.content_blocks.map(b => (b.key === key ? { ...b, ...patch } : b));
      saveTemplatePatch('blocks', { content_blocks: blocks }, { ...template, content_blocks: blocks });
    },
    [saveTemplatePatch, template],
  );

  const addBlock = useCallback(
    (afterKey: string | null) => {
      const blocks = [...template.content_blocks];
      const newBlock: ProposalBlock = { key: blockKey(), title: 'New section', content: '' };
      const index = afterKey ? blocks.findIndex(b => b.key === afterKey) : -1;
      if (index >= 0) blocks.splice(index + 1, 0, newBlock);
      else blocks.push(newBlock);
      saveTemplatePatch('blocks', { content_blocks: blocks }, { ...template, content_blocks: blocks });
    },
    [saveTemplatePatch, template],
  );

  const removeBlock = useCallback(
    (key: string) => {
      const blocks = template.content_blocks.filter(b => b.key !== key);
      saveTemplatePatch('blocks', { content_blocks: blocks }, { ...template, content_blocks: blocks });
    },
    [saveTemplatePatch, template],
  );

  const moveBlock = useCallback(
    (key: string, dir: -1 | 1) => {
      const blocks = [...template.content_blocks];
      const index = blocks.findIndex(b => b.key === key);
      const target = index + dir;
      if (index < 0 || target < 0 || target >= blocks.length) return;
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      saveTemplatePatch('blocks', { content_blocks: blocks }, { ...template, content_blocks: blocks });
    },
    [saveTemplatePatch, template],
  );

  const updateLineItem = useCallback(
    (itemId: string, patch: Partial<Omit<ProposalLineItem, 'id' | 'proposal_id' | 'created_at'>>) => {
      saveLineItems(lineItems.map(item => (item.id === itemId ? { ...item, ...withImpliedOptional(patch) } : item)));
    },
    [lineItems, saveLineItems],
  );

  const addLineItem = useCallback(
    (fromCatalog?: ProposalTemplateLineItem) => {
      const nextOrder = lineItems.reduce((max, item) => Math.max(max, item.display_order), 0) + 10;
      const base = fromCatalog ?? {
        template_slug: null,
        name: 'New line item',
        description: '',
        content: '',
        one_time_price: null,
        one_time_label: null,
        monthly_price: null,
        monthly_label: null,
        image_url: null,
        display_order: nextOrder,
      };
      const created: ProposalLineItem = {
        ...withImpliedOptional(base),
        id: templateLineItemId(),
        proposal_id: '',
        created_at: '',
        display_order: nextOrder,
      };
      saveLineItems([...lineItems, created]);
    },
    [lineItems, saveLineItems],
  );

  const removeLineItem = useCallback(
    (itemId: string) => {
      saveLineItems(lineItems.filter(item => item.id !== itemId));
    },
    [lineItems, saveLineItems],
  );

  const moveLineItem = useCallback(
    (itemId: string, dir: -1 | 1) => {
      const sorted = [...lineItems].sort((a, b) => a.display_order - b.display_order);
      const index = sorted.findIndex(item => item.id === itemId);
      const target = index + dir;
      if (index < 0 || target < 0 || target >= sorted.length) return;
      [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
      saveLineItems(sorted.map((item, i) => ({ ...item, display_order: (i + 1) * 10 })));
    },
    [lineItems, saveLineItems],
  );

  const updateDiscount = useCallback(
    (patch: {
      discount_type?: ProposalDiscountType;
      discount_value?: number;
      discount_applies_to?: ProposalDiscountAppliesTo;
      discount_label?: string | null;
    }) => {
      saveTemplatePatch('discount', patch, { ...template, ...patch });
    },
    [saveTemplatePatch, template],
  );

  const toggleContract = useCallback(
    (slug: string, included: boolean) => {
      const next = included
        ? [...new Set([...template.default_contracts, slug])]
        : template.default_contracts.filter(s => s !== slug);
      saveTemplatePatch('contracts', { default_contracts: next }, { ...template, default_contracts: next });
    },
    [saveTemplatePatch, template],
  );

  const value = useMemo<ProposalEditContextValue>(() => {
    if (mode !== 'edit') {
      return { mode, editMode: false, ...READ_ONLY_VALUE };
    }
    return {
      mode,
      editMode: true,
      saveStatus,
      updateTitle,
      updateBlock,
      addBlock,
      removeBlock,
      moveBlock,
      updateLineItem,
      addLineItem,
      removeLineItem,
      moveLineItem,
      updateDiscount,
      toggleContract,
      // A template has default_contracts only, with no per-proposal override map
      // to write into, so this is a no-op here. It must still be provided:
      // ProposalDocument reads it unconditionally, and leaving it undefined threw
      // a ReferenceError that rendered the whole template editor blank.
      setContractOverride: noop,
    };
  }, [
    mode,
    saveStatus,
    updateTitle,
    updateBlock,
    addBlock,
    removeBlock,
    moveBlock,
    updateLineItem,
    addLineItem,
    removeLineItem,
    moveLineItem,
    updateDiscount,
    toggleContract,
  ]);

  return <ProposalEditContext.Provider value={value}>{children}</ProposalEditContext.Provider>;
}
