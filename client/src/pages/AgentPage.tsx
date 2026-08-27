import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  approveProposal,
  deleteConversation,
  duplicateConversation,
  getConversation,
  listConversations,
  listProjects,
  resetConversation,
  streamAgent,
  submitProposal,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { getUserPreferences } from '../auth/storage';
import { AgentCommandPalette } from '../components/AgentCommandPalette';
import { AgentEntityLink } from '../components/AgentEntityLink';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConversationMenu } from '../components/ConversationMenu';
import { CurrentProjectBar } from '../components/CurrentProjectBar';
import type { AgentStreamEvent, ConversationSummary, Project, StoredMessage, TaskStatus, UiMessage, UiProposal } from '../types';
import { displayMessageContent, proposalDisplayLabel, type DisplayMessageContentOptions } from '../utils/agentContent';
import {
  aggregateDedupedEntityLinks,
  entityLinkSectionsFromToolCalls,
  filterToolCallsEntityLinks,
  getApprovedProposalEntityLinks,
  getProposalEntityLinks,
  visibleProposals,
} from '../utils/agentEntityLink';
import { buildUiMessagesFromConversation } from '../utils/mergeAssistantTurns';
import { suggestProjectFromMessages } from '../utils/project';
import { mergeAppSessionStateDebounced } from '../utils/appSessionState';
import { handleAgentInputKeyDown } from '../utils/agentInputKeyboard';
import {
  AGENT_INPUT_IDLE_PLACEHOLDER,
  applyInstructionSelection,
  buildAgentCommandPaletteItems,
  clampPaletteHighlightIndex,
  filterAgentCommandPaletteItems,
  isCommandPaletteOpen,
  parseSlashCommand,
  resolveCommandPaletteKeyDown,
  type AgentCommandPaletteItem,
} from '../utils/agentCommandPalette';
import { findProjectByName, parseActiveProjectSwitchCommand, projectForSwitchPrompt, projectNameFromProposal, shouldOfferSwitchAfterCreateProject, type ProjectSwitchTarget } from '../utils/agentProjectSwitch';
import { shouldBlockAgentSend } from '../utils/agentSendGuard';
import { toggleTaskDone } from '../utils/taskDoneToggle';

function applyTaskStatusToMessages(
  messages: UiMessage[],
  taskId: string,
  status: TaskStatus,
  percentComplete: number
): UiMessage[] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({
      ...call,
      entityLinks: call.entityLinks?.map((link) =>
        link.kind === 'task' && link.id === taskId
          ? { ...link, status, percentComplete }
          : link
      ),
    })),
    proposals: message.proposals?.map((proposal) => {
      const proposalTaskId = proposal.arguments.taskId;
      if (typeof proposalTaskId !== 'string' || proposalTaskId !== taskId) return proposal;
      return {
        ...proposal,
        arguments: {
          ...proposal.arguments,
          status,
          percentComplete,
        },
      };
    }),
  }));
}

interface AgentPageProps {
  onTasksChanged: () => void;
  onProjectsChanged?: () => void;
  onProjectSuggested?: (name: string) => void;
  activeProjectId: string | null;
  onActiveProjectChange?: (projectId: string) => void;
  onOpenTask?: (taskId: string, projectId?: string) => void;
  onOpenProject?: (projectId: string) => void;
  onNeedProject?: () => void;
  externalRefreshKey?: number;
  projectsRefreshKey?: number;
  demoPrompt?: string | null;
  demoPromptGeneration?: number;
  onDemoPromptConsumed?: () => void;
  restoredConversationId?: string;
  onSessionRestoreConsumed?: () => void;
  isActive?: boolean;
  onAgentWorkingChange?: (working: boolean) => void;
  editsDisabled?: boolean;
}

type PendingConfirm =
  | { kind: 'delete'; conversation: ConversationSummary }
  | { kind: 'reset'; conversation: ConversationSummary }
  | {
      kind: 'switchProject';
      targetProject: ProjectSwitchTarget;
      currentProjectName?: string;
      hasPendingProposals?: boolean;
      reason?: 'afterCreate';
    };

function visibleMessages(messages: UiMessage[]) {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant');
}

function proposalSourceLabel(source: UiProposal['source']) {
  if (source === 'text_fallback') return 'text fallback';
  if (source === 'manual') return 'manual';
  return null;
}

function unwrapTaskTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const inner = JSON.parse(trimmed) as {
      title?: string;
      parameters?: { title?: string };
    };
    if (typeof inner.parameters?.title === 'string') return inner.parameters.title;
    if (typeof inner.title === 'string') return inner.title;
  } catch {
    // keep original
  }
  return trimmed;
}

function isPersistedProposal(proposal: UiProposal) {
  return !proposal.id.startsWith('hist-');
}

const APPROVAL_PHRASES = /^(approve|approved|yes|go ahead|looks good|do it|confirm)\.?$/i;

interface PendingProposalRef {
  messageId: string;
  proposal: UiProposal;
}

