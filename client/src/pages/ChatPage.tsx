import { useEffect, useRef, useState } from 'react';
import {
  approveProposal,
  deleteConversation,
  duplicateConversation,
  getConversation,
  listConversations,
  listProjects,
  resetConversation,
  streamChat,
  submitProposal,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { getUserPreferences } from '../auth/storage';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConversationMenu } from '../components/ConversationMenu';
import type { ChatStreamEvent, ConversationSummary, Project, StoredMessage, UiMessage, UiProposal } from '../types';
import { suggestProjectFromMessages } from '../utils/project';

interface ChatPageProps {
  onTasksChanged: () => void;
  onProjectSuggested?: (name: string) => void;
}

type PendingConfirm =
  | { kind: 'delete'; conversation: ConversationSummary }
  | { kind: 'reset'; conversation: ConversationSummary };

function visibleMessages(messages: UiMessage[]) {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant');
}

function proposalSourceLabel(source: UiProposal['source']) {
  if (source === 'text_fallback') return 'text fallback';
  if (source === 'manual') return 'manual';
  return 'native';
}

function isPersistedProposal(proposal: UiProposal) {
  return !proposal.id.startsWith('hist-');
}

const APPROVAL_PHRASES = /^(approve|approved|yes|go ahead|looks good|do it|confirm)\.?$/i;

interface PendingProposalRef {
  messageId: string;
  proposal: UiProposal;
}

function getPendingProposals(messages: UiMessage[]): PendingProposalRef[] {
  const refs: PendingProposalRef[] = [];
  for (const message of messages) {
    for (const proposal of message.proposals ?? []) {
      if (proposal.status === 'pending' && isPersistedProposal(proposal)) {
        refs.push({ messageId: message.id, proposal });
      }
    }
  }
  return refs;
}

function contentRequestsApproval(content: string): boolean {
  return /review and approve|before I proceed|please approve|waiting for (?:your )?approval/i.test(
    content
  );
}

function hasPendingProposals(message: UiMessage): boolean {
  return message.proposals?.some((p) => p.status === 'pending' && isPersistedProposal(p)) ?? false;
}

function proposalSummary(proposal: UiProposal): string {
  const args = proposal.arguments;
  if (typeof args.title === 'string') return args.title;
  if (typeof args.name === 'string') return args.name;
  if (typeof args.taskId === 'string') return args.taskId;
  return proposal.name;
}

function handleStreamEvent(
  event: ChatStreamEvent,
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>,
  setConversationId: React.Dispatch<React.SetStateAction<string | undefined>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>
): { toolsTouched: boolean } {
  let toolsTouched = false;

  if (event.type === 'token') {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? { ...message, content: message.content + event.content }
          : message
      )
    );
  }

  if (event.type === 'tool_call') {
    toolsTouched = true;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              toolCalls: [...(message.toolCalls ?? []), { name: event.name }],
            }
          : message
      )
    );
  }

  if (event.type === 'tool_result') {
    toolsTouched = true;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              toolCalls: (message.toolCalls ?? []).map((call) =>
                call.name === event.name
                  ? {
                      ...call,
                      success: event.success,
                      errorContent: event.success ? undefined : event.content,
                    }
                  : call
              ),
            }
          : message
      )
    );
  }

  if (event.type === 'tool_proposal') {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              proposals: [
                ...(message.proposals ?? []),
                {
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                  source: event.source,
                  status: 'pending' as const,
                  staged: event.staged,
                },
              ],
            }
          : message
      )
    );
  }

  if (event.type === 'warning') {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? { ...message, warnings: [...(message.warnings ?? []), event.message] }
          : message
      )
    );
  }

  if (event.type === 'paused') {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId ? { ...message, paused: true } : message
      )
    );
  }

  if (event.type === 'error') {
    setError(event.message);
  }

  if (event.type === 'done') {
    setConversationId(event.conversationId);
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              content: event.content || message.content,
              streaming: false,
              paused: event.paused ?? message.paused,
            }
          : message
      )
    );
    listConversations().then(({ conversations: items }) => {
      void items;
    });
  }

  return { toolsTouched };
}

