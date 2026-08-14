'use client';

import type { BuilderPreviewEvent, RunEvent } from '@zapp/api-client';
import { Button, EmptyState, ErrorState } from '@zapp/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import { useRunEvents } from '../../hooks/useRunEvents';
import { createControlPlaneClient, type BuilderRun } from '../../lib/api';
import { ConsoleDrawer } from './ConsoleDrawer';
import { PreviewToolbar, type PreviewDevice } from './PreviewToolbar';
import { SelectMode, type SelectedPreviewElement } from './SelectMode';

const previewWidths: Readonly<Record<PreviewDevice, string>> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};
const maximumComposerImageBytes = 8 * 1024 * 1024;
const maximumLogEntries = 500;
const maximumLogPagesPerRefresh = 10;
const previewLogPageSize = 100;
const previewShareLifetimeMs = 8 * 60 * 60 * 1_000;
const previewShareRenewalWindowMs = 60_000;

type PreviewState = 'disconnected' | 'failed' | 'ready' | 'sleeping' | 'stale' | 'starting';
type LogResponse = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['readDevServerLogs']>
>;

interface PreviewFrameProps {
  readonly fallbackCommitSha?: string;
  readonly onAttachToChat: (file: File, capture: BuilderPreviewEvent) => Promise<boolean>;
  readonly onAttachSelectionToChat: (
    file: File,
    selection: SelectedPreviewElement,
  ) => Promise<boolean>;
  readonly onRunCreated: (run: BuilderRun) => void;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly runStatus?: BuilderRun['status'];
}

interface StoredShareAttempt {
  readonly expiresAt: string;
  readonly idempotencyKey: string;
}

interface StoredFixAttempt {
  readonly attachmentIdempotencyKey: string;
  readonly evidenceArtifactId?: string;
  readonly evidenceSummary: string;
  readonly idempotencyKey: string;
  readonly prompt: string;
  readonly relevantCommitSha: string;
  readonly reproductionRef: string;
  readonly screenshotIdempotencyKey: string;
  readonly summary: string;
}

function eventWorkspaceId(event: RunEvent | undefined): string | undefined {
  const value = event?.data.payload['workspaceId'];
  return typeof value === 'string' && value.startsWith('ws_') ? value : undefined;
}

function latestCommitSha(events: readonly RunEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'commit.created') continue;
    const commitSha = event.data.payload['commitSha'] ?? event.data.payload['sha'];
    if (typeof commitSha === 'string' && /^[0-9a-f]{40}$/u.test(commitSha)) return commitSha;
  }
  return undefined;
}

function previewLifecycle(events: readonly RunEvent[]): {
  readonly event?: RunEvent;
  readonly stale: boolean;
} {
  const event = [...events].reverse().find((candidate) => candidate.type.startsWith('preview.'));
  const latestCommit = [...events]
    .reverse()
    .find((candidate) => candidate.type === 'commit.created');
  const latestCompletedRun = [...events]
    .reverse()
    .find((candidate) => candidate.type === 'run.completed');
  return {
    ...(event === undefined ? {} : { event }),
    stale:
      event?.type === 'preview.ready' &&
      latestCommit !== undefined &&
      latestCommit.data.sequence > event.data.sequence &&
      (latestCompletedRun === undefined ||
        latestCompletedRun.data.sequence < latestCommit.data.sequence),
  };
}

function currentPath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function logContext(logs: LogResponse | undefined): string {
  const lines = logs?.entries.slice(-20).map((entry) => `[${entry.stream}] ${entry.message}`) ?? [];
  return lines.length === 0 ? 'No boot log entries were available.' : lines.join('\n');
}

function previewShareStorageKey(workspaceId: string): string {
  return `zapp:preview:org-share:${workspaceId}`;
}

function readShareAttempt(workspaceId: string): StoredShareAttempt | undefined {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(previewShareStorageKey(workspaceId)) ?? 'null',
    ) as { expiresAt?: unknown; idempotencyKey?: unknown } | null;
    if (
      parsed === null ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.idempotencyKey !== 'string' ||
      Date.parse(parsed.expiresAt) <= Date.now() + previewShareRenewalWindowMs
    ) {
      return undefined;
    }
    return { expiresAt: parsed.expiresAt, idempotencyKey: parsed.idempotencyKey };
  } catch {
    return undefined;
  }
}

