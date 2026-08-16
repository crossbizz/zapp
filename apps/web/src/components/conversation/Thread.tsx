'use client';

import { ZappApiError, type ConversationCard, type RunEvent } from '@zapp/api-client';
import { EmptyState } from '@zapp/ui';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import {
  useConversationEvents,
  type ConversationRunEvent,
} from '../../hooks/useConversationEvents';
import {
  createControlPlaneClient,
  type BuilderRun,
  type CreateRunMessageInput,
  type CreatedConversation,
  type ProjectConversation,
} from '../../lib/api';
import { Composer, type ConversationImageInput, type ConversationSubmission } from './Composer';
import { MessageBubble } from './MessageBubble';
import { ProgressCard } from './ProgressCard';
import { ToolActivityLine, type ToolActivity } from './ToolActivityLine';
import { QuestionCard } from './QuestionCard';
import { SpecSummaryCard } from './SpecSummaryCard';
import { PlanReviewCard } from './PlanReviewCard';
import { ApprovalCard } from './ApprovalCard';

const activeRunStatuses = new Set(['paused', 'queued', 'running', 'waiting_for_approval']);

type Attachment = NonNullable<CreateRunMessageInput['attachments']>[number];

interface ThreadProps {
  readonly adoptedRun?: BuilderRun;
  readonly allowedModels: readonly string[];
  readonly branches: readonly { readonly id: string; readonly name: string }[];
  readonly incomingImages?: readonly ConversationImageInput[];
  readonly initialPrompt?: string;
  readonly conversation?: ProjectConversation;
  readonly conversationListError: string | undefined;
  readonly conversationLoading: boolean;
  readonly newThread: boolean;
  readonly onConversationCreated: (conversation: CreatedConversation, run: BuilderRun) => void;
  readonly onOpenCommit: (commitSha: string) => void;
  readonly onRetryConversationList: () => void;
  readonly onEventsChange: (runId: string | undefined, events: readonly RunEvent[]) => void;
  readonly onRunChange: (run: BuilderRun | undefined) => void;
  readonly organizationId: string;
  readonly projectId: string;
}

interface MessageItem {
  readonly attachments: readonly string[];
  readonly content: string;
  readonly key: string;
  readonly kind: 'message';
  readonly messageId: string | undefined;
  readonly role: 'assistant' | 'user';
  readonly runId: string;
  readonly sequence: number;
}

interface ActivityItem {
  readonly activities: readonly ToolActivity[];
  readonly key: string;
  readonly kind: 'activity';
  readonly sequence: number;
}

interface PhaseItem {
  readonly completedAt?: string;
  readonly key: string;
  readonly kind: 'phase';
  readonly name: string;
  readonly runId: string;
  readonly sequence: number;
  readonly startedAt?: string;
  readonly state: 'complete' | 'pending' | 'running';
}

interface CommitItem {
  readonly key: string;
  readonly kind: 'commit';
  readonly message: string;
  readonly sequence: number;
  readonly sha: string;
}

interface CardItem {
  readonly card: ConversationCard;
  readonly key: string;
  readonly kind: 'card';
  readonly runId: string;
  readonly sequence: number;
}

type ThreadItem = ActivityItem | CardItem | CommitItem | MessageItem | PhaseItem;

interface PendingSend {
  readonly attachmentKeys: readonly string[];
  readonly files: readonly File[];
  readonly fingerprint: string;
  readonly messageKey: string;
  readonly newRunAttachmentKey: string;
  readonly runKey: string;
  readonly uploads: Map<number, Attachment>;
}

interface OptimisticMessage {
  readonly content: string;
  readonly expectedOrdinal: number;
  readonly id: string;
  readonly messageId: string | undefined;
  readonly runId: string;
}

function payloadString(event: RunEvent, key: string): string | undefined {
  const value = event.data.payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function attachmentNames(event: RunEvent): readonly string[] {
  const attachments = event.data.payload['attachments'];
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment))
      return [];
    const name = (attachment as Readonly<Record<string, unknown>>)['name'];
    return typeof name === 'string' && name.length > 0 ? [name] : [];
  });
}

