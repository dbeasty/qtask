import { useEffect, useRef, useState } from 'react';
import {
  approveProposal,
  getConversation,
  listConversations,
  streamChat,
  submitProposal,
} from '../api/client';
import type { ChatStreamEvent, ConversationSummary, StoredMessage, UiMessage, UiProposal } from '../types';

interface ChatPageProps {
  onTasksChanged: () => void;
}

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

export function ChatPage({ onTasksChanged }: ChatPageProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listConversations()
      .then(({ conversations: items }) => setConversations(items))
      .catch((err: Error) => setError(err.message));
  }, []);

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
    action: 'approve' | 'reject'
  ) {
    if (!conversationId || approvingId || !isPersistedProposal(proposal)) return;

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
    }
  }

  function startNewConversation() {
    setConversationId(undefined);
    setMessages([]);
    setError(null);
    setEditingKey(null);
    setEditError(null);
  }

  const pendingProposals = getPendingProposals(messages);

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <button type="button" className="primary-button" onClick={startNewConversation}>
          New chat
        </button>
        <ul className="conversation-list">
          {conversations.map((conversation) => (
            <li key={conversation._id}>
              <button
                type="button"
                className={conversation._id === conversationId ? 'active' : ''}
                onClick={() => loadConversation(conversation._id)}
              >
                {conversation.title}
              </button>
            </li>
          ))}
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
                                <>
                                  <button
                                    type="button"
                                    className="primary-button"
                                    disabled={approvingId !== null}
                                    onClick={() => handleProposalAction(message.id, proposal, 'approve')}
                                  >
                                    {approvingId === proposal.id ? 'Running…' : 'Approve'}
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    disabled={approvingId !== null}
                                    onClick={() => handleProposalAction(message.id, proposal, 'reject')}
                                  >
                                    Reject
                                  </button>
                                </>
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
                  <button
                    type="button"
                    className="primary-button"
                    disabled={approvingId !== null}
                    onClick={() => handleProposalAction(messageId, proposal, 'approve')}
                  >
                    {approvingId === proposal.id ? 'Running…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={approvingId !== null}
                    onClick={() => handleProposalAction(messageId, proposal, 'reject')}
                  >
                    Reject
                  </button>
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
                ? 'Type a message, or "approve" to confirm the pending action…'
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
    </div>
  );
}