function persistShareAttempt(workspaceId: string, attempt: StoredShareAttempt): void {
  try {
    localStorage.setItem(previewShareStorageKey(workspaceId), JSON.stringify(attempt));
  } catch {
    // The in-memory attempt still makes retries safe for the current page.
  }
}

function PreviewStyles(): ReactElement {
  return (
    <style jsx global>{`
      .zapp-preview-panel {
        display: grid;
        height: 100%;
        min-height: 0;
        grid-template-rows: auto minmax(0, 1fr) auto;
        background: var(--zapp-surface-canvas);
        container-type: inline-size;
      }
      .zapp-preview-toolbar {
        position: relative;
        display: flex;
        min-height: 2.5rem;
        align-items: center;
        justify-content: center;
        gap: 0.25rem;
        padding: 0.25rem 0.5rem;
        border-bottom: 1px solid var(--zapp-border);
        background: var(--zapp-surface-raised);
      }
      .zapp-preview-path {
        display: flex;
        min-width: 6rem;
        max-width: 16rem;
        min-height: 1.75rem;
        flex: 1;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        overflow: hidden;
        padding: 0.2rem 0.6rem;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-pill);
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-subtle);
        font-size: var(--zapp-text-12);
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .zapp-preview-path span {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .zapp-preview-path svg {
        width: 0.75rem;
        height: 0.75rem;
        flex: 0 0 auto;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.5;
      }
      .zapp-preview-devices,
      .zapp-preview-toolbar-actions,
      .zapp-preview-footer {
        display: flex;
        align-items: center;
        gap: 0.375rem;
      }
      .zapp-preview-toolbar-actions .zapp-button {
        min-height: 1.75rem;
        padding: 0.25rem 0.6rem;
        font-size: var(--zapp-text-12);
        white-space: nowrap;
      }
      .zapp-preview-toolbar .zapp-icon-button {
        width: 1.75rem;
        height: 1.75rem;
        flex: 0 0 auto;
      }
      .zapp-preview-toolbar .zapp-icon-button svg {
        width: 0.9rem;
        height: 0.9rem;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }
      .zapp-preview-select-mode .zapp-icon-button[aria-pressed='true'] {
        border-color: color-mix(in srgb, var(--zapp-accent) 45%, var(--zapp-border));
        color: var(--zapp-accent);
        background: var(--zapp-support-verified-bg);
      }
      .zapp-preview-devices {
        flex: 0 0 auto;
        gap: 0;
        padding: 0.1rem;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-pill);
        background: var(--zapp-surface-subtle);
      }
      .zapp-preview-devices button {
        display: inline-grid;
        width: 1.55rem;
        height: 1.45rem;
        min-height: 0;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: var(--zapp-radius-pill);
        color: var(--zapp-text-muted);
        background: transparent;
        cursor: pointer;
      }
      .zapp-preview-devices button svg {
        width: 0.82rem;
        height: 0.82rem;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.7;
      }
      .zapp-preview-devices button[aria-pressed='true'] {
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-raised);
        box-shadow: 0 1px 2px rgb(24 24 27 / 0.12);
      }
      .zapp-preview-devices button:focus-visible {
        outline: 2px solid var(--zapp-focus);
        outline-offset: 1px;
      }
      .zapp-preview-share-result {
        position: absolute;
        z-index: 4;
        top: calc(100% + 0.35rem);
        right: 0.5rem;
        width: min(24rem, calc(100% - 1rem));
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-panel);
        padding: 0.65rem;
        background: var(--zapp-surface-raised);
        box-shadow: var(--zapp-shadow-card);
      }
      .zapp-preview-share-result label {
        display: grid;
        gap: 0.25rem;
      }
      .zapp-preview-share-result input {
        min-height: 2.5rem;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-pill);
        padding: 0.45rem 0.75rem;
      }
      .zapp-preview-stage {
        display: grid;
        min-height: 0;
        place-items: stretch center;
        overflow: auto;
        background: var(--zapp-surface-muted);
      }
      .zapp-preview-stage iframe {
        width: var(--zapp-preview-width);
        max-width: 100%;
        height: 100%;
        min-height: 100%;
        border: 0;
        background: white;
      }
      .zapp-preview-stage > .zapp-empty-state {
        align-self: stretch;
        max-width: none;
        align-content: center;
        border: 0;
        border-radius: 0;
        background: transparent;
      }
      .zapp-preview-state {
        display: grid;
        align-content: center;
        justify-items: center;
        gap: 0.75rem;
        width: 100%;
        padding: 2rem;
        text-align: center;
      }
      .zapp-preview-state h2,
      .zapp-preview-state p {
        margin: 0;
      }
      .zapp-preview-log-tail {
        width: min(44rem, 100%);
        max-height: 12rem;
        overflow: auto;
        border-radius: var(--zapp-radius-panel);
        padding: 0.75rem;
        background: var(--zapp-surface-inverse);
        color: var(--zapp-text-inverse);
        font-family: var(--zapp-font-mono);
        text-align: left;
        white-space: pre-wrap;
      }
      .zapp-preview-stale-banner,
      .zapp-preview-operation-status {
        padding: 0.5rem 0.75rem;
        border-radius: var(--zapp-radius-panel);
        background: var(--zapp-surface-subtle);
      }
      .zapp-preview-footer {
        min-height: 0;
        justify-content: space-between;
        padding: 0.2rem 0.65rem;
        border-top: 1px solid var(--zapp-border);
        background: var(--zapp-surface-raised);
      }
      .zapp-preview-footer .zapp-button {
        min-height: 2rem;
        padding: 0.35rem 0.65rem;
        font-size: var(--zapp-text-12);
      }
      .zapp-preview-capture-table {
        width: 100%;
        border-collapse: collapse;
      }
      .zapp-preview-capture-table th,
      .zapp-preview-capture-table td {
        padding: 0.55rem;
        border-bottom: 1px solid var(--zapp-border);
        text-align: left;
        vertical-align: top;
      }
      @media (max-width: 900px) {
        .zapp-preview-toolbar {
          justify-content: flex-start;
        }
        .zapp-preview-path {
          min-width: 4rem;
        }
      }
    `}</style>
  );
}

