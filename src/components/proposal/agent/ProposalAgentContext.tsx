import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApplyCancelled,
  sendAgentMessage,
  type AgentSnapshot,
  type ProposalDraftPayload,
  type ProposalEditSet,
} from '../../../lib/proposal-agent';
import {
  deleteConversation as deleteConversationDb,
  getConversationMessageCounts,
  getLatestConversation,
  listConversationMessages,
  listConversations,
  markAgentMessageApplied,
  type ProposalAgentMessageWithAuthor,
} from '../../../lib/proposal-agent-db';
import { canApplyPayloadKind } from '../../../lib/agent-apply';
import { useAuth } from '../../../contexts/AuthContext';
import type {
  ProposalAgentAttachment,
  ProposalAgentConversation,
  ProposalAgentMessage,
} from '../../../lib/types';

export type ConversationSummary = ProposalAgentConversation & { messageCount: number };

export type AgentChatMessage = Pick<
  ProposalAgentMessage,
  'id' | 'role' | 'content' | 'payload' | 'payload_kind' | 'applied_at'
> & { pending?: boolean; actorName?: string | null; attachments?: ProposalAgentAttachment[] };

export type ProposalAgentHostConfig = {
  /** Proposal the chat is attached to; null on the proposals list (draft-from-scratch chats). */
  proposalId: string | null;
  clientId?: string | null;
  /** Fresh proposal snapshot for edit mode; omit for proposal-less chats. */
  getSnapshot?: () => AgentSnapshot | null;
  /** Host strategy for applying a full draft (creates a proposal, navigates, links conversation). */
  onApplyDraft?: (draft: ProposalDraftPayload, conversationId: string) => Promise<void>;
  /** Host strategy for applying an edit set against the open proposal. */
  onApplyEdits?: (edits: ProposalEditSet) => Promise<void>;
};

type ProposalAgentContextValue = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  messages: AgentChatMessage[];
  conversationId: string | null;
  sending: boolean;
  loadingHistory: boolean;
  error: string | null;
  applyingMessageId: string | null;
  /** Whether a result of this kind has somewhere to go on this page. A single
   *  boolean showed an Apply button for a draft on a page that could only take
   *  edits, and the click did nothing. */
  canApplyKind: (kind: string | null | undefined) => boolean;
  sendMessage: (text: string, attachments?: ProposalAgentAttachment[]) => Promise<void>;
  applyMessage: (message: AgentChatMessage) => Promise<void>;
  resetChat: () => void;
  // History
  historyView: boolean;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  openHistory: () => void;
  closeHistory: () => void;
  selectConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  /** Text to put in the composer, unsent (a link such as Titan's ?ask=); the panel takes it and clears it. */
  prefill: string | null;
  setPrefill: (text: string | null) => void;
};

const ProposalAgentContext = createContext<ProposalAgentContextValue | null>(null);

export function useProposalAgent(): ProposalAgentContextValue {
  const ctx = useContext(ProposalAgentContext);
  if (!ctx) throw new Error('useProposalAgent must be used inside ProposalAgentProvider');
  return ctx;
}

function tempId(): string {
  return `tmp_${Math.random().toString(36).slice(2, 10)}`;
}

