'use client';

import { ZappApiError, type RunEvent } from '@zapp/api-client';
import { EmptyState } from '@zapp/ui';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { useRunEvents } from '../../hooks/useRunEvents';
import {
  createControlPlaneClient,
  type BuilderRun,
  type CreateRunMessageInput,
} from '../../lib/api';
import { Composer, type ConversationImageInput, type ConversationSubmission } from './Composer';
import { MessageBubble } from './MessageBubble';
import { ProgressCard } from './ProgressCard';
import { ToolActivityLine, type ToolActivity } from './ToolActivityLine';

const activeRunStatuses = new Set(['paused', 'queued', 'running', 'waiting_for_approval']);

type Attachment = NonNullable<CreateRunMessageInput['attachments']>[number];

interface ThreadProps {
  readonly adoptedRun?: BuilderRun;
  readonly allowedModels: readonly string[];
  readonly branches: readonly { readonly id: string; readonly name: string }[];
  readonly incomingImages?: readonly ConversationImageInput[];
  readonly initialPrompt?: string;
  readonly onOpenCommit: (commitSha: string) => void;
  readonly onRunChange: (run: BuilderRun | undefined) => void;
  readonly organizationId: string;
  readonly projectId: string;
}

interface MessageItem {
  readonly attachments: readonly string[];
  readonly content: string;
  readonly key: string;
  readonly kind: 'message';
  readonly role: 'assistant' | 'user';
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

type ThreadItem = ActivityItem | CommitItem | MessageItem | PhaseItem;

interface PendingSend {
  readonly attachmentKeys: readonly string[];
  readonly files: readonly File[];
  readonly fingerprint: string;
  readonly messageKey: string;
  readonly newRunAttachmentKey: string;
  readonly runKey: string;
  readonly uploads: Map<number, Attachment>;
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

function threadItems(events: readonly RunEvent[]): readonly ThreadItem[] {
  const items: ThreadItem[] = [];
  const phases = new Map<string, number>();
  let activities: ToolActivity[] = [];

  const flushActivities = (): void => {
    const first = activities[0];
    if (first === undefined) return;
    items.push({
      activities,
      key: `activity-${String(first.sequence)}`,
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
      const summary = payloadString(event, 'userSummary');
      if (summary !== undefined) {
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

    if (event.type === 'message.user' || event.type === 'message.assistant') {
      const content = payloadString(event, 'content');
      if (content === undefined && event.type === 'message.assistant') {
        const artifactId = payloadString(event, 'contentArtifactId');
        if (artifactId !== undefined) {
          items.push({
            attachments: [],
            content: `Long assistant response saved as artifact ${artifactId}.`,
            key: payloadString(event, 'messageId') ?? event.id,
            kind: 'message',
            role: 'assistant',
            sequence: event.data.sequence,
          });
        }
      } else if (content !== undefined) {
        items.push({
          attachments: event.type === 'message.user' ? attachmentNames(event) : [],
          content,
          key: payloadString(event, 'messageId') ?? event.id,
          kind: 'message',
          role: event.type === 'message.user' ? 'user' : 'assistant',
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
      const key = phaseKey(event);
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
          key: `commit-${sha}`,
          kind: 'commit',
          message: payloadString(event, 'message') ?? 'Created commit',
          sequence: event.data.sequence,
          sha,
        });
      }
    }
  }
  flushActivities();
  return items.sort((left, right) => left.sequence - right.sequence);
}

function submissionFingerprint(submission: ConversationSubmission): string {
  return JSON.stringify({
    branchId: submission.branchId,
    budget: submission.budget,
    content: submission.content,
    files: submission.files.map((file) => [file.name, file.size, file.type, file.lastModified]),
    mode: submission.mode,
    model: submission.model,
  });
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
        min-height: 100%;
        flex-direction: column;
        gap: 0.875rem;
      }
      .zapp-conversation-items {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 0.75rem;
      }
      .zapp-conversation-message {
        max-width: 92%;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-panel);
        padding: 0.75rem 0.875rem;
        background: var(--zapp-surface-raised);
      }
      .zapp-conversation-message[data-role='user'] {
        align-self: flex-end;
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
      .zapp-conversation-activity {
        color: var(--zapp-text-muted);
        font-size: var(--zapp-text-14);
      }
      .zapp-conversation-activity summary {
        cursor: pointer;
      }
      .zapp-conversation-progress {
        display: grid;
        gap: 0.5rem;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-panel);
        padding: 0.75rem;
        background: var(--zapp-surface-subtle);
      }
      .zapp-conversation-progress > div:first-child {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .zapp-conversation-progress-dots {
        display: flex;
        gap: 0.375rem;
        color: var(--zapp-accent);
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
        margin: 0;
        border-radius: var(--zapp-radius-panel);
        padding: 0.5rem 0.75rem;
        background: var(--zapp-surface-subtle);
        font-size: var(--zapp-text-14);
      }
      .zapp-conversation-error {
        color: var(--zapp-status-danger);
        background: var(--zapp-danger-surface);
      }
      .zapp-conversation-composer {
        position: sticky;
        bottom: 0;
        display: grid;
        gap: 0.625rem;
        padding-top: 0.75rem;
        background: var(--zapp-surface-raised);
      }
      .zapp-conversation-composer textarea {
        width: 100%;
        resize: vertical;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-panel);
        padding: 0.75rem;
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-raised);
        font: inherit;
      }
      .zapp-conversation-composer-actions,
      .zapp-conversation-images {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
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
    `}</style>
  );
}

export function Thread({
  adoptedRun,
  allowedModels,
  branches,
  incomingImages = [],
  initialPrompt,
  onOpenCommit,
  onRunChange,
  organizationId,
  projectId,
}: ThreadProps): ReactElement {
  const [currentRun, setCurrentRun] = useState<BuilderRun>();
  const [loading, setLoading] = useState(true);
  const [operationError, setOperationError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const pendingSendRef = useRef<PendingSend | undefined>(undefined);
  const { connection, events } = useRunEvents(currentRun?.id, organizationId);
  const items = useMemo(() => threadItems(events), [events]);
  const cancelled = events.some((event) => event.type === 'run.cancelled');
  const completed = events.some((event) => event.type === 'run.completed');
  const active =
    currentRun !== undefined &&
    activeRunStatuses.has(currentRun.status) &&
    !cancelled &&
    !completed;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    createControlPlaneClient(organizationId)
      .listRuns(projectId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const run = response.items[0];
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
  }, [onRunChange, organizationId, projectId]);

  useEffect(() => {
    if (adoptedRun === undefined || adoptedRun.id === currentRun?.id) return;
    setCurrentRun(adoptedRun);
  }, [adoptedRun, currentRun?.id]);

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
  ): Promise<void> => {
    const client = createControlPlaneClient(organizationId);
    const created = await client.createRun(
      projectId,
      {
        appType: 'web',
        ...(submission.branchId === undefined ? {} : { branchId: submission.branchId }),
        ...(submission.budget === undefined ? {} : { budget: submission.budget }),
        mode: submission.mode === 'auto' ? recommendedMode(submission.content) : submission.mode,
        ...(submission.model === undefined ? {} : { model: submission.model }),
        prompt: submission.content,
      },
      pending.runKey,
    );
    if (attachments.length > 0) {
      await client.sendRunMessage(
        created.run.id,
        { attachments: [...attachments], content: 'Use these reference images with my request.' },
        pending.newRunAttachmentKey,
      );
    }
    setCurrentRun(created.run);
    onRunChange(created.run);
  };

  const send = async (submission: ConversationSubmission): Promise<boolean> => {
    if (sending) return false;
    setSending(true);
    setOperationError(undefined);
    const pending = pendingSend(submission);
    try {
      const attachments = await uploadImages(submission, pending);
      if (active) {
        try {
          await createControlPlaneClient(organizationId).sendRunMessage(
            currentRun.id,
            { attachments: [...attachments], content: submission.content },
            pending.messageKey,
          );
        } catch (error) {
          if (!(
            error instanceof ZappApiError &&
            error.status === 409 &&
            error.code === 'run_not_active'
          )) {
            throw error;
          }
          await createRun(submission, pending, attachments);
        }
      } else {
        await createRun(submission, pending, attachments);
      }
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
    if (currentRun === undefined || stopping) return;
    setStopping(true);
    setOperationError(undefined);
    try {
      await createControlPlaneClient(organizationId).cancelRun(currentRun.id, crypto.randomUUID());
    } catch {
      setOperationError('The run could not be stopped. Retry the stop request.');
    } finally {
      setStopping(false);
    }
  };

  const hasUserMessage = items.some((item) => item.kind === 'message' && item.role === 'user');

  return (
    <div className="zapp-conversation-thread">
      <ThreadStyles />
      {connection === 'reconnecting' ? (
        <p className="zapp-conversation-banner" role="status">
          Reconnecting to the run…
        </p>
      ) : null}
      {operationError === undefined ? null : (
        <p className="zapp-conversation-error" role="alert">
          {operationError}
        </p>
      )}
      {cancelled ? (
        <p className="zapp-conversation-cancelled" role="status">
          Run cancelled
        </p>
      ) : null}
      <div className="zapp-conversation-items">
        {loading && items.length === 0 ? <p role="status">Loading conversation…</p> : null}
        {!hasUserMessage && initialPrompt !== undefined ? (
          <MessageBubble content={initialPrompt} role="user" />
        ) : null}
        {!loading && items.length === 0 && initialPrompt === undefined ? (
          <EmptyState
            description="Send a message to start a run with the agent."
            title="No conversation yet"
          />
        ) : null}
        {items.map((item) => {
          if (item.kind === 'message') {
            return (
              <MessageBubble
                attachmentNames={item.attachments}
                content={item.content}
                key={item.key}
                role={item.role}
              />
            );
          }
          if (item.kind === 'activity') {
            return <ToolActivityLine activities={item.activities} key={item.key} />;
          }
          if (item.kind === 'phase') {
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
      </div>
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
    </div>
  );
}