export function PreviewFrame({
  fallbackCommitSha,
  onAttachToChat,
  onAttachSelectionToChat,
  onRunCreated,
  organizationId,
  projectId,
  runId,
  runStatus,
}: PreviewFrameProps): ReactElement {
  const [attaching, setAttaching] = useState(false);
  const [captureEvents, setCaptureEvents] = useState<readonly BuilderPreviewEvent[]>([]);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [iframeGeneration, setIframeGeneration] = useState(0);
  const [logs, setLogs] = useState<LogResponse>();
  const [operationStatus, setOperationStatus] = useState<string>();
  const [path, setPath] = useState('/');
  const [publicShareUrl, setPublicShareUrl] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [shareRenewalGeneration, setShareRenewalGeneration] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const attachingRef = useRef(false);
  const fixRunAttemptRef = useRef<StoredFixAttempt | undefined>(undefined);
  const fixRunPendingRef = useRef(false);
  const logCursorRef = useRef(0);
  const logsRef = useRef<LogResponse | undefined>(undefined);
  const orgShareAttemptRef = useRef<
    { readonly attempt: StoredShareAttempt; readonly workspaceId: string } | undefined
  >(undefined);
  const publicShareKeyRef = useRef<string | undefined>(undefined);
  const publicSharePendingRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | undefined>(undefined);
  const refreshPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const restartKeyRef = useRef<string | undefined>(undefined);
  const restartPendingRef = useRef(false);
  const screenshotKeyRef = useRef<string | undefined>(undefined);
  const selectionScreenshotKeyRef = useRef<string | undefined>(undefined);
  const selectionPendingRef = useRef(false);
  const previewGenerationRef = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wakeKeyRef = useRef<string | undefined>(undefined);
  const wakePendingRef = useRef(false);
  const workspaceGenerationRef = useRef(0);
  const { events } = useRunEvents(runId, organizationId);
  const lifecycle = useMemo(() => previewLifecycle(events), [events]);
  const workspaceId = eventWorkspaceId(lifecycle.event);
  const previewUsable = lifecycle.event?.type === 'preview.ready' || logs?.state === 'ready';

  const refreshWorkspace = useCallback(
    async (signal?: AbortSignal, reset = false): Promise<void> => {
      if (workspaceId === undefined) return;
      const client = createControlPlaneClient(organizationId);
      let cursor = reset ? 0 : logCursorRef.current;
      const entries = new Map(
        (reset ? [] : (logsRef.current?.entries ?? [])).map((entry) => [entry.cursor, entry]),
      );
      let latest: LogResponse | undefined;
      for (let page = 0; page < maximumLogPagesPerRefresh; page += 1) {
        const nextLogs = await client.readDevServerLogs(workspaceId, cursor, signal);
        if (signal?.aborted === true) return;
        latest = nextLogs;
        for (const entry of nextLogs.entries) entries.set(entry.cursor, entry);
        const nextCursor = Math.max(cursor, nextLogs.nextCursor);
        const hasAnotherPage =
          nextLogs.entries.length === previewLogPageSize && nextCursor > cursor;
        cursor = nextCursor;
        if (!hasAnotherPage) break;
      }
      if (latest === undefined) return;
      const nextResponse: LogResponse = {
        ...latest,
        entries: [...entries.values()]
          .sort((left, right) => left.cursor - right.cursor)
          .slice(-maximumLogEntries),
        nextCursor: cursor,
      };
      logCursorRef.current = cursor;
      logsRef.current = nextResponse;
      setLogs(nextResponse);
    },
    [organizationId, workspaceId],
  );

  const refreshLatestWorkspace = useCallback(
    async (reset = false, replace = false): Promise<void> => {
      const inFlight = refreshPromiseRef.current;
      if (inFlight !== undefined && !replace) {
        await inFlight;
        return;
      }
      if (replace) refreshControllerRef.current?.abort();
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      const pending = refreshWorkspace(controller.signal, reset);
      refreshPromiseRef.current = pending;
      try {
        await pending;
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        if (refreshControllerRef.current === controller) {
          refreshControllerRef.current = undefined;
        }
        if (refreshPromiseRef.current === pending) refreshPromiseRef.current = undefined;
      }
    },
    [refreshWorkspace],
  );

  useLayoutEffect(() => {
    workspaceGenerationRef.current += 1;
    refreshControllerRef.current?.abort();
    attachingRef.current = false;
    fixRunAttemptRef.current = undefined;
    fixRunPendingRef.current = false;
    logCursorRef.current = 0;
    logsRef.current = undefined;
    publicShareKeyRef.current = undefined;
    publicSharePendingRef.current = false;
    restartKeyRef.current = undefined;
    restartPendingRef.current = false;
    screenshotKeyRef.current = undefined;
    selectionScreenshotKeyRef.current = undefined;
    selectionPendingRef.current = false;
    wakeKeyRef.current = undefined;
    wakePendingRef.current = false;
    setLogs(undefined);
    setCaptureEvents([]);
    setCaptureFailed(false);
    setAttaching(false);
    setOperationStatus(undefined);
    setPath('/');
    setPreviewUrl(undefined);
    setPublicShareUrl(undefined);
    setSharing(false);
    setSelecting(false);
    if (workspaceId === undefined) return;
    void refreshLatestWorkspace(true, true).catch(() => {
      setOperationStatus('Preview status could not be refreshed.');
    });
    return () => {
      refreshControllerRef.current?.abort();
    };
  }, [refreshLatestWorkspace, workspaceId]);

  useLayoutEffect(() => {
    previewGenerationRef.current += 1;
    selectionPendingRef.current = false;
    selectionScreenshotKeyRef.current = undefined;
    setSelecting(false);
  }, [previewUrl]);

  useEffect(() => {
    if (workspaceId === undefined || lifecycle.event?.type !== 'preview.starting') return;
    const timer = window.setInterval(() => {
      void refreshLatestWorkspace().catch(() => {
        setOperationStatus('Preview boot logs could not be refreshed.');
      });
    }, 2_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [lifecycle.event?.type, refreshLatestWorkspace, workspaceId]);

  useEffect(() => {
    if (workspaceId === undefined || lifecycle.event?.type !== 'preview.failed') return;
    void refreshLatestWorkspace(false, true).catch(() => {
      setOperationStatus('The final preview failure logs could not be refreshed.');
    });
  }, [lifecycle.event?.type, refreshLatestWorkspace, workspaceId]);

  useEffect(() => {
    if (workspaceId === undefined || !previewUsable) return;
    let current = true;
    let renewalTimer: number | undefined;
    const stored = readShareAttempt(workspaceId);
    const attempt =
      orgShareAttemptRef.current?.workspaceId === workspaceId &&
      Date.parse(orgShareAttemptRef.current.attempt.expiresAt) >
        Date.now() + previewShareRenewalWindowMs
        ? orgShareAttemptRef.current.attempt
        : (stored ?? {
            expiresAt: new Date(Date.now() + previewShareLifetimeMs).toISOString(),
            idempotencyKey: crypto.randomUUID(),
          });
    orgShareAttemptRef.current = { attempt, workspaceId };
    persistShareAttempt(workspaceId, attempt);
    createControlPlaneClient(organizationId)
      .createPreviewShare(workspaceId, 'org', attempt.idempotencyKey)
      .then((response) => {
        if (!current) return;
        const completedAttempt = {
          expiresAt: response.share.expiresAt,
          idempotencyKey: attempt.idempotencyKey,
        };
        orgShareAttemptRef.current = { attempt: completedAttempt, workspaceId };
        persistShareAttempt(workspaceId, completedAttempt);
        setPreviewUrl(response.share.url);
        const renewalDelay = Math.max(
          1_000,
          Date.parse(response.share.expiresAt) - Date.now() - previewShareRenewalWindowMs,
        );
        renewalTimer = window.setTimeout(() => {
          setShareRenewalGeneration((value) => value + 1);
        }, renewalDelay);
      })
      .catch(() => {
        if (!current) return;
        setOperationStatus('The authenticated preview link could not be created. Retrying…');
        renewalTimer = window.setTimeout(() => {
          setShareRenewalGeneration((value) => value + 1);
        }, 5_000);
      });
    return () => {
      current = false;
      if (renewalTimer !== undefined) window.clearTimeout(renewalTimer);
    };
  }, [organizationId, previewUsable, shareRenewalGeneration, workspaceId]);

  useEffect(() => {
    if (workspaceId === undefined || !previewUsable) return;
    let current = true;
    setCaptureFailed(false);
    const subscription = createControlPlaneClient(organizationId).subscribePreviewEvents(
      workspaceId,
      {
        onError() {
          if (current) setCaptureFailed(true);
        },
        onEvent(event) {
          if (!current) return;
          setCaptureFailed(false);
          setCaptureEvents((existing) => [...existing.slice(-499), event]);
          if (event.type === 'route_change') setPath(currentPath(event.payload.url));
        },
      },
    );
    void subscription.closed.catch(() => {
      if (current) setCaptureFailed(true);
    });
    return () => {
      current = false;
      subscription.close();
    };
  }, [connectionGeneration, organizationId, previewUsable, workspaceId]);

  const previewState: PreviewState = (() => {
    if (
      logs?.state !== 'ready' &&
      (lifecycle.event?.type === 'preview.failed' || logs?.state === 'failed')
    )
      return 'failed';
    if (
      lifecycle.event?.type === 'preview.starting' ||
      logs?.state === 'starting' ||
      logs?.state === 'restarting'
    )
      return 'starting';
    if (logs?.state === 'idle') return 'sleeping';
    if (lifecycle.stale) return 'stale';
    if (captureFailed) return 'disconnected';
    return 'ready';
  })();

  const restart = async (): Promise<void> => {
    if (workspaceId === undefined || restartPendingRef.current) return;
    restartPendingRef.current = true;
    const generation = workspaceGenerationRef.current;
    setOperationStatus('Restarting preview…');
    const idempotencyKey = restartKeyRef.current ?? crypto.randomUUID();
    restartKeyRef.current = idempotencyKey;
    try {
      await createControlPlaneClient(organizationId).restartDevServer(workspaceId, idempotencyKey);
      if (generation !== workspaceGenerationRef.current) return;
      restartKeyRef.current = undefined;
      setOperationStatus('Preview restart requested.');
      void refreshLatestWorkspace().catch(() => {
        setOperationStatus('Preview restart was requested, but logs could not be refreshed.');
      });
    } catch {
      if (generation === workspaceGenerationRef.current) {
        setOperationStatus('Preview restart failed. Retry safely.');
      }
    } finally {
      if (generation === workspaceGenerationRef.current) restartPendingRef.current = false;
    }
  };

  const wake = async (): Promise<void> => {
    if (workspaceId === undefined || wakePendingRef.current) return;
    wakePendingRef.current = true;
    const generation = workspaceGenerationRef.current;
    setOperationStatus('Waking preview…');
    const idempotencyKey = wakeKeyRef.current ?? crypto.randomUUID();
    wakeKeyRef.current = idempotencyKey;
    try {
      await createControlPlaneClient(organizationId).startWorkspace(workspaceId, idempotencyKey);
      if (generation !== workspaceGenerationRef.current) return;
      wakeKeyRef.current = undefined;
      setOperationStatus('Preview wake requested.');
      void refreshLatestWorkspace().catch(() => {
        setOperationStatus('Preview wake was requested, but logs could not be refreshed.');
      });
    } catch {
      if (generation === workspaceGenerationRef.current) {
        setOperationStatus('Preview could not be woken. Retry safely.');
      }
    } finally {
      if (generation === workspaceGenerationRef.current) wakePendingRef.current = false;
    }
  };

  const attachCapture = async (capture: BuilderPreviewEvent): Promise<void> => {
    if (workspaceId === undefined || attachingRef.current) return;
    attachingRef.current = true;
    const generation = workspaceGenerationRef.current;
    setAttaching(true);
    const idempotencyKey = screenshotKeyRef.current ?? crypto.randomUUID();
    screenshotKeyRef.current = idempotencyKey;
    try {
      const screenshot = await createControlPlaneClient(organizationId).capturePreviewScreenshot(
        workspaceId,
        idempotencyKey,
      );
      const blob = await new Response(screenshot.body, {
        headers: { 'content-type': screenshot.contentType },
      }).blob();
      if (generation !== workspaceGenerationRef.current) return;
      screenshotKeyRef.current = undefined;
      if (blob.size > maximumComposerImageBytes) {
        setOperationStatus('The error screenshot is larger than the 8 MiB attachment limit.');
        return;
      }
      const file = new File([blob], 'console-error.png', { type: 'image/png' });
      const accepted = await onAttachToChat(file, capture);
      if (generation !== workspaceGenerationRef.current) return;
      if (!accepted) {
        setOperationStatus('The chat composer already has the maximum of 10 images.');
        return;
      }
      setConsoleOpen(false);
      setOperationStatus('Console error capture sent to the chat composer.');
    } catch {
      if (generation === workspaceGenerationRef.current) {
        setOperationStatus('The error screenshot could not be attached.');
      }
    } finally {
      if (generation === workspaceGenerationRef.current) {
        attachingRef.current = false;
        setAttaching(false);
      }
    }
  };

  const attachSelectedElement = useCallback(
    async (selection: Omit<SelectedPreviewElement, 'path'>): Promise<void> => {
      if (workspaceId === undefined || selectionPendingRef.current) return;
      selectionPendingRef.current = true;
      const generation = workspaceGenerationRef.current;
      const previewGeneration = previewGenerationRef.current;
      setSelecting(true);
      setOperationStatus('Capturing the selected element.');
      const idempotencyKey = selectionScreenshotKeyRef.current ?? crypto.randomUUID();
      selectionScreenshotKeyRef.current = idempotencyKey;
      try {
        const screenshot = await createControlPlaneClient(organizationId).capturePreviewScreenshot(
          workspaceId,
          idempotencyKey,
        );
        const blob = await new Response(screenshot.body, {
          headers: { 'content-type': screenshot.contentType },
        }).blob();
        if (
          generation !== workspaceGenerationRef.current ||
          previewGeneration !== previewGenerationRef.current
        )
          return;
        selectionScreenshotKeyRef.current = undefined;
        if (blob.size <= 0 || blob.size > maximumComposerImageBytes) {
          setOperationStatus(
            'The selected-element screenshot is outside the 1 byte to 8 MiB attachment limit.',
          );
          return;
        }
        const accepted = await onAttachSelectionToChat(
          new File([blob], 'selected-element.png', { type: 'image/png' }),
          { ...selection, path },
        );
        if (
          generation !== workspaceGenerationRef.current ||
          previewGeneration !== previewGenerationRef.current
        )
          return;
        if (!accepted) {
          setOperationStatus('The chat composer already has the maximum of 10 images.');
          return;
        }
        setOperationStatus('Selected element attached to the chat composer.');
      } catch {
        if (
          generation === workspaceGenerationRef.current &&
          previewGeneration === previewGenerationRef.current
        ) {
          setOperationStatus('The selected element could not be attached.');
        }
      } finally {
        if (
          generation === workspaceGenerationRef.current &&
          previewGeneration === previewGenerationRef.current
        ) {
          selectionPendingRef.current = false;
          setSelecting(false);
        }
      }
    },
    [onAttachSelectionToChat, organizationId, path, workspaceId],
  );

  const createFixRun = async (): Promise<void> => {
    if (fixRunPendingRef.current) return;
    fixRunPendingRef.current = true;
    const generation = workspaceGenerationRef.current;
    setOperationStatus('Starting a Fix run…');
    try {
      let attempt = fixRunAttemptRef.current;
      if (attempt === undefined) {
        await refreshLatestWorkspace();
        if (generation !== workspaceGenerationRef.current) return;
        const relevantCommitSha = latestCommitSha(events) ?? fallbackCommitSha;
        if (relevantCommitSha === undefined) {
          setOperationStatus('A committed preview revision is required before Fix can start.');
          return;
        }
        const capturedLog = logContext(logsRef.current).slice(0, 8_000);
        attempt = {
          attachmentIdempotencyKey: crypto.randomUUID(),
          evidenceSummary: `Preview boot log:\n${capturedLog}`.slice(0, 2_000),
          idempotencyKey: crypto.randomUUID(),
          prompt: `Fix the preview boot failure. Use this captured boot log:\n\n${capturedLog}`,
          relevantCommitSha,
          reproductionRef: `preview-workspace:${workspaceId ?? 'unknown'}`,
          screenshotIdempotencyKey: crypto.randomUUID(),
          summary: `Preview boot failure.\n${capturedLog}`.slice(0, 10_000),
        };
        fixRunAttemptRef.current = attempt;
      }
      const client = createControlPlaneClient(organizationId);
      if (attempt.evidenceArtifactId === undefined) {
        if (workspaceId === undefined) return;
        const screenshot = await client.capturePreviewScreenshot(
          workspaceId,
          attempt.screenshotIdempotencyKey,
        );
        if (generation !== workspaceGenerationRef.current) return;
        const blob = await new Response(screenshot.body, {
          headers: { 'content-type': 'image/png' },
        }).blob();
        if (generation !== workspaceGenerationRef.current) return;
        if (blob.size > maximumComposerImageBytes) {
          setOperationStatus('The preview evidence is larger than the 8 MiB attachment limit.');
          return;
        }
        const evidence = await client.uploadAttachment(
          projectId,
          new File([blob], 'preview-boot-failure.png', { type: 'image/png' }),
          attempt.attachmentIdempotencyKey,
        );
        if (generation !== workspaceGenerationRef.current) return;
        attempt = { ...attempt, evidenceArtifactId: evidence.attachmentId };
        fixRunAttemptRef.current = attempt;
      }
      const evidenceArtifactId = attempt.evidenceArtifactId;
      if (evidenceArtifactId === undefined) return;
      const created = await client.createRun(
        projectId,
        {
          appType: 'web',
          fixRequest: {
            evidence: [
              {
                artifactId: evidenceArtifactId,
                kind: 'preview_console',
                summary: attempt.evidenceSummary,
              },
            ],
            relevantCommitSha: attempt.relevantCommitSha,
            reproductionRef: attempt.reproductionRef,
            source: 'error_report',
            summary: attempt.summary,
          },
          mode: 'fix',
          prompt: attempt.prompt,
        },
        attempt.idempotencyKey,
      );
      if (generation !== workspaceGenerationRef.current) return;
      fixRunAttemptRef.current = undefined;
      onRunCreated(created.run);
      setOperationStatus('Fix run started with the boot log context.');
    } catch {
      if (generation === workspaceGenerationRef.current) {
        setOperationStatus('The Fix run could not be started.');
      }
    } finally {
      if (generation === workspaceGenerationRef.current) fixRunPendingRef.current = false;
    }
  };

  const createPublicShare = async (): Promise<void> => {
    if (workspaceId === undefined || publicSharePendingRef.current) return;
    publicSharePendingRef.current = true;
    const generation = workspaceGenerationRef.current;
    setSharing(true);
    const idempotencyKey = publicShareKeyRef.current ?? crypto.randomUUID();
    publicShareKeyRef.current = idempotencyKey;
    try {
      const response = await createControlPlaneClient(organizationId).createPreviewShare(
        workspaceId,
        'anyone_with_link',
        idempotencyKey,
      );
      if (generation !== workspaceGenerationRef.current) return;
      publicShareKeyRef.current = undefined;
      setPublicShareUrl(response.share.url);
    } catch {
      if (generation === workspaceGenerationRef.current) {
        setOperationStatus('The share link could not be created.');
      }
    } finally {
      if (generation === workspaceGenerationRef.current) {
        publicSharePendingRef.current = false;
        setSharing(false);
      }
    }
  };

  const previewContent = (): ReactElement => {
    if (lifecycle.event === undefined || workspaceId === undefined) {
      return (
        <EmptyState
          description={
            runStatus === 'queued'
              ? 'The agent accepted your request and will start the workspace next.'
              : runStatus === 'running'
                ? 'The agent is preparing the first workspace and preview.'
                : 'The preview will appear after the agent starts a workspace.'
          }
          title={
            runStatus === 'queued'
              ? 'Build queued'
              : runStatus === 'running'
                ? 'Workspace is starting'
                : 'Preview unavailable'
          }
        />
      );
    }
    if (previewState === 'starting') {
      return (
        <div aria-busy="true" className="zapp-preview-state">
          <h2>Preview starting</h2>
          <p>Preparing the authenticated development preview…</p>
          <pre className="zapp-preview-log-tail">
            {logs?.entries
              .slice(-8)
              .map((entry) => entry.message)
              .join('\n') || 'Waiting for boot logs…'}
          </pre>
        </div>
      );
    }
    if (previewState === 'sleeping') {
      return (
        <div className="zapp-preview-state">
          <h2>Preview sleeping</h2>
          <p>The workspace is not running. Wake it without creating a new workspace.</p>
          <Button onClick={() => void wake()}>Wake preview</Button>
        </div>
      );
    }
    if (previewState === 'disconnected') {
      return (
        <div className="zapp-preview-state">
          <h2>Preview disconnected</h2>
          <p>The authenticated capture channel dropped. The workspace remains unchanged.</p>
          <Button
            onClick={() => {
              setConnectionGeneration((value) => value + 1);
            }}
          >
            Retry preview connection
          </Button>
        </div>
      );
    }
    if (previewState === 'failed') {
      return (
        <ErrorState
          description="The dev server could not produce a healthy preview."
          onAskAgent={() => {
            setConsoleOpen(true);
          }}
          onFixAutomatically={() => void createFixRun()}
          onInspectDetails={() => {
            setConsoleOpen(true);
          }}
          onRetry={() => void restart()}
          title="Preview failed"
        />
      );
    }
    return previewUrl === undefined ? (
      <div aria-busy="true" className="zapp-preview-state">
        <h2>Opening preview</h2>
        <p>Creating a short-lived authenticated preview session…</p>
      </div>
    ) : (
      <iframe
        ref={iframeRef}
        key={`${previewUrl}-${String(iframeGeneration)}`}
        src={previewUrl}
        style={{ '--zapp-preview-width': previewWidths[device] } as CSSProperties}
        title="Application preview"
      />
    );
  };

  return (
    <div className="zapp-preview-panel">
      <PreviewStyles />
      <PreviewToolbar
        device={device}
        onDeviceChange={setDevice}
        onOpen={() => {
          if (previewUrl !== undefined) window.open(previewUrl, '_blank', 'noopener,noreferrer');
        }}
        onRefresh={() => {
          previewGenerationRef.current += 1;
          selectionPendingRef.current = false;
          selectionScreenshotKeyRef.current = undefined;
          setSelecting(false);
          setIframeGeneration((value) => value + 1);
        }}
        onShare={() => void createPublicShare()}
        path={path}
        {...(publicShareUrl === undefined ? {} : { shareUrl: publicShareUrl })}
        sharing={sharing}
      >
        <SelectMode
          disabled={previewState !== 'ready' || selecting}
          iframeRef={iframeRef}
          onSelected={(selection) => {
            void attachSelectedElement(selection);
          }}
          {...(previewUrl === undefined ? {} : { previewUrl })}
        />
      </PreviewToolbar>
      {previewState === 'stale' ? (
        <div className="zapp-preview-stale-banner" role="status">
          Preview is behind latest changes — Restart{' '}
          <Button onClick={() => void restart()} variant="secondary">
            Restart
          </Button>
        </div>
      ) : null}
      <div aria-label="Application preview" className="zapp-preview-stage" role="region">
        {previewContent()}
      </div>
      <div className="zapp-preview-footer">
        <ConsoleDrawer
          attaching={attaching}
          events={captureEvents}
          onAttach={(capture) => void attachCapture(capture)}
          onOpenChange={setConsoleOpen}
          open={consoleOpen}
        />
        {operationStatus === undefined ? null : (
          <p aria-live="polite" className="zapp-preview-operation-status">
            {operationStatus}
          </p>
        )}
      </div>
    </div>
  );
}