export function ProposalAgentProvider({
  config,
  children,
  defaultOpen = false,
}: {
  config: ProposalAgentHostConfig;
  children: ReactNode;
  /** Open the assistant panel by default (e.g. on the proposal edit page). */
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyingMessageId, setApplyingMessageId] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const historyLoadedFor = useRef<string | null>(null);

  const { user: currentUser } = useAuth();
  const configRef = useRef(config);
  configRef.current = config;

  const rowsToMessages = (rows: ProposalAgentMessageWithAuthor[]): AgentChatMessage[] =>
    rows
      .filter(r => r.role !== 'tool')
      .map(r => ({
        id: r.id,
        role: r.role,
        content: r.content,
        payload: r.payload,
        payload_kind: r.payload_kind,
        applied_at: r.applied_at,
        actorName: r.actor_name,
        attachments: Array.isArray(r.attachments) ? r.attachments : [],
      }));

  // Load persisted history the first time the panel opens (per proposal).
  useEffect(() => {
    if (!isOpen) return;
    const key = config.proposalId ?? '__new__';
    if (historyLoadedFor.current === key) return;
    historyLoadedFor.current = key;
    let cancelled = false;
    (async () => {
      setLoadingHistory(true);
      try {
        const conv = await getLatestConversation(config.proposalId);
        if (cancelled) return;
        if (conv) {
          setConversationId(conv.id);
          const rows = await listConversationMessages(conv.id);
          if (cancelled) return;
          setMessages(rowsToMessages(rows));
        }
      } catch {
        // History is a convenience; the chat still works without it.
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, config.proposalId]);

  const sendMessage = useCallback(
    async (text: string, attachments?: ProposalAgentAttachment[]) => {
      const trimmed = text.trim();
      const atts = attachments ?? [];
      if ((!trimmed && atts.length === 0) || sending) return;
      setError(null);
      const userMsg: AgentChatMessage = {
        id: tempId(),
        role: 'user',
        content: trimmed,
        payload: null,
        payload_kind: null,
        applied_at: null,
        pending: true,
        actorName: currentUser?.name ?? null,
        attachments: atts,
      };
      setMessages(prev => [...prev, userMsg]);
      setSending(true);
      try {
        const cfg = configRef.current;
        const res = await sendAgentMessage({
          conversation_id: conversationId,
          proposal_id: cfg.proposalId,
          client_id: cfg.clientId ?? null,
          message: trimmed,
          attachments: atts,
          snapshot: cfg.getSnapshot?.() ?? null,
        });
        setConversationId(res.conversation_id);
        setMessages(prev => [
          ...prev.map(m => (m.id === userMsg.id ? { ...m, pending: false } : m)),
          {
            id: res.assistant_message_id,
            role: 'assistant',
            content: res.assistant_text,
            payload: res.question ?? res.draft ?? res.edits ?? null,
            payload_kind: res.question ? 'question' : res.draft ? 'draft' : res.edits ? 'edits' : null,
            applied_at: null,
          },
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The assistant request failed');
      } finally {
        setSending(false);
      }
    },
    [conversationId, sending],
  );

  const resetChat = useCallback(() => {
    // Start a fresh thread. The previous conversation stays saved and shows up
    // in history; the next message creates a new conversation server-side.
    setMessages([]);
    setConversationId(null);
    setError(null);
    setHistoryView(false);
  }, []);

  const loadConversationList = useCallback(async () => {
    setConversationsLoading(true);
    try {
      const list = await listConversations(configRef.current.proposalId);
      const counts = await getConversationMessageCounts(list.map(c => c.id));
      setConversations(list.map(c => ({ ...c, messageCount: counts[c.id] ?? 0 })));
    } catch {
      setConversations([]);
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  const openHistory = useCallback(() => {
    setHistoryView(true);
    void loadConversationList();
  }, [loadConversationList]);

  const closeHistory = useCallback(() => setHistoryView(false), []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await deleteConversationDb(id);
      setConversations(prev => prev.filter(c => c.id !== id));
      // If the deleted chat was the one on screen, clear to a fresh thread.
      setConversationId(current => {
        if (current === id) {
          setMessages([]);
          return null;
        }
        return current;
      });
    },
    [],
  );

  const selectConversation = useCallback(async (id: string) => {
    setHistoryView(false);
    setError(null);
    setConversationId(id);
    setLoadingHistory(true);
    try {
      const rows = await listConversationMessages(id);
      setMessages(rowsToMessages(rows));
    } catch {
      setMessages([]);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  const applyMessage = useCallback(
    async (message: AgentChatMessage) => {
      if (!message.payload || message.applied_at || applyingMessageId) return;
      const cfg = configRef.current;
      setApplyingMessageId(message.id);
      setError(null);
      try {
        if (message.payload_kind === 'draft' && cfg.onApplyDraft) {
          await cfg.onApplyDraft(message.payload as ProposalDraftPayload, conversationId ?? '');
        } else if (message.payload_kind === 'edits' && cfg.onApplyEdits) {
          await cfg.onApplyEdits(message.payload as ProposalEditSet);
        } else {
          // This used to return quietly. On the editor page, which wired only
          // onApplyEdits, a draft landed here and Apply did nothing at all: no
          // change, no error, nothing in the console. Whatever the cause, the
          // click now says so instead of being swallowed.
          throw new Error(
            `This ${message.payload_kind ?? 'result'} cannot be applied from here. Reload the page and try again.`,
          );
        }
        await markAgentMessageApplied(message.id).catch(() => {});
        setMessages(prev =>
          prev.map(m => (m.id === message.id ? { ...m, applied_at: new Date().toISOString() } : m)),
        );
      } catch (e) {
        if (e instanceof ApplyCancelled) return; // user dismissed the client picker
        setError(e instanceof Error ? e.message : 'Could not apply the changes');
      } finally {
        setApplyingMessageId(null);
      }
    },
    [applyingMessageId, conversationId],
  );

  const [prefill, setPrefill] = useState<string | null>(null);

  const value = useMemo<ProposalAgentContextValue>(
    () => ({
      isOpen,
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      toggle: () => setIsOpen(v => !v),
      messages,
      conversationId,
      sending,
      loadingHistory,
      error,
      applyingMessageId,
      // The two handlers, not the whole config: the memo's deps list them,
      // and config itself is a fresh object on every render.
      canApplyKind: (kind) =>
        canApplyPayloadKind({ onApplyDraft: config.onApplyDraft, onApplyEdits: config.onApplyEdits }, kind),
      sendMessage,
      applyMessage,
      resetChat,
      historyView,
      conversations,
      conversationsLoading,
      openHistory,
      closeHistory,
      selectConversation,
      deleteConversation,
      prefill,
      setPrefill,
    }),
    [
      isOpen,
      messages,
      conversationId,
      sending,
      loadingHistory,
      error,
      applyingMessageId,
      config.onApplyDraft,
      config.onApplyEdits,
      sendMessage,
      applyMessage,
      resetChat,
      historyView,
      conversations,
      conversationsLoading,
      openHistory,
      closeHistory,
      selectConversation,
      deleteConversation,
      prefill,
    ],
  );

  return <ProposalAgentContext.Provider value={value}>{children}</ProposalAgentContext.Provider>;
}