function phaseKey(event: RunEvent): string {
  return (
    event.data.phaseId ?? payloadString(event, 'phase') ?? `sequence-${String(event.data.sequence)}`
  );
}

function phaseName(event: RunEvent): string {
  const value = payloadString(event, 'name') ?? payloadString(event, 'phase') ?? 'Run phase';
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase('en-US')}${part.slice(1)}`)
    .join(' ');
}

function threadItems(events: readonly ConversationRunEvent[]): readonly ThreadItem[] {
  const items: ThreadItem[] = [];
  const phases = new Map<string, number>();
  let activities: ToolActivity[] = [];
  let activityRunId = '';

  const flushActivities = (): void => {
    const first = activities[0];
    if (first === undefined) return;
    items.push({
      activities,
      key: `activity-${activityRunId}-${String(first.sequence)}`,
      kind: 'activity',
      sequence: first.sequence,
    });
    activities = [];
  };

  for (const event of events) {
    if (
      event.type === 'tool.started' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed'
    ) {
      if (activities.length > 0 && activityRunId !== event.data.runId) flushActivities();
      const summary = payloadString(event, 'userSummary');
      if (summary !== undefined) {
        if (activities.length === 0) activityRunId = event.data.runId;
        activities.push({
          sequence: event.data.sequence,
          state:
            event.type === 'tool.completed'
              ? 'completed'
              : event.type === 'tool.failed'
                ? 'failed'
                : 'started',
          summary,
        });
      }
      continue;
    }
    flushActivities();

    if (event.type === 'conversation.card') {
      const card = event.data.payload['card'] as ConversationCard;
      items.push({
        card,
        key: `${event.data.runId}:${card.cardId}`,
        kind: 'card',
        runId: event.data.runId,
        sequence: event.data.sequence,
      });
      continue;
    }

    if (event.type === 'message.user' || event.type === 'message.assistant') {
      const content = payloadString(event, 'content');
      if (content === undefined && event.type === 'message.assistant') {
        const artifactId = payloadString(event, 'contentArtifactId');
        if (artifactId !== undefined) {
          items.push({
            attachments: [],
            content: `Long assistant response saved as artifact ${artifactId}.`,
            key: `${event.data.runId}:${payloadString(event, 'messageId') ?? event.id}`,
            kind: 'message',
            messageId: payloadString(event, 'messageId'),
            role: 'assistant',
            runId: event.data.runId,
            sequence: event.data.sequence,
          });
        }
      } else if (content !== undefined) {
        items.push({
          attachments: event.type === 'message.user' ? attachmentNames(event) : [],
          content,
          key: `${event.data.runId}:${payloadString(event, 'messageId') ?? event.id}`,
          kind: 'message',
          messageId: payloadString(event, 'messageId'),
          role: event.type === 'message.user' ? 'user' : 'assistant',
          runId: event.data.runId,
          sequence: event.data.sequence,
        });
      }
      continue;
    }

    if (
      event.type === 'phase.created' ||
      event.type === 'phase.started' ||
      event.type === 'phase.completed'
    ) {
      const key = `${event.data.runId}:${phaseKey(event)}`;
      const existingIndex = phases.get(key);
      const existing = existingIndex === undefined ? undefined : items[existingIndex];
      const phase: PhaseItem = {
        ...(existing?.kind === 'phase' ? existing : {}),
        ...(event.type === 'phase.completed' ? { completedAt: event.data.occurredAt } : {}),
        key: `phase-${key}`,
        kind: 'phase',
        name:
          payloadString(event, 'name') ??
          (existing?.kind === 'phase' ? existing.name : phaseName(event)),
        runId: event.data.runId,
        sequence: existing?.sequence ?? event.data.sequence,
        ...(event.type === 'phase.started'
          ? { startedAt: event.data.occurredAt }
          : existing?.kind === 'phase' && existing.startedAt !== undefined
            ? { startedAt: existing.startedAt }
            : {}),
        state:
          event.type === 'phase.completed'
            ? 'complete'
            : event.type === 'phase.started'
              ? 'running'
              : 'pending',
      };
      if (existingIndex === undefined) {
        phases.set(key, items.length);
        items.push(phase);
      } else {
        items[existingIndex] = phase;
      }
      continue;
    }

    if (event.type === 'commit.created') {
      const sha = payloadString(event, 'commitSha') ?? payloadString(event, 'sha');
      if (sha !== undefined) {
        items.push({
          key: `commit-${event.data.runId}-${sha}`,
          kind: 'commit',
          message: payloadString(event, 'message') ?? 'Created commit',
          sequence: event.data.sequence,
          sha,
        });
      }
    }
  }
  flushActivities();
  return items;
}

function submissionFingerprint(submission: ConversationSubmission): string {
  return JSON.stringify({
    branchId: submission.branchId,
    budget: submission.budget,
    content: submission.content,
    files: submission.files.map((file) => [file.name, file.size, file.type, file.lastModified]),
    mode: submission.mode,
    model: submission.model,
    selectedElements: submission.selectedElements,
  });
}

function messageContent(submission: ConversationSubmission): string {
  if (submission.selectedElements.length === 0) return submission.content;
  return JSON.stringify({
    message: submission.content,
    selectedElements: submission.selectedElements,
  });
}

function userMessageCount(events: readonly RunEvent[], content: string): number {
  return events.filter(
    (event) => event.type === 'message.user' && payloadString(event, 'content') === content,
  ).length;
}

function optimisticDeliveryStatus(
  message: OptimisticMessage,
  events: readonly ConversationRunEvent[],
): 'Applied' | 'Queued' | undefined {
  if (message.messageId === undefined) return undefined;
  const applied = events.find(
    (event) =>
      event.data.runId === message.runId &&
      event.type === 'message.applied' &&
      payloadString(event, 'messageId') === message.messageId,
  );
  if (applied === undefined) return 'Queued';
  const answered = events.some(
    (event) =>
      event.data.runId === message.runId &&
      event.type === 'message.assistant' &&
      event.data.sequence > applied.data.sequence,
  );
  return answered ? undefined : 'Applied';
}

function newRunAttachmentContent(submission: ConversationSubmission): string {
  return submission.selectedElements.length === 0
    ? 'Use these reference images with my request.'
    : messageContent(submission);
}

function recommendedMode(content: string): CreateRunInputMode {
  return /\b(?:idea|explore|experiment|prototype|try)\b|\bwhat\s+if\b|\bnot\s+sure\b/iu.test(
    content,
  )
    ? 'prototype'
    : 'build';
}

type CreateRunInputMode = Exclude<ConversationSubmission['mode'], 'auto'>;

function ThreadStyles(): ReactElement {
  return (
    <style jsx global>{`
      .zapp-conversation-thread {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        background: var(--zapp-surface-raised);
      }
      .zapp-conversation-items {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        gap: 0.625rem;
        overflow-y: auto;
        padding: 1rem 1rem 0.75rem;
      }
      .zapp-conversation-message {
        max-width: 92%;
        border: 1px solid transparent;
        border-radius: var(--zapp-radius-panel);
        padding: 0.65rem 0.75rem;
        background: transparent;
      }
      .zapp-conversation-message[data-role='user'] {
        align-self: flex-end;
        border-color: var(--zapp-border);
        background: var(--zapp-surface-subtle);
      }
      .zapp-conversation-message p,
      .zapp-conversation-message ul {
        margin: 0;
        white-space: pre-wrap;
      }
      .zapp-conversation-message-attachments,
      .zapp-conversation-activity ol {
        margin-top: 0.5rem;
        padding-left: 1.25rem;
        color: var(--zapp-text-muted);
        font-size: var(--zapp-text-12);
      }
      .zapp-conversation-message-delivery {
        display: block;
        margin-top: 0.35rem;
        color: var(--zapp-text-muted);
        font-size: var(--zapp-text-12);
        font-weight: 650;
      }
      .zapp-conversation-activity {
        color: var(--zapp-text-muted);
        font-size: var(--zapp-text-14);
      }
      .zapp-conversation-activity summary {
        cursor: pointer;
      }
      .zapp-conversation-progress {
        display: flex;
        min-height: 2.5rem;
        align-items: center;
        gap: 0.5rem;
        border: 1px solid var(--zapp-border);
        border-radius: 0.55rem;
        padding: 0.4rem 0.65rem;
        background: var(--zapp-surface-subtle);
        font-size: var(--zapp-text-12);
      }
      .zapp-conversation-progress > strong {
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .zapp-conversation-progress > span:not(.zapp-conversation-progress-indicator),
      .zapp-conversation-progress > small {
        flex: 0 0 auto;
        color: var(--zapp-text-muted);
      }
      .zapp-conversation-progress-indicator {
        width: 0.5rem;
        height: 0.5rem;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--zapp-text-muted);
      }
      .zapp-conversation-progress[data-state='running'] .zapp-conversation-progress-indicator {
        background: var(--zapp-accent);
        box-shadow: 0 0 0 0.2rem color-mix(in srgb, var(--zapp-accent) 12%, transparent);
      }
      .zapp-conversation-progress[data-state='complete'] .zapp-conversation-progress-indicator {
        background: var(--zapp-status-success);
      }
      .zapp-conversation-progress[data-state='failed'] .zapp-conversation-progress-indicator {
        background: var(--zapp-status-danger);
      }
      .zapp-conversation-commit {
        align-self: flex-start;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-pill);
        padding: 0.4rem 0.65rem;
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-raised);
        font: inherit;
        cursor: pointer;
      }
      .zapp-conversation-banner,
      .zapp-conversation-error,
      .zapp-conversation-cancelled {
        margin: 0.75rem 1rem 0;
        border-radius: var(--zapp-radius-panel);
        padding: 0.5rem 0.75rem;
        background: var(--zapp-surface-subtle);
        font-size: var(--zapp-text-14);
      }
      .zapp-conversation-run-status {
        display: flex;
        min-height: 1.75rem;
        align-items: center;
        gap: 0.45rem;
        color: var(--zapp-text-secondary);
        font-size: var(--zapp-text-12);
        font-weight: 600;
        padding: 0.65rem 1rem 0;
      }
      .zapp-conversation-run-status-dot {
        width: 0.45rem;
        height: 0.45rem;
        flex: 0 0 auto;
        border-radius: var(--zapp-radius-pill);
        background: var(--zapp-accent);
        box-shadow: 0 0 0 0.2rem color-mix(in srgb, var(--zapp-accent) 12%, transparent);
      }
      .zapp-conversation-error {
        border: 1px solid var(--zapp-status-danger);
        color: var(--zapp-text-primary);
        background: var(--zapp-danger-surface);
      }
      .zapp-conversation-composer {
        z-index: 2;
        display: grid;
        flex: 0 0 auto;
        gap: 0.45rem;
        margin: 0.65rem;
        padding: 0.55rem;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-panel);
        background: var(--zapp-surface-raised);
        box-shadow: var(--zapp-shadow-card);
      }
      .zapp-conversation-composer textarea {
        width: 100%;
        min-height: 3.5rem;
        max-height: 9rem;
        resize: none;
        border: 0;
        border-radius: 0.5rem;
        padding: 0.55rem 0.6rem;
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-raised);
        font: inherit;
        font-size: var(--zapp-text-14);
        outline: 0;
      }
      .zapp-conversation-composer-actions,
      .zapp-conversation-images {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }
      .zapp-conversation-composer-actions .zapp-button,
      .zapp-conversation-composer-actions .zapp-icon-button {
        min-height: 2rem;
      }
      .zapp-conversation-composer-spacer {
        flex: 1;
      }
      .zapp-conversation-image-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        border-radius: var(--zapp-radius-pill);
        padding: 0.25rem 0.55rem;
        background: var(--zapp-surface-subtle);
        font-size: var(--zapp-text-12);
      }
      .zapp-conversation-image-chip button {
        border: 0;
        background: transparent;
        cursor: pointer;
      }
      .zapp-conversation-menu {
        display: grid;
        gap: 0.35rem;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-panel);
        padding: 0.5rem;
        background: var(--zapp-surface-raised);
      }
      .zapp-conversation-menu > button,
      .zapp-conversation-menu > a {
        border: 0;
        border-radius: var(--zapp-radius-input);
        padding: 0.5rem;
        color: var(--zapp-text-primary);
        background: transparent;
        font: inherit;
        text-align: left;
        text-decoration: none;
        cursor: pointer;
      }
      .zapp-conversation-menu fieldset,
      .zapp-conversation-menu label,
      .zapp-conversation-menu label > span {
        display: grid;
        gap: 0.25rem;
      }
      .zapp-conversation-menu fieldset {
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-panel);
        padding: 0.65rem;
      }
      .zapp-conversation-composer-guard {
        min-width: 0;
        margin: 0;
        border: 0;
        padding: 0;
      }
    `}</style>
  );
}

export function Thread({
  adoptedRun,
  allowedModels,
  branches,
  conversation,
  conversationListError,
  conversationLoading,
  incomingImages = [],
  initialPrompt,
  newThread,
  onConversationCreated,
  onOpenCommit,
  onRetryConversationList,
  onEventsChange,
  onRunChange,
  organizationId,
  projectId,
}: ThreadProps): ReactElement {
  const [currentRun, setCurrentRun] = useState<BuilderRun>();
  const [loading, setLoading] = useState(true);
  const [operationError, setOperationError] = useState<string>();
  const [optimisticMessages, setOptimisticMessages] = useState<readonly OptimisticMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const currentRunRef = useRef<BuilderRun | undefined>(currentRun);
  currentRunRef.current = currentRun;
  const pendingSendRef = useRef<PendingSend | undefined>(undefined);
  const selectedRun =
    conversation !== undefined &&
    currentRun?.conversationId === conversation.id &&
    currentRun.id === conversation.latestRun.id
      ? currentRun
      : undefined;
  const {
    connection,
    error: conversationError,
    events,
    liveEvents,
    loading: eventsLoading,
    refresh: retryConversationEvents,
  } = useConversationEvents(conversation?.id, selectedRun, organizationId);
  const items = useMemo(() => threadItems(events), [events]);
  const currentRunEvents = events.filter((event) => event.data.runId === selectedRun?.id);
  const cancelled = currentRunEvents.some((event) => event.type === 'run.cancelled');
  const completed = currentRunEvents.some((event) => event.type === 'run.completed');
  const active =
    selectedRun !== undefined &&
    activeRunStatuses.has(selectedRun.status) &&
    !cancelled &&
    !completed;
  const visibleOptimisticMessages = optimisticMessages.filter(
    (message) => {
      if (message.runId !== selectedRun?.id) return false;
      if (message.messageId !== undefined) {
        return !items.some(
          (item) =>
            item.kind === 'message' &&
            item.runId === message.runId &&
            item.messageId === message.messageId,
        );
      }
      return userMessageCount(currentRunEvents, message.content) < message.expectedOrdinal;
    },
  );

  useEffect(() => {
    onEventsChange(selectedRun?.id, liveEvents);
  }, [liveEvents, onEventsChange, selectedRun?.id]);

  useEffect(() => {
    if (newThread) {
      setLoading(false);
      setCurrentRun(undefined);
      setOptimisticMessages([]);
      onRunChange(undefined);
      setOperationError(undefined);
      return;
    }
    if (conversationListError !== undefined) {
      setLoading(false);
      return;
    }
    if (conversationLoading || conversation === undefined) {
      setLoading(true);
      return;
    }
    const retainedRun = currentRunRef.current;
    if (
      retainedRun?.id === conversation.latestRun.id &&
      retainedRun.conversationId === conversation.id
    ) {
      setLoading(false);
      setOperationError(undefined);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    createControlPlaneClient(organizationId)
      .listRuns(projectId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const run = response.items.find(
          (candidate) =>
            candidate.id === conversation.latestRun.id &&
            candidate.conversationId === conversation.id,
        );
        if (run === undefined) {
          throw new Error('Selected conversation run is unavailable.');
        }
        if (currentRunRef.current?.conversationId !== conversation.id) {
          setOptimisticMessages([]);
        }
        setCurrentRun(run);
        onRunChange(run);
        setOperationError(undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setOperationError('The conversation could not be loaded. Retry by refreshing the page.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [
    conversation,
    conversationListError,
    conversationLoading,
    newThread,
    onRunChange,
    organizationId,
    projectId,
  ]);

  useEffect(() => {
    if (
      adoptedRun === undefined ||
      adoptedRun.id === currentRun?.id ||
      adoptedRun.conversationId !== conversation?.id
    ) {
      return;
    }
    setCurrentRun(adoptedRun);
  }, [adoptedRun, conversation?.id, currentRun?.id]);

  useEffect(() => {
    if (
      selectedRun === undefined ||
      !activeRunStatuses.has(selectedRun.status) ||
      cancelled ||
      completed
    ) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const response = await createControlPlaneClient(organizationId).listRuns(
          projectId,
          controller.signal,
        );
        const refreshed = response.items.find((run) => run.id === selectedRun.id);
        if (refreshed !== undefined && refreshed.status !== selectedRun.status) {
          setCurrentRun(refreshed);
          onRunChange(refreshed);
        }
      } catch {
        // The SSE connection still owns event delivery. A transient status read
        // must not replace its reconnect behavior with an error banner.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1_000);
      }
    };
    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [cancelled, completed, onRunChange, organizationId, projectId, selectedRun]);

  const pendingSend = (submission: ConversationSubmission): PendingSend => {
    const fingerprint = submissionFingerprint(submission);
    const existing = pendingSendRef.current;
    if (
      existing?.fingerprint === fingerprint &&
      existing.files.length === submission.files.length &&
      existing.files.every((file, index) => file === submission.files[index])
    ) {
      return existing;
    }
    const pending: PendingSend = {
      attachmentKeys: submission.files.map(() => crypto.randomUUID()),
      files: submission.files,
      fingerprint,
      messageKey: crypto.randomUUID(),
      newRunAttachmentKey: crypto.randomUUID(),
      runKey: crypto.randomUUID(),
      uploads: new Map(),
    };
    pendingSendRef.current = pending;
    return pending;
  };

  const uploadImages = async (
    submission: ConversationSubmission,
    pending: PendingSend,
  ): Promise<readonly Attachment[]> => {
    const client = createControlPlaneClient(organizationId);
    return await Promise.all(
      submission.files.map(async (file, index) => {
        const cached = pending.uploads.get(index);
        if (cached !== undefined) return cached;
        const uploaded = await client.uploadAttachment(
          projectId,
          file,
          pending.attachmentKeys[index],
        );
        pending.uploads.set(index, uploaded);
        return uploaded;
      }),
    );
  };

  const createRun = async (
    submission: ConversationSubmission,
    pending: PendingSend,
    attachments: readonly Attachment[],
  ): Promise<BuilderRun> => {
    const client = createControlPlaneClient(organizationId);
    const branchId = submission.branchId ?? selectedRun?.branchId ?? branches[0]?.id;
    const created = await client.createRun(
      projectId,
      {
        appType: 'web',
        ...(branchId === undefined ? {} : { branchId }),
        ...(submission.budget === undefined ? {} : { budget: submission.budget }),
        ...(conversation === undefined ? {} : { conversationId: conversation.id }),
        mode: submission.mode === 'auto' ? recommendedMode(submission.content) : submission.mode,
        ...(submission.model === undefined ? {} : { model: submission.model }),
        prompt: submission.content,
      },
      pending.runKey,
    );
    if (attachments.length > 0 || submission.selectedElements.length > 0) {
      await client.sendRunMessage(
        created.run.id,
        { attachments: [...attachments], content: newRunAttachmentContent(submission) },
        pending.newRunAttachmentKey,
      );
    }
    setCurrentRun(created.run);
    onConversationCreated(created.conversation, created.run);
    onRunChange(created.run);
    return created.run;
  };

  const appendOptimisticMessage = (
    run: BuilderRun,
    content: string,
    messageId?: string,
  ): void => {
    setOptimisticMessages((current) => {
      const durableCount =
        selectedRun?.id === run.id ? userMessageCount(currentRunEvents, content) : 0;
      const pendingCount = current.filter(
        (message) => message.runId === run.id && message.content === content,
      ).length;
      return [
        ...current,
        {
          content,
          expectedOrdinal: durableCount + pendingCount + 1,
          id: crypto.randomUUID(),
          messageId,
          runId: run.id,
        },
      ];
    });
  };

  const send = async (submission: ConversationSubmission): Promise<boolean> => {
    const selectionReady =
      conversationListError === undefined &&
      conversationError === undefined &&
      !conversationLoading &&
      !eventsLoading &&
      (newThread || (conversation !== undefined && selectedRun !== undefined && !loading));
    if (sending || !selectionReady) return false;
    setSending(true);
    setOperationError(undefined);
    const pending = pendingSend(submission);
    try {
      const attachments = await uploadImages(submission, pending);
      let acceptedRun: BuilderRun;
      let acceptedMessageId: string | undefined;
      if (active) {
        try {
          const acceptedMessage = await createControlPlaneClient(organizationId).sendRunMessage(
            selectedRun.id,
            { attachments: [...attachments], content: messageContent(submission) },
            pending.messageKey,
          );
          acceptedMessageId = acceptedMessage.messageId;
          acceptedRun = selectedRun;
        } catch (error) {
          if (!(
            error instanceof ZappApiError &&
            error.status === 409 &&
            error.code === 'run_not_active'
          )) {
            throw error;
          }
          const response = await createControlPlaneClient(organizationId).listRuns(projectId);
          const refreshed = response.items.find((run) => run.id === selectedRun.id);
          if (refreshed !== undefined) {
            setCurrentRun(refreshed);
            onRunChange(refreshed);
          }
          throw error;
        }
      } else {
        acceptedRun = await createRun(submission, pending, attachments);
      }
      appendOptimisticMessage(acceptedRun, submission.content, acceptedMessageId);
      pendingSendRef.current = undefined;
      return true;
    } catch {
      setOperationError(
        'Your message was not sent. Nothing was reported as complete; retry safely.',
      );
      return false;
    } finally {
      setSending(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (selectedRun === undefined || stopping) return;
    setStopping(true);
    setOperationError(undefined);
    try {
      await createControlPlaneClient(organizationId).cancelRun(selectedRun.id, crypto.randomUUID());
    } catch {
      setOperationError('The run could not be stopped. Retry the stop request.');
    } finally {
      setStopping(false);
    }
  };

  const hasUserMessage = items.some((item) => item.kind === 'message' && item.role === 'user');
  const selectionReady =
    conversationListError === undefined &&
    conversationError === undefined &&
    !conversationLoading &&
    !eventsLoading &&
    (newThread || (conversation !== undefined && selectedRun !== undefined && !loading));
  const historyError = conversationListError ?? conversationError;

  return (
    <div className="zapp-conversation-thread">
      <ThreadStyles />
      {connection === 'reconnecting' ? (
        <p className="zapp-conversation-banner" role="status">
          Reconnecting to the run…
        </p>
      ) : null}
      {operationError === undefined &&
      conversationListError === undefined &&
      conversationError === undefined ? null : (
        <p className="zapp-conversation-error" role="alert">
          {operationError ?? conversationListError ?? conversationError}
        </p>
      )}
      {historyError === undefined ? null : (
        <button
          aria-label="Reload thread"
          className="zapp-conversation-commit"
          onClick={
            conversationListError === undefined
              ? retryConversationEvents
              : onRetryConversationList
          }
          type="button"
        >
          Retry history
        </button>
      )}
      {cancelled ? (
        <p className="zapp-conversation-cancelled" role="status">
          Run cancelled
        </p>
      ) : null}
      {selectedRun === undefined ? null : (
        <div aria-label="Build status" className="zapp-conversation-run-status" role="status">
          <span aria-hidden="true" className="zapp-conversation-run-status-dot" />
          <span>
            {cancelled || selectedRun.status === 'cancelled'
              ? 'Build cancelled'
              : completed || selectedRun.status === 'completed'
                ? 'Build complete'
                : selectedRun.status === 'failed'
                  ? 'Build failed'
                  : selectedRun.status === 'queued'
                    ? 'Build queued'
                    : selectedRun.status === 'paused'
                      ? 'Build paused'
                      : selectedRun.status === 'waiting_for_approval'
                        ? 'Waiting for approval'
                        : 'Agent is running'}
          </span>
        </div>
      )}
      <div className="zapp-conversation-items">
        {conversationListError === undefined && (loading || eventsLoading) && items.length === 0 ? (
          <p aria-live="polite">Loading conversation…</p>
        ) : null}
        {!hasUserMessage && initialPrompt !== undefined ? (
          <MessageBubble content={initialPrompt} role="user" />
        ) : null}
        {!loading &&
        !eventsLoading &&
        historyError === undefined &&
        items.length === 0 &&
        initialPrompt === undefined ? (
          <EmptyState
            description="Send a message to start a run with the agent."
            title="No conversation yet"
          />
        ) : null}
        {items.map((item) => {
          if (item.kind === 'message') {
            const optimistic =
              item.messageId === undefined
                ? undefined
                : optimisticMessages.find(
                    (message) =>
                      message.runId === item.runId && message.messageId === item.messageId,
                  );
            return (
              <MessageBubble
                attachmentNames={item.attachments}
                content={item.content}
                {...(optimistic === undefined
                  ? {}
                  : { deliveryStatus: optimisticDeliveryStatus(optimistic, events) })}
                key={item.key}
                role={item.role}
              />
            );
          }
          if (item.kind === 'activity') {
            return <ToolActivityLine activities={item.activities} key={item.key} />;
          }
          if (item.kind === 'card') {
            const props = { organizationId, runId: item.runId } as const;
            if (item.card.kind === 'question')
              return <QuestionCard card={item.card} key={item.key} {...props} />;
            if (item.card.kind === 'specification')
              return <SpecSummaryCard card={item.card} key={item.key} {...props} />;
            if (item.card.kind === 'plan')
              return <PlanReviewCard card={item.card} key={item.key} {...props} />;
            return <ApprovalCard card={item.card} key={item.key} {...props} />;
          }
          if (item.kind === 'phase') {
            if (
              selectedRun?.id === item.runId &&
              selectedRun.status === 'failed' &&
              item.state === 'running'
            ) {
              return (
                <article
                  aria-label={`${item.name} progress`}
                  className="zapp-conversation-progress"
                  data-state="failed"
                  key={item.key}
                  role="status"
                >
                  <span aria-hidden="true" className="zapp-conversation-progress-indicator" />
                  <strong>{item.name}</strong>
                  <span>Failed</span>
                </article>
              );
            }
            return (
              <ProgressCard
                {...(item.completedAt === undefined ? {} : { completedAt: item.completedAt })}
                key={item.key}
                name={item.name}
                {...(item.startedAt === undefined ? {} : { startedAt: item.startedAt })}
                state={item.state}
              />
            );
          }
          return (
            <button
              aria-label={`${item.sha.slice(0, 7)} ${item.message}`}
              className="zapp-conversation-commit"
              key={item.key}
              onClick={() => {
                onOpenCommit(item.sha);
              }}
              type="button"
            >
              <code>{item.sha.slice(0, 7)}</code> {item.message}
            </button>
          );
        })}
        {visibleOptimisticMessages.map((message) => (
          <MessageBubble
            content={message.content}
            {...(message.messageId === undefined
              ? {}
              : { deliveryStatus: optimisticDeliveryStatus(message, events) })}
            key={message.id}
            role="user"
          />
        ))}
      </div>
      <fieldset className="zapp-conversation-composer-guard" disabled={!selectionReady}>
        <Composer
          active={active}
          allowedModels={allowedModels}
          branches={branches}
          incomingImages={incomingImages}
          onStop={stop}
          onSubmit={send}
          projectId={projectId}
          sending={sending}
          stopping={stopping}
        />
      </fieldset>
    </div>
  );
}