function findPendingStagedProjectByName(
  name: string,
  messages: UiMessage[]
): UiProposal | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;

  for (const message of messages) {
    for (const proposal of message.proposals ?? []) {
      if (proposal.status !== 'pending' || proposal.name !== 'create_project') continue;
      const projectName =
        typeof proposal.arguments.name === 'string' ? proposal.arguments.name.trim().toLowerCase() : '';
      if (projectName === normalized) return proposal;
    }
  }

  return undefined;
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
  if (typeof args.title === 'string') return unwrapTaskTitle(args.title);
  if (typeof args.name === 'string') return args.name;
  if (typeof args.taskId === 'string') return args.taskId;
  return proposal.name;
}

function proposalCardTitle(proposal: UiProposal): string {
  const label = proposalDisplayLabel(proposal.name);
  const summary = proposalSummary(proposal);
  return `${label}: ${summary}`;
}

type ApprovalPhase = 'committing' | 'continuing' | 'running_tool';

interface ApprovalProgress {
  proposalId: string;
  phase: ApprovalPhase;
  toolName?: string;
  statusMessage?: string;
}

function normalizeApprovalStatusMessage(message: string): string {
  if (message === 'Working…') return 'Reviewing tool results…';
  return message;
}

function approvalProgressLabel(
  proposal: UiProposal,
  progress: ApprovalProgress | null
): string | null {
  if (!progress || progress.proposalId !== proposal.id) return null;
  if (progress.phase === 'running_tool' && progress.toolName) {
    return `Running ${proposalDisplayLabel(progress.toolName)}…`;
  }
  if (progress.phase === 'continuing') {
    return progress.statusMessage ?? 'Reviewing tool results…';
  }
  if (progress.phase === 'committing') {
    return proposal.staged || proposal.stagedEntity ? 'Committing…' : 'Running…';
  }
  return null;
}

function approvalActionLabel(
  proposal: UiProposal,
  approvingId: string | null,
  progress: ApprovalProgress | null
): string {
  if (approvingId !== proposal.id) {
    return proposal.staged || proposal.stagedEntity ? 'Commit' : 'Approve';
  }
  return (
    approvalProgressLabel(proposal, progress) ??
    (proposal.staged || proposal.stagedEntity ? 'Committing…' : 'Running…')
  );
}

function autoApproveProgressLabel(progress: ApprovalProgress | null): string {
  if (!progress) return 'Auto-approving…';
  if (progress.phase === 'running_tool' && progress.toolName) {
    return `Running ${proposalDisplayLabel(progress.toolName)}…`;
  }
  if (progress.phase === 'continuing') {
    return progress.statusMessage ?? 'Reviewing tool results…';
  }
  return 'Auto-approving…';
}

function clearStatusMessage(message: UiMessage): UiMessage {
  if (!message.statusMessage) return message;
  const { statusMessage: _removed, ...rest } = message;
  return rest;
}

function toggleProposalExpanded(
  setExpandedProposalKeys: React.Dispatch<React.SetStateAction<Set<string>>>,
  key: string
) {
  setExpandedProposalKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
}

function toggleAssistantExpanded(
  setExpandedAssistantKeys: React.Dispatch<React.SetStateAction<Set<string>>>,
  messageId: string
) {
  setExpandedAssistantKeys((prev) => {
    const next = new Set(prev);
    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }
    return next;
  });
}

function messageHasStructuredResults(
  message: UiMessage,
  options: DisplayMessageContentOptions
): boolean {
  if (message.toolCalls?.some((call) => call.entityLinks && call.entityLinks.length > 0)) {
    return true;
  }
  return (
    message.proposals?.some(
      (proposal) =>
        getProposalEntityLinks(
          proposal,
          options.activeProjectId ?? null,
          options.resolveProjectLabel
        ).length > 0
    ) ?? false
  );
}

function shouldCollapseAssistantBody(
  message: UiMessage,
  options: DisplayMessageContentOptions
): boolean {
  if (message.role !== 'assistant' || message.streaming) return false;
  const content = displayMessageContent(message, options);
  if (!content) return false;
  return messageHasStructuredResults(message, options);
}

function handleStreamEvent(
  event: AgentStreamEvent,
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>,
  setConversationId: React.Dispatch<React.SetStateAction<string | undefined>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>
): { toolsTouched: boolean } {
  let toolsTouched = false;

  if (event.type === 'status') {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? { ...message, statusMessage: event.message }
          : message
      )
    );
  }

  if (event.type === 'token') {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? clearStatusMessage({
              ...message,
              content: message.content + event.content,
            })
          : message
      )
    );
  }

  if (event.type === 'tool_call') {
    toolsTouched = true;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? clearStatusMessage({
              ...message,
              toolCalls: [...(message.toolCalls ?? []), { name: event.name, arguments: event.arguments }],
            })
          : message
      )
    );
  }

  if (event.type === 'tool_result') {
    toolsTouched = true;
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== assistantId) return message;

        const toolCalls = [...(message.toolCalls ?? [])];
        const pendingIndex = toolCalls.findIndex((call) => call.success === undefined);
        if (pendingIndex >= 0) {
          toolCalls[pendingIndex] = {
            ...toolCalls[pendingIndex]!,
            success: event.success,
            errorContent: event.success ? undefined : event.content,
            entityLinks: event.entityLinks,
          };
        }

        return { ...message, toolCalls };
      })
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
                  stagedEntity: event.stagedEntity,
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

  if (event.type === 'aborted') {
    setConversationId(event.conversationId);
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? clearStatusMessage({
              ...message,
              streaming: false,
              stopped: true,
              statusMessage: 'Stopped',
            })
          : message
      )
    );
  }

  if (event.type === 'done') {
    setConversationId(event.conversationId);
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? clearStatusMessage({
              ...message,
              content: event.content || message.content,
              streaming: false,
              paused: event.paused ?? message.paused,
            })
          : message
      )
    );
    listConversations()
      .then(({ conversations: items }) => {
        void items;
      })
      .catch(() => {
        // best-effort background refresh; ignore failures
      });
  }

  return { toolsTouched };
}