export function ChatPage({ onTasksChanged, onProjectSuggested }: ChatPageProps) {
  const { user, updatePreferences } = useAuth();
  const preferences = getUserPreferences(user);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [resettingConversationId, setResettingConversationId] = useState<string | null>(null);
  const [duplicatingConversationId, setDuplicatingConversationId] = useState<string | null>(null);
  const [openMenuConversationId, setOpenMenuConversationId] = useState<string | null>(null);
  const [dontAskAgainApprove, setDontAskAgainApprove] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const autoApproveInFlightRef = useRef(false);

  useEffect(() => {
    listConversations()
      .then(({ conversations: items }) => setConversations(items))
      .catch((err: Error) => setError(err.message));
    listProjects()
      .then(({ projects: items }) => setProjects(items))
      .catch(() => {
        // optional for project suggestion
      });
  }, []);

  useEffect(() => {
    const suggested = suggestProjectFromMessages(messages, projects);
    if (suggested) {
      onProjectSuggested?.(suggested);
    }
  }, [messages, projects, onProjectSuggested]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, approvingId, submittingProposal]);

  async function syncConversationFromServer(id: string, keepStreaming = false) {
    const { conversation } = await getConversation(id);
    const visibleStored = conversation.messages.filter(
      (message: StoredMessage) => message.role === 'user' || message.role === 'assistant'
    );
    const messageProposals = conversation.messageProposals ?? {};

    setMessages((prev) => {
      const streaming = keepStreaming ? prev.filter((message) => message.streaming) : [];
      const uiMessages: UiMessage[] = visibleStored.map((message: StoredMessage, index: number) => {
        const proposals = messageProposals[index];
        const hasPending = proposals?.some((proposal) => proposal.status === 'pending');

        return {
          id: `${id}-${index}`,
          role: message.role as 'user' | 'assistant',
          content: message.content,
          toolCalls: message.toolCalls?.map((call) => ({
            name: call.function.name,
          })),
          proposals: proposals?.length ? proposals : undefined,
          paused: Boolean(hasPending),
        };
      });
      return [...uiMessages, ...streaming];
    });
  }

  async function loadConversation(id: string) {
    setConversationId(id);
    setError(null);
    setEditingKey(null);
    setEditError(null);

    const { conversation } = await getConversation(id);
    const visibleStored = conversation.messages.filter(
      (message: StoredMessage) => message.role === 'user' || message.role === 'assistant'
    );
    const messageProposals = conversation.messageProposals ?? {};

    const uiMessages: UiMessage[] = visibleStored.map((message: StoredMessage, index: number) => {
      const proposals = messageProposals[index];
      const hasPending = proposals?.some((proposal) => proposal.status === 'pending');

      return {
        id: `${id}-${index}`,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        toolCalls: message.toolCalls?.map((call) => ({
          name: call.function.name,
        })),
        proposals: proposals?.length ? proposals : undefined,
        paused: Boolean(hasPending),
      };
    });
    setMessages(uiMessages);
  }

  function handleUseAgain(content: string) {
    setInput(content);
    inputRef.current?.focus();
  }

  function startEditingProposal(messageId: string, proposal: UiProposal) {
    setEditingKey(`${messageId}:${proposal.id}`);
    setEditDraft(JSON.stringify(proposal.arguments, null, 2));
    setEditError(null);
  }

  function cancelEditingProposal() {
    setEditingKey(null);
    setEditDraft('');
    setEditError(null);
  }

  async function handleSubmitEditedProposal(_messageId: string, proposal: UiProposal) {
    if (!conversationId) {
      setEditError('Load or start a conversation before submitting a proposal');
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editDraft) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Arguments must be a JSON object');
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }

    setSubmittingProposal(true);
    setEditError(null);

    try {
      const { proposal: newProposal } = await submitProposal(conversationId, proposal.name, parsed);
      cancelEditingProposal();

      const assistantId = `assistant-retry-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: 'Edited proposal ready for your review.',
          proposals: [newProposal],
          paused: true,
        },
      ]);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setSubmittingProposal(false);
    }
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    const pending = getPendingProposals(messages);
    if (pending.length > 0 && APPROVAL_PHRASES.test(text)) {
      setInput('');
      const first = pending[0]!;
      await handleProposalAction(first.messageId, first.proposal, 'approve');
      return;
    }

    setInput('');
    setSending(true);
    setError(null);

    const userMessage: UiMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
    };
    const assistantId = `assistant-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', content: '', streaming: true, toolCalls: [], proposals: [] },
    ]);

    let toolsTouched = false;
    let resolvedConversationId = conversationId;

    try {
      await streamChat(text, conversationId, (event) => {
        const result = handleStreamEvent(event, assistantId, setMessages, setConversationId, setError);
        if (result.toolsTouched) toolsTouched = true;
        if (event.type === 'done') {
          resolvedConversationId = event.conversationId;
          listConversations().then(({ conversations: items }) => setConversations(items));
        }
      });

      if (resolvedConversationId) {
        await syncConversationFromServer(resolvedConversationId);
      }

      if (toolsTouched) {
        onTasksChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat failed');
      setMessages((prev) => prev.filter((message) => message.id !== assistantId));
    } finally {
      setSending(false);
      setMessages((prev) =>
        prev.map((message) => (message.streaming ? { ...message, streaming: false } : message))
      );
    }
  }

  async function handleProposalAction(
    messageId: string,
    proposal: UiProposal,
    action: 'approve' | 'reject',
    options?: { dontAskAgain?: boolean }
  ) {
    if (!conversationId || approvingId || !isPersistedProposal(proposal)) {
      autoApproveInFlightRef.current = false;
      return;
    }

    if (action === 'approve' && options?.dontAskAgain && !preferences.autoApproveProposals) {
      try {
        await updatePreferences({ autoApproveProposals: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save preference');
        autoApproveInFlightRef.current = false;
        return;
      }
    }

    setApprovingId(proposal.id);
    setError(null);

    const assistantId = messageId;
    let toolsTouched = false;

    try {
      await approveProposal(conversationId, proposal.id, action, (event) => {
        handleStreamEvent(event, assistantId, setMessages, setConversationId, setError);

        if (event.type === 'tool_result' && event.success) {
          toolsTouched = true;
        }

        if (event.type === 'done') {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    proposals: (message.proposals ?? []).map((p) =>
                      p.id === proposal.id
                        ? { ...p, status: action === 'approve' ? 'approved' : 'rejected' }
                        : p
                    ),
                  }
                : message
            )
          );
          listConversations().then(({ conversations: items }) => setConversations(items));
          syncConversationFromServer(conversationId).catch(() => {
            // ignore sync errors after approval
          });
        }
      });

      if (action === 'approve' && toolsTouched) {
        onTasksChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApprovingId(null);
      autoApproveInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!preferences.autoApproveProposals || !conversationId || sending || approvingId) return;
    if (autoApproveInFlightRef.current) return;

    const pending = getPendingProposals(messages);
    const first = pending[0];
    if (!first) return;

    autoApproveInFlightRef.current = true;
    void handleProposalAction(first.messageId, first.proposal, 'approve');
    // handleProposalAction closes over latest state; effect is keyed on pending work signals
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.autoApproveProposals, conversationId, sending, approvingId, messages]);

  function startNewConversation() {
    setConversationId(undefined);
    setMessages([]);
    setError(null);
    setEditingKey(null);
    setEditError(null);
  }

  async function performDeleteConversation(conversation: ConversationSummary) {
    const deletingSelectedConversation = conversation._id === conversationId;
    setDeletingConversationId(conversation._id);
    setError(null);

    try {
      await deleteConversation(conversation._id);
      setConversations((items) => items.filter((item) => item._id !== conversation._id));
      if (deletingSelectedConversation) {
        startNewConversation();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete chat');
    } finally {
      setDeletingConversationId(null);
    }
  }

  async function performResetConversation(conversation: ConversationSummary) {
    setResettingConversationId(conversation._id);
    setError(null);

    try {
      const { conversation: reset } = await resetConversation(conversation._id);
      if (conversation._id === conversationId) {
        const visibleStored = reset.messages.filter(
          (message: StoredMessage) => message.role === 'user' || message.role === 'assistant'
        );
        setMessages(
          visibleStored.map((message: StoredMessage, index: number) => ({
            id: `${conversation._id}-${index}`,
            role: message.role as 'user' | 'assistant',
            content: message.content,
          }))
        );
        setEditingKey(null);
        setEditError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset chat');
    } finally {
      setResettingConversationId(null);
    }
  }

  function requestDeleteConversation(conversation: ConversationSummary) {
    if (preferences.skipConfirmations) {
      void performDeleteConversation(conversation);
      return;
    }
    setPendingConfirm({ kind: 'delete', conversation });
  }

  function requestResetConversation(conversation: ConversationSummary) {
    if (preferences.skipConfirmations) {
      void performResetConversation(conversation);
      return;
    }
    setPendingConfirm({ kind: 'reset', conversation });
  }

  async function handleDuplicateConversation(conversation: ConversationSummary) {
    setDuplicatingConversationId(conversation._id);
    setError(null);

    try {
      const { conversation: duplicated } = await duplicateConversation(conversation._id);
      setConversations((items) => [
        {
          _id: duplicated._id,
          title: duplicated.title,
          createdAt: duplicated.createdAt,
          updatedAt: duplicated.updatedAt,
        },
        ...items,
      ]);
      await loadConversation(duplicated._id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not duplicate chat');
    } finally {
      setDuplicatingConversationId(null);
    }
  }

  async function handleConfirmDialog(dontAskAgain: boolean) {
    if (!pendingConfirm) return;
    setConfirmBusy(true);
    try {
      if (dontAskAgain && !preferences.skipConfirmations) {
        await updatePreferences({ skipConfirmations: true });
      }
      if (pendingConfirm.kind === 'delete') {
        await performDeleteConversation(pendingConfirm.conversation);
      } else {
        await performResetConversation(pendingConfirm.conversation);
      }
      setPendingConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save preference');
    } finally {
      setConfirmBusy(false);
    }
  }

  const pendingProposals = getPendingProposals(messages);
  const conversationActionsBusy =
    sending ||
    approvingId !== null ||
    submittingProposal ||
    deletingConversationId !== null ||
    resettingConversationId !== null ||
    duplicatingConversationId !== null;

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <button type="button" className="primary-button" onClick={startNewConversation}>
          New chat
        </button>
        <ul className="conversation-list">
          {conversations.map((conversation) => {
            const menuOpen = openMenuConversationId === conversation._id;
            const rowBusy =
              deletingConversationId === conversation._id ||
              resettingConversationId === conversation._id ||
              duplicatingConversationId === conversation._id;

            return (
              <li key={conversation._id} className="conversation-list-item">
                <button
                  type="button"
                  className={`conversation-select ${conversation._id === conversationId ? 'active' : ''}`}
                  onClick={() => loadConversation(conversation._id)}
                  disabled={conversationActionsBusy}
                >
                  {conversation.title}
                </button>
                <button
                  type="button"
                  className="conversation-menu-trigger"
                  ref={menuOpen ? menuTriggerRef : undefined}
                  aria-label={`Chat actions for ${conversation.title}`}
                  aria-expanded={menuOpen}
                  title="Chat actions"
                  disabled={conversationActionsBusy}
                  onClick={() =>
                    setOpenMenuConversationId(menuOpen ? null : conversation._id)
                  }
                >
                  {rowBusy ? '…' : '⋮'}
                </button>
                {menuOpen && (
                  <ConversationMenu
                    anchorRef={menuTriggerRef}
                    busy={conversationActionsBusy}
                    onReset={() => requestResetConversation(conversation)}
                    onDuplicate={() => {
                      void handleDuplicateConversation(conversation);
                    }}
                    onDelete={() => requestDeleteConversation(conversation)}
                    onClose={() => setOpenMenuConversationId(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="chat-panel">
        <div className="message-list">
          {visibleMessages(messages).length === 0 && (
            <div className="empty-state">
              <h2>Ask QTask anything</h2>
              <p>Try: &quot;Create a project called Q1 Launch with three tasks&quot;</p>
            </div>
          )}

          {visibleMessages(messages).map((message) => (
            <article key={message.id} className={`message message-${message.role}`}>
              <header className="message-header">
                <span>{message.role === 'user' ? 'You' : 'QTask'}</span>
                {message.role === 'user' && (
                  <button
                    type="button"
                    className="message-action-button"
                    onClick={() => handleUseAgain(message.content)}
                  >
                    Use again
                  </button>
                )}
              </header>

              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className="tool-badges">
                  {message.toolCalls.map((call, index) => (
                    <span
                      key={`${call.name}-${index}`}
                      className={`tool-badge ${call.success === false ? 'error' : call.success ? 'success' : ''}`}
                    >
                      {call.name}
                    </span>
                  ))}
                </div>
              )}

              {message.toolCalls?.map(
                (call, index) =>
                  call.success === false &&
                  call.errorContent && (
                    <p key={`err-${call.name}-${index}`} className="tool-error-detail">
                      {call.errorContent}
                    </p>
                  )
              )}

              {message.warnings?.map((warning, index) => (
                <p key={`warn-${index}`} className="warning-banner">
                  {warning}
                </p>
              ))}

              {message.proposals && message.proposals.length > 0 && (
                <div className="tool-proposals">
                  {message.proposals.map((proposal) => {
                    const editKey = `${message.id}:${proposal.id}`;
                    const isEditing = editingKey === editKey;

                    return (
                      <div
                        key={proposal.id}
                        className={`tool-proposal-card ${proposal.status !== 'pending' ? 'resolved' : ''}`}
                      >
                        <div className="tool-proposal-header">
                          <strong>{proposal.name}</strong>
                          <span className="tool-proposal-source">
                            {proposalSourceLabel(proposal.source)}
                          </span>
                          {(proposal.staged || proposal.stagedEntity) && proposal.status === 'pending' && (
                            <span className="tool-proposal-source">staged — awaiting commit</span>
                          )}
                          {proposal.status !== 'pending' && (
                            <span className={`tool-proposal-status ${proposal.status}`}>
                              {proposal.status}
                            </span>
                          )}
                        </div>

                        {isEditing ? (
                          <>
                            <textarea
                              className="tool-proposal-edit"
                              value={editDraft}
                              onChange={(event) => setEditDraft(event.target.value)}
                              rows={10}
                              disabled={submittingProposal}
                            />
                            {editError && <p className="tool-proposal-edit-error">{editError}</p>}
                            <div className="tool-proposal-actions">
                              <button
                                type="button"
                                className="primary-button"
                                disabled={submittingProposal}
                                onClick={() => handleSubmitEditedProposal(message.id, proposal)}
                              >
                                {submittingProposal ? 'Submitting…' : 'Submit'}
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={submittingProposal}
                                onClick={cancelEditingProposal}
                              >
                                Cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <pre className="tool-proposal-args">
                              {JSON.stringify(proposal.arguments, null, 2)}
                            </pre>
                            <div className="tool-proposal-actions">
                              {proposal.status === 'pending' && isPersistedProposal(proposal) && (
                                preferences.autoApproveProposals ? (
                                  <>
                                    <p className="auto-approve-hint">
                                      {approvingId === proposal.id ? 'Auto-approving…' : 'Auto-approve enabled'}
                                    </p>
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      disabled={approvingId !== null}
                                      onClick={() => handleProposalAction(message.id, proposal, 'reject')}
                                    >
                                      Reject
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="primary-button"
                                      disabled={approvingId !== null}
                                      onClick={() =>
                                        handleProposalAction(message.id, proposal, 'approve', {
                                          dontAskAgain: dontAskAgainApprove,
                                        })
                                      }
                                    >
                                      {approvingId === proposal.id
                                        ? proposal.staged || proposal.stagedEntity
                                          ? 'Committing…'
                                          : 'Running…'
                                        : proposal.staged || proposal.stagedEntity
                                          ? 'Commit'
                                          : 'Approve'}
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      disabled={approvingId !== null}
                                      onClick={() => handleProposalAction(message.id, proposal, 'reject')}
                                    >
                                      Reject
                                    </button>
                                    <label className="dont-ask-again">
                                      <input
                                        type="checkbox"
                                        checked={dontAskAgainApprove}
                                        disabled={approvingId !== null}
                                        onChange={(event) => setDontAskAgainApprove(event.target.checked)}
                                      />
                                      <span>Don&apos;t ask again</span>
                                    </label>
                                  </>
                                )
                              )}
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={approvingId !== null || submittingProposal}
                                onClick={() => startEditingProposal(message.id, proposal)}
                              >
                                Edit &amp; retry
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {message.paused && hasPendingProposals(message) && (
                <p className="muted paused-hint">Waiting for your approval to continue.</p>
              )}

              {message.role === 'assistant' &&
                !message.streaming &&
                contentRequestsApproval(message.content) &&
                !hasPendingProposals(message) && (
                  <p className="warning-banner orphan-approval-warning">
                    This action wasn&apos;t submitted as an approvable proposal. Try rephrasing your
                    request or reload the conversation.
                  </p>
                )}

              <p>{message.content || (message.streaming ? '…' : '')}</p>
            </article>
          ))}
          <div ref={bottomRef} />
        </div>

        {error && <p className="error-banner">{error}</p>}

        {pendingProposals.length > 0 && (
          <div className="approval-bar">
            <div className="approval-bar-summary">
              <strong>Pending approval</strong>
              {pendingProposals.map(({ proposal }) => (
                <span key={proposal.id} className="approval-bar-item">
                  {proposal.name}: {proposalSummary(proposal)}
                </span>
              ))}
            </div>
            <div className="approval-bar-actions">
              {pendingProposals.slice(0, 1).map(({ messageId, proposal }) => (
                <span key={proposal.id} className="approval-bar-buttons">
                  {preferences.autoApproveProposals ? (
                    <>
                      <p className="auto-approve-hint">
                        {approvingId === proposal.id ? 'Auto-approving…' : 'Auto-approve enabled'}
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={approvingId !== null}
                        onClick={() => handleProposalAction(messageId, proposal, 'reject')}
                      >
                        Reject
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={approvingId !== null}
                        onClick={() =>
                          handleProposalAction(messageId, proposal, 'approve', {
                            dontAskAgain: dontAskAgainApprove,
                          })
                        }
                      >
                        {approvingId === proposal.id
                          ? proposal.staged || proposal.stagedEntity
                            ? 'Committing…'
                            : 'Running…'
                          : proposal.staged || proposal.stagedEntity
                            ? 'Commit'
                            : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={approvingId !== null}
                        onClick={() => handleProposalAction(messageId, proposal, 'reject')}
                      >
                        Reject
                      </button>
                      <label className="dont-ask-again">
                        <input
                          type="checkbox"
                          checked={dontAskAgainApprove}
                          disabled={approvingId !== null}
                          onChange={(event) => setDontAskAgainApprove(event.target.checked)}
                        />
                        <span>Don&apos;t ask again</span>
                      </label>
                    </>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        <form className="chat-input" onSubmit={handleSend}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              pendingProposals.length > 0
                ? preferences.autoApproveProposals
                  ? 'Pending actions will be approved automatically…'
                  : 'Type a message, or "approve" to confirm the pending action…'
                : 'Create tasks, search work, summarize a project…'
            }
            rows={3}
            disabled={sending}
          />
          <button type="submit" className="primary-button" disabled={sending || !input.trim()}>
            {sending ? 'Thinking…' : 'Send'}
          </button>
        </form>
      </section>

      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.kind === 'delete' ? 'Delete chat' : 'Reset chat'}
          message={
            pendingConfirm.kind === 'delete'
              ? `Delete "${pendingConfirm.conversation.title}"?\n\nThis removes the chat history. Existing tasks stay, but unapproved drafts from this chat will be discarded.`
              : `Reset "${pendingConfirm.conversation.title}"?\n\nThis clears the chat history so you can reuse this chat. The original prompt is kept when available. Existing tasks stay, but unapproved drafts from this chat will be discarded.`
          }
          confirmLabel={pendingConfirm.kind === 'delete' ? 'Delete' : 'Reset'}
          busy={confirmBusy}
          onCancel={() => {
            if (!confirmBusy) setPendingConfirm(null);
          }}
          onConfirm={(dontAskAgain) => handleConfirmDialog(dontAskAgain)}
        />
      )}
    </div>
  );
}