export function AgentPage({
  onTasksChanged,
  onProjectsChanged,
  onProjectSuggested,
  activeProjectId,
  onActiveProjectChange,
  onOpenTask,
  onOpenProject,
  onNeedProject,
  externalRefreshKey = 0,
  projectsRefreshKey = 0,
  demoPrompt,
  demoPromptGeneration = 0,
  onDemoPromptConsumed,
  restoredConversationId,
  onSessionRestoreConsumed,
  isActive = true,
  onAgentWorkingChange,
  editsDisabled = false,
}: AgentPageProps) {
  const { user, updatePreferences } = useAuth();
  const preferences = getUserPreferences(user);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [paletteHighlightIndex, setPaletteHighlightIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approvalProgress, setApprovalProgress] = useState<ApprovalProgress | null>(null);
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedProposalKeys, setExpandedProposalKeys] = useState<Set<string>>(() => new Set());
  const [togglingTaskId, setTogglingTaskId] = useState<string | null>(null);
  const [expandedAssistantKeys, setExpandedAssistantKeys] = useState<Set<string>>(() => new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const autoApproveInFlightRef = useRef(false);
  const lastExternalRefreshKey = useRef(externalRefreshKey);
  const lastProjectsRefreshKey = useRef(projectsRefreshKey);
  const conversationIdRef = useRef<string | undefined>(undefined);
  conversationIdRef.current = conversationId;
  const sessionRestoreAppliedRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const projectFetchIdRef = useRef(0);
  const conversationLoadIdRef = useRef(0);

  const paletteItems = useMemo(() => buildAgentCommandPaletteItems(), []);
  const slashCommand = parseSlashCommand(input);
  const filteredPaletteItems = useMemo(() => {
    if (!slashCommand) return [];
    return filterAgentCommandPaletteItems(paletteItems, slashCommand.query);
  }, [paletteItems, slashCommand]);
  const paletteOpen = isCommandPaletteOpen(input) && !paletteDismissed;

  useEffect(() => {
    if (!isCommandPaletteOpen(input)) {
      setPaletteDismissed(false);
    }
  }, [input]);

  useEffect(() => {
    setPaletteHighlightIndex(0);
  }, [slashCommand?.query, paletteDismissed]);

  function selectPaletteItem(item: AgentCommandPaletteItem) {
    setInput(applyInstructionSelection(item));
    setPaletteDismissed(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const resolveProjectLabel = useMemo(
    () => (projectId: string) => projects.find((project) => project._id === projectId)?.name,
    [projects]
  );

  const displayContentOptions = useMemo<DisplayMessageContentOptions>(
    () => ({ activeProjectId, resolveProjectLabel }),
    [activeProjectId, resolveProjectLabel]
  );

  function abortActiveStream() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }

  useEffect(() => {
    onAgentWorkingChange?.(sending || approvingId !== null);
  }, [sending, approvingId, onAgentWorkingChange]);

  useEffect(() => {
    mergeAppSessionStateDebounced({
      agent: conversationId ? { conversationId } : {},
    });
  }, [conversationId]);

  useEffect(() => {
    if (!demoPrompt?.trim()) return;
    setInput(demoPrompt);
    onDemoPromptConsumed?.();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [demoPrompt, demoPromptGeneration, onDemoPromptConsumed]);

  useEffect(() => {
    sessionRestoreAppliedRef.current = false;
  }, [activeProjectId]);

  useEffect(() => {
    abortActiveStream();
    const fetchId = ++projectFetchIdRef.current;
    if (!activeProjectId) {
      setConversations([]);
      setConversationId(undefined);
      setMessages([]);
      return;
    }
    listConversations(activeProjectId)
      .then(({ conversations: items }) => {
        if (fetchId !== projectFetchIdRef.current) return;
        setConversations(items);
      })
      .catch((err: Error) => {
        if (fetchId !== projectFetchIdRef.current) return;
        setError(err.message);
      });
    listProjects()
      .then(({ projects: items }) => {
        if (fetchId !== projectFetchIdRef.current) return;
        setProjects(items);
      })
      .catch(() => {
        // optional for project suggestion
      });
    setConversationId(undefined);
    setMessages([]);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (externalRefreshKey === lastExternalRefreshKey.current) return;
    lastExternalRefreshKey.current = externalRefreshKey;

    listConversations(activeProjectId)
      .then(({ conversations: items }) => setConversations(items))
      .catch((err: Error) => setError(err.message));
    listProjects()
      .then(({ projects: items }) => setProjects(items))
      .catch(() => {
        // optional for project suggestion
      });

    const openId = conversationIdRef.current;
    if (openId) {
      void syncConversationFromServer(openId).catch((err: Error) => setError(err.message));
    }
  }, [externalRefreshKey, activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (projectsRefreshKey === lastProjectsRefreshKey.current) return;
    lastProjectsRefreshKey.current = projectsRefreshKey;

    listProjects()
      .then(({ projects: items }) => setProjects(items))
      .catch(() => {
        // optional for project suggestion
      });
  }, [projectsRefreshKey, activeProjectId]);

  useEffect(() => {
    if (!restoredConversationId || sessionRestoreAppliedRef.current || !activeProjectId) return;
    if (conversations.length === 0) return;

    sessionRestoreAppliedRef.current = true;
    onSessionRestoreConsumed?.();

    const match = conversations.find((item) => item._id === restoredConversationId);
    if (!match) return;

    let cancelled = false;
    setConversationId(restoredConversationId);
    setError(null);
    setEditingKey(null);
    setEditError(null);

    getConversation(restoredConversationId)
      .then(({ conversation }) => {
        if (cancelled) return;
        const visibleStored = conversation.messages.filter(
          (message) => message.role === 'user' || message.role === 'assistant'
        );
        const uiMessages = buildUiMessagesFromConversation(
          restoredConversationId,
          visibleStored,
          conversation.messageProposals ?? {},
          conversation.messageToolResults ?? {}
        );
        setMessages(uiMessages);
        setSidebarOpen(false);
      })
      .catch((err: Error) => setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [restoredConversationId, activeProjectId, conversations, onSessionRestoreConsumed]);

  useEffect(() => {
    if (!onSessionRestoreConsumed || sessionRestoreAppliedRef.current) return;
    if (restoredConversationId) return;
    sessionRestoreAppliedRef.current = true;
    onSessionRestoreConsumed();
  }, [restoredConversationId, onSessionRestoreConsumed]);

  useEffect(() => {
    const suggested = suggestProjectFromMessages(messages, projects);
    if (suggested) {
      onProjectSuggested?.(suggested);
    }
  }, [messages, projects, onProjectSuggested]);

  useEffect(() => {
    if (!isActive) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, approvingId, submittingProposal, isActive]);

  async function syncConversationFromServer(id: string, keepStreaming = false) {
    const { conversation } = await getConversation(id);
    const visibleStored = conversation.messages.filter(
      (message) => message.role === 'user' || message.role === 'assistant'
    );

    setMessages((prev) => {
      const streaming = keepStreaming ? prev.filter((message) => message.streaming) : [];
      const uiMessages = buildUiMessagesFromConversation(
        id,
        visibleStored,
        conversation.messageProposals ?? {},
        conversation.messageToolResults ?? {}
      );
      return [...uiMessages, ...streaming];
    });
  }

  async function loadConversation(id: string) {
    const loadId = ++conversationLoadIdRef.current;
    setConversationId(id);
    setError(null);
    setEditingKey(null);
    setEditError(null);

    const { conversation } = await getConversation(id);
    if (loadId !== conversationLoadIdRef.current) return;

    const visibleStored = conversation.messages.filter(
      (message) => message.role === 'user' || message.role === 'assistant'
    );

    const uiMessages = buildUiMessagesFromConversation(
      id,
      visibleStored,
      conversation.messageProposals ?? {},
      conversation.messageToolResults ?? {}
    );
    setMessages(uiMessages);
    setSidebarOpen(false);
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
      setEditError('Load or start a session before submitting a proposal');
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

  async function handleStop() {
    abortActiveStream();
    setSending(false);
    setApprovingId(null);
    setApprovalProgress(null);
    setMessages((prev) =>
      prev.map((message) =>
        message.streaming
          ? {
              ...message,
              streaming: false,
              stopped: true,
              statusMessage: 'Stopped',
            }
          : message
      )
    );
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (editsDisabled) return;
    const text = input.trim();
    if (!text) return;

    if (shouldBlockAgentSend(sending, approvingId, conversationId)) {
      setError('Please wait for the current response before sending another message.');
      return;
    }

    if (sending || approvingId) {
      abortActiveStream();
    }

    const pending = getPendingProposals(messages);
    if (pending.length > 0 && APPROVAL_PHRASES.test(text)) {
      setInput('');
      const first = pending[0]!;
      await handleProposalAction(first.messageId, first.proposal, 'approve');
      return;
    }

    const switchProjectName = parseActiveProjectSwitchCommand(text);
    if (switchProjectName) {
      setInput('');
      const targetProject = findProjectByName(switchProjectName, projects);
      if (!targetProject) {
        const stagedProject = findPendingStagedProjectByName(switchProjectName, messages);
        if (stagedProject) {
          setError(
            `Project "${switchProjectName}" is staged and awaiting approval. Commit it first, then switch.`
          );
        } else {
          setError(`No project named "${switchProjectName}" found.`);
        }
        return;
      }
      if (targetProject._id === activeProjectId) {
        setError(`Already on project "${targetProject.name}".`);
        return;
      }
      if (!onActiveProjectChange) {
        setError('Project switching is unavailable.');
        return;
      }
      if (sending || approvingId) {
        abortActiveStream();
      }
      setError(null);
      setPendingConfirm({
        kind: 'switchProject',
        targetProject,
        currentProjectName: projects.find((project) => project._id === activeProjectId)?.name,
        hasPendingProposals: pending.length > 0,
      });
      return;
    }

    setInput('');
    setSending(true);
    setError(null);

    const abortController = new AbortController();
    streamAbortRef.current = abortController;

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
    let aborted = false;

    try {
      await streamAgent(
        text,
        conversationId,
        (event) => {
          const result = handleStreamEvent(event, assistantId, setMessages, setConversationId, setError);
          if (result.toolsTouched) toolsTouched = true;
          if (event.type === 'aborted') {
            aborted = true;
            resolvedConversationId = event.conversationId;
          }
          if (event.type === 'done') {
            resolvedConversationId = event.conversationId;
            if (activeProjectId) {
              listConversations(activeProjectId)
                .then(({ conversations: items }) => setConversations(items))
                .catch(() => {
                  // best-effort background refresh; ignore failures
                });
            }
          }
        },
        activeProjectId ?? undefined,
        abortController.signal
      );

      if (resolvedConversationId && !aborted) {
        await syncConversationFromServer(resolvedConversationId);
      } else if (aborted && resolvedConversationId) {
        await syncConversationFromServer(resolvedConversationId).catch(() => {
          // ignore sync errors after abort
        });
      }

      if (toolsTouched && !aborted) {
        onTasksChanged();
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // handled via aborted event or handleStop
      } else {
        setError(err instanceof Error ? err.message : 'Agent request failed');
        setMessages((prev) => prev.filter((message) => message.id !== assistantId));
      }
    } finally {
      if (streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
        setSending(false);
      }
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId && message.streaming
            ? { ...message, streaming: false }
            : message
        )
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
    setApprovalProgress({ proposalId: proposal.id, phase: 'committing' });
    setError(null);

    const abortController = new AbortController();
    streamAbortRef.current = abortController;

    const assistantId = messageId;
    let toolsTouched = false;
    let aborted = false;

    try {
      await approveProposal(conversationId, proposal.id, action, (event) => {
        handleStreamEvent(event, assistantId, setMessages, setConversationId, setError);
        if (event.type === 'aborted') aborted = true;

        if (event.type === 'tool_result' && event.success) {
          toolsTouched = true;
          if (action === 'approve') {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      proposals: (message.proposals ?? []).map((p) =>
                        p.id === proposal.id ? { ...p, status: 'approved' as const } : p
                      ),
                    }
                  : message
              )
            );
          }
        }

        if (event.type === 'status') {
          setApprovalProgress((prev) => {
            if (!prev || prev.proposalId !== proposal.id) return prev;
            const statusMessage = normalizeApprovalStatusMessage(event.message);
            return {
              ...prev,
              phase: prev.phase === 'committing' ? 'continuing' : prev.phase,
              statusMessage,
            };
          });
        }

        if (event.type === 'tool_call') {
          setApprovalProgress((prev) => {
            if (!prev || prev.proposalId !== proposal.id) return prev;
            return {
              ...prev,
              phase: 'running_tool',
              toolName: event.name,
            };
          });
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
          listConversations(activeProjectId ?? undefined)
            .then(({ conversations: items }) => setConversations(items))
            .catch(() => {
              // best-effort background refresh; ignore failures
            });
          syncConversationFromServer(conversationId).catch(() => {
            // ignore sync errors after approval
          });
        }
      }, abortController.signal);

      if (action === 'approve' && toolsTouched && !aborted) {
        onTasksChanged();
        onProjectsChanged?.();

        const switchProjectId = shouldOfferSwitchAfterCreateProject(
          proposal,
          activeProjectId,
          action
        );
        if (switchProjectId && onActiveProjectChange) {
          let refreshedProjects = projects;
          try {
            const { projects: items } = await listProjects();
            refreshedProjects = items;
            setProjects(items);
          } catch {
            // keep local list
          }

          const name = projectNameFromProposal(proposal) ?? 'New project';
          const targetProject = projectForSwitchPrompt(switchProjectId, name, refreshedProjects);
          setPendingConfirm({
            kind: 'switchProject',
            reason: 'afterCreate',
            targetProject,
            currentProjectName: refreshedProjects.find((project) => project._id === activeProjectId)
              ?.name,
            hasPendingProposals: false,
          });
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Approval failed');
      }
    } finally {
      if (streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
      }
      setApprovingId(null);
      setApprovalProgress(null);
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
      setError(err instanceof Error ? err.message : 'Could not delete session');
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
      setError(err instanceof Error ? err.message : 'Could not reset session');
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
      setError(err instanceof Error ? err.message : 'Could not duplicate session');
    } finally {
      setDuplicatingConversationId(null);
    }
  }

  async function handleConfirmDialog(dontAskAgain: boolean) {
    if (!pendingConfirm) return;
    setConfirmBusy(true);
    try {
      if (pendingConfirm.kind === 'switchProject') {
        abortActiveStream();
        onActiveProjectChange?.(pendingConfirm.targetProject._id);
        setPendingConfirm(null);
        setError(null);
        return;
      }
      if (dontAskAgain && !preferences.skipConfirmations) {
        await updatePreferences({ skipConfirmations: true });
      }
      if (pendingConfirm.kind === 'delete') {
        await performDeleteConversation(pendingConfirm.conversation);
      } else if (pendingConfirm.kind === 'reset') {
        await performResetConversation(pendingConfirm.conversation);
      }
      setPendingConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save preference');
    } finally {
      setConfirmBusy(false);
    }
  }

  function switchProjectConfirmMessage(confirm: Extract<PendingConfirm, { kind: 'switchProject' }>): string {
    const fromLabel = confirm.currentProjectName ?? 'the current project';
    const lines =
      confirm.reason === 'afterCreate'
        ? [
            `${confirm.targetProject.name} was created. Switch active project from ${fromLabel} to ${confirm.targetProject.name}?`,
          ]
        : [`Switch active project from ${fromLabel} to ${confirm.targetProject.name}?`];
    lines.push(
      '',
      `Your current chat stays saved under ${fromLabel}. The agent will show ${confirm.targetProject.name}'s conversations with a fresh chat.`
    );
    if (confirm.hasPendingProposals) {
      lines.push('', 'Unapproved drafts remain in the current session.');
    }
    return lines.join('\n');
  }

  const pendingProposals = getPendingProposals(messages);
  const agentWorking = sending || approvingId !== null;
  const activeProject = useMemo(
    () => projects.find((project) => project._id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const canToggleTaskLink = useCallback(
    (projectId: string | undefined) => {
      if (editsDisabled || !projectId) return false;
      const project = projects.find((item) => item._id === projectId);
      return Boolean(project?.canEdit || project?.canUpdateStatus);
    },
    [editsDisabled, projects]
  );

  const canEditTaskLink = useCallback(
    (projectId: string | undefined) => {
      if (editsDisabled || !projectId) return false;
      const project = projects.find((item) => item._id === projectId);
      return Boolean(project?.canEdit);
    },
    [editsDisabled, projects]
  );

  const handleToggleTaskLinkDone = async (
    taskId: string,
    projectId: string | undefined,
    done: boolean
  ) => {
    setTogglingTaskId(taskId);
    setError(null);
    try {
      const canEdit = canEditTaskLink(projectId);
      const task = await toggleTaskDone(taskId, [], done, canEdit);
      setMessages((current) =>
        applyTaskStatusToMessages(current, taskId, task.status, task.percentComplete)
      );
      onTasksChanged();
      onProjectsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setTogglingTaskId(null);
    }
  };

  const conversationActionsBusy =
    sending ||
    approvingId !== null ||
    submittingProposal ||
    deletingConversationId !== null ||
    resettingConversationId !== null ||
    duplicatingConversationId !== null;

  return (
    <section className="tasks-page">
      {activeProjectId ? (
        <CurrentProjectBar
          activeProject={activeProject}
          projects={projects}
          projectCount={projects.length}
          onOpenProjects={() => onNeedProject?.()}
          onSelectProject={onActiveProjectChange}
        />
      ) : null}
      <div className="agent-layout">
      {!activeProjectId ? (
        <div className="tasks-empty-state" style={{ gridColumn: '1 / -1' }}>
          <p className="muted">Select a project for the agent to work on.</p>
          <div className="tasks-empty-state-actions">
            <button type="button" className="primary-button" onClick={() => onNeedProject?.()}>
              Open projects
            </button>
          </div>
        </div>
      ) : (
        <>
      <aside className="agent-sidebar">
        <div className="agent-sidebar-toolbar">
          <button type="button" className="primary-button" onClick={startNewConversation}>
            New session
          </button>
          <button
            type="button"
            className="agent-sidebar-toggle secondary-button"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            Sessions{conversations.length > 0 ? ` (${conversations.length})` : ''}
          </button>
        </div>
        <ul className={`conversation-list${sidebarOpen ? ' conversation-list-open' : ''}`}>
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
                  aria-label={`Session actions for ${conversation.title}`}
                  aria-expanded={menuOpen}
                  title="Session actions"
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

      <section className="agent-panel" data-demo-step="agent-panel">
        <div className="message-list">
          {visibleMessages(messages).length === 0 && (
            <div className="empty-state">
              <h2>Ask QTask anything</h2>
              <p>Try: &quot;Create a project called Q1 Launch with three tasks&quot;</p>
            </div>
          )}

          {visibleMessages(messages).map((message) => {
            const filteredToolCalls = filterToolCallsEntityLinks(message.toolCalls ?? []);
            const dedupedToolCallLinks = aggregateDedupedEntityLinks(filteredToolCalls);
            const entityLinkSections = entityLinkSectionsFromToolCalls(filteredToolCalls);
            const approvedProposalLinks = getApprovedProposalEntityLinks(
              message.proposals,
              activeProjectId,
              resolveProjectLabel,
              dedupedToolCallLinks
            );
            const actionableProposals = visibleProposals(message.proposals);

            return (
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

              {entityLinkSections.map((section, sectionIndex) =>
                section.links.length > 0 ? (
                  <div
                    key={`entity-links-${sectionIndex}`}
                    className="agent-entity-link-list"
                  >
                    {section.heading && (
                      <p className="agent-entity-link-list-heading muted">{section.heading}</p>
                    )}
                    {section.links.map((link) => (
                      <AgentEntityLink
                        key={`${link.kind}-${link.id}`}
                        link={link}
                        canToggleDone={canToggleTaskLink(link.projectId)}
                        saving={togglingTaskId === link.id}
                        onToggleDone={handleToggleTaskLinkDone}
                        onOpenTask={(taskId, projectId) => onOpenTask?.(taskId, projectId)}
                        onOpenProject={(projectId) => onOpenProject?.(projectId)}
                      />
                    ))}
                  </div>
                ) : null
              )}

              {approvedProposalLinks.length > 0 && (
                <div className="agent-entity-link-list">
                  {approvedProposalLinks.map((link) => (
                    <AgentEntityLink
                      key={`approved-${link.kind}-${link.id}`}
                      link={link}
                      canToggleDone={canToggleTaskLink(link.projectId)}
                      saving={togglingTaskId === link.id}
                      onToggleDone={handleToggleTaskLinkDone}
                      onOpenTask={(taskId, projectId) => onOpenTask?.(taskId, projectId)}
                      onOpenProject={(projectId) => onOpenProject?.(projectId)}
                    />
                  ))}
                </div>
              )}

              {message.warnings?.map((warning, index) => (
                <p key={`warn-${index}`} className="warning-banner">
                  {warning}
                </p>
              ))}

              {message.streaming &&
                message.toolCalls &&
                message.toolCalls.length > 0 &&
                !message.content && (
                  <p className="agent-working-indicator">
                    Running {message.toolCalls[message.toolCalls.length - 1]?.name ?? 'tool'}…
                  </p>
                )}

              {message.stopped && (
                <p className="agent-stopped-indicator muted">Stopped</p>
              )}

              {actionableProposals.length > 0 && (
                <div className="tool-proposals">
                  {actionableProposals.map((proposal) => {
                    const editKey = `${message.id}:${proposal.id}`;
                    const isEditing = editingKey === editKey;
                    const isExpanded = expandedProposalKeys.has(editKey);
                    const sourceLabel = proposalSourceLabel(proposal.source);
                    const showDetailsByDefault =
                      proposal.status === 'pending' && isEditing ? true : isExpanded;

                    return (
                      <div
                        key={proposal.id}
                        className={`tool-proposal-card ${proposal.status !== 'pending' ? 'resolved' : ''}`}
                      >
                        <div className="tool-proposal-header">
                          <strong>{proposalCardTitle(proposal)}</strong>
                          {sourceLabel && (
                            <span className="tool-proposal-source tool-proposal-source-warn">
                              {sourceLabel}
                            </span>
                          )}
                          {(proposal.staged || proposal.stagedEntity) &&
                            proposal.status === 'pending' && (
                              <span className="tool-proposal-source">Awaiting commit</span>
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
                            {showDetailsByDefault && (
                              <pre className="tool-proposal-args">
                                {JSON.stringify(proposal.arguments, null, 2)}
                              </pre>
                            )}
                            <div className="tool-proposal-actions">
                              {proposal.status === 'pending' && isPersistedProposal(proposal) && (
                                preferences.autoApproveProposals ? (
                                  <>
                                    <p className="auto-approve-hint">
                                      {approvingId === proposal.id
                                        ? autoApproveProgressLabel(
                                            approvalProgress?.proposalId === proposal.id
                                              ? approvalProgress
                                              : null
                                          )
                                        : 'Auto-approve enabled'}
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
                                      {approvalActionLabel(proposal, approvingId, approvalProgress)}
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
                                onClick={() => toggleProposalExpanded(setExpandedProposalKeys, editKey)}
                              >
                                {showDetailsByDefault ? 'Hide details' : 'Show details'}
                              </button>
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
                    request or reload the session.
                  </p>
                )}

              {(() => {
                const displayContent = displayMessageContent(message, displayContentOptions);
                const activeApprovalProgress =
                  approvingId && message.proposals?.some((p) => p.id === approvingId)
                    ? approvalProgress?.proposalId === approvingId
                      ? approvalProgress
                      : null
                    : null;
                const approvalFollowUpActive =
                  activeApprovalProgress?.phase === 'continuing' ||
                  activeApprovalProgress?.phase === 'running_tool';

                if ((message.streaming || approvalFollowUpActive) && !displayContent) {
                  return (
                    <p className="agent-working-indicator">
                      {message.statusMessage ??
                        activeApprovalProgress?.statusMessage ??
                        (activeApprovalProgress?.phase === 'running_tool' &&
                        activeApprovalProgress.toolName
                          ? `Running ${proposalDisplayLabel(activeApprovalProgress.toolName)}…`
                          : 'Reviewing tool results…')}
                    </p>
                  );
                }
                if (displayContent) {
                  const collapsible = shouldCollapseAssistantBody(message, displayContentOptions);
                  const isExpanded = expandedAssistantKeys.has(message.id);
                  if (!collapsible) {
                    return <p className="message-body">{displayContent}</p>;
                  }
                  return (
                    <div className="message-body-collapsible">
                      <button
                        type="button"
                        className="message-body-toggle"
                        aria-expanded={isExpanded}
                        onClick={() =>
                          toggleAssistantExpanded(setExpandedAssistantKeys, message.id)
                        }
                      >
                        <span
                          className={`message-body-chevron ${isExpanded ? 'expanded' : ''}`}
                          aria-hidden="true"
                        >
                          ›
                        </span>
                        <span className="message-body-toggle-label">
                          {isExpanded ? 'Hide response' : 'Show response'}
                        </span>
                      </button>
                      {isExpanded && <div className="message-body">{displayContent}</div>}
                    </div>
                  );
                }
                return null;
              })()}
            </article>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {error && <p className="error-banner">{error}</p>}

        {pendingProposals.length > 0 && (
          <div className="approval-bar" data-demo-step="approval-bar">
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
                        {approvingId === proposal.id
                          ? autoApproveProgressLabel(
                              approvalProgress?.proposalId === proposal.id ? approvalProgress : null
                            )
                          : 'Auto-approve enabled'}
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
                        {approvalActionLabel(proposal, approvingId, approvalProgress)}
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

        <form className="agent-input" onSubmit={handleSend} data-demo-step="agent-input">
          <div className="agent-input-compose">
            <AgentCommandPalette
              open={paletteOpen}
              items={filteredPaletteItems}
              highlightIndex={paletteHighlightIndex}
              onHighlight={setPaletteHighlightIndex}
              onSelect={selectPaletteItem}
            />
            <textarea
              ref={inputRef}
              disabled={editsDisabled}
              value={input}
              onChange={(event) => {
                setPaletteDismissed(false);
                setInput(event.target.value);
              }}
              onKeyDown={(event) => {
                const paletteAction = resolveCommandPaletteKeyDown(event.key, {
                  paletteOpen,
                  hasItems: filteredPaletteItems.length > 0,
                  hasHighlight: filteredPaletteItems.length > 0,
                });

                if (paletteAction.type === 'move') {
                  event.preventDefault();
                  setPaletteHighlightIndex((index) =>
                    clampPaletteHighlightIndex(
                      index + paletteAction.delta,
                      filteredPaletteItems.length
                    )
                  );
                  return;
                }
                if (paletteAction.type === 'accept') {
                  event.preventDefault();
                  const item = filteredPaletteItems[paletteHighlightIndex];
                  if (item) selectPaletteItem(item);
                  return;
                }
                if (paletteAction.type === 'close') {
                  event.preventDefault();
                  setPaletteDismissed(true);
                  return;
                }

                handleAgentInputKeyDown(event, {
                  enterToSend: preferences.agentEnterToSend,
                  canSend: !!input.trim(),
                  onSend: () => event.currentTarget.form?.requestSubmit(),
                });
              }}
              placeholder={
                pendingProposals.length > 0
                  ? preferences.autoApproveProposals
                    ? 'Pending actions will be approved automatically…'
                    : 'Type a message, or "approve" to confirm the pending action…'
                  : agentWorking
                    ? 'Type to queue another message, or click Stop…'
                    : AGENT_INPUT_IDLE_PLACEHOLDER
              }
              rows={3}
            />
          </div>
          {agentWorking ? (
            <button type="button" className="primary-button" onClick={() => void handleStop()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary-button" disabled={editsDisabled || !input.trim()}>
              Send
            </button>
          )}
        </form>
      </section>

      {pendingConfirm && (
        <ConfirmDialog
          title={
            pendingConfirm.kind === 'switchProject'
              ? 'Switch project'
              : pendingConfirm.kind === 'delete'
                ? 'Delete session'
                : 'Reset session'
          }
          message={
            pendingConfirm.kind === 'switchProject'
              ? switchProjectConfirmMessage(pendingConfirm)
              : pendingConfirm.kind === 'delete'
                ? `Delete "${pendingConfirm.conversation.title}"?\n\nThis removes the session history. Existing tasks stay, but unapproved drafts from this session will be discarded.`
                : `Reset "${pendingConfirm.conversation.title}"?\n\nThis clears the session history so you can reuse this session. The original prompt is kept when available. Existing tasks stay, but unapproved drafts from this session will be discarded.`
          }
          confirmLabel={
            pendingConfirm.kind === 'switchProject'
              ? 'Switch'
              : pendingConfirm.kind === 'delete'
                ? 'Delete'
                : 'Reset'
          }
          busy={confirmBusy}
          onCancel={() => {
            if (!confirmBusy) setPendingConfirm(null);
          }}
          onConfirm={(dontAskAgain) => handleConfirmDialog(dontAskAgain)}
        />
      )}
        </>
      )}
      </div>
    </section>
  );
}
