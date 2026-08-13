'use client';

import { createZappClient, ZappApiError } from '@zapp/api-client';
import { Button, Drawer, EmptyState, ErrorState } from '@zapp/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';

import {
  createControlPlaneClient,
  type BuilderRun,
  type MissionControlData,
  type ResolveApprovalInput,
} from '../../lib/api';
import { readFirstPrompt } from '../../lib/prompt-handoff';
import { useAppSession } from '../../hooks/useAppSession';
import { Thread } from '../conversation/Thread';
import type { ConversationImageInput } from '../conversation/Composer';
import { WorkingSurface } from './WorkingSurface';
import type { SelectedPreviewElement } from '../preview/SelectMode';
import { TopBar } from './TopBar';
import { BuilderDeploy } from './BuilderDeploy';
import { IncidentBanner } from './IncidentBanner';
import { Overview } from '../mission-control/Overview';
import { TaskGraph } from '../mission-control/TaskGraph';
import { Agents } from '../mission-control/Agents';
import { Activity } from '../mission-control/Activity';
import { FilesCommits } from '../mission-control/FilesCommits';
import { Tests } from '../mission-control/Tests';
import { Approvals } from '../mission-control/Approvals';
import { Risks } from '../mission-control/Risks';
import { AppShell } from '../shell/AppShell';
import {
  DEFAULT_BUILDER_NAVIGATION,
  parseBuilderNavigation,
  serializeBuilderNavigation,
  type BuilderMode,
  type BuilderNavigation,
  type BuilderPane,
  type ManageSection,
} from './builder-navigation';

const defaultConversationWidth = 40;
const minimumConversationWidth = 28;
const maximumConversationWidth = 75;
const minimumConversationPixels = 380;

interface ShellProps {
  readonly projectId: string;
}

function controlPlaneUrl(): string {
  const value = process.env.NEXT_PUBLIC_CONTROL_API_URL;
  if (value === undefined || value.length === 0) {
    throw new Error('NEXT_PUBLIC_CONTROL_API_URL must be configured.');
  }
  return value;
}

function getProject(organizationId: string, projectId: string) {
  return createZappClient({
    baseUrl: controlPlaneUrl(),
    getToken: () => '',
  }).request('/v1/projects/{projectId}', {
    method: 'GET',
    headers: { 'x-organization-id': organizationId },
    path: { projectId },
  });
}

type ProjectResponse = Awaited<ReturnType<typeof getProject>>;

function conversationWidthKey(projectId: string): string {
  return `zapp:builder:conversation-width:${projectId}`;
}

function missionControlKey(projectId: string): string {
  return `zapp:builder:mission-control:${projectId}`;
}

function safeConversationWidth(value: string | null): number {
  if (value === null || value.trim().length === 0) return defaultConversationWidth;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultConversationWidth;
  return Math.min(maximumConversationWidth, Math.max(minimumConversationWidth, parsed));
}

function measuredConversationMinimum(splitWidth: number): number {
  const measured =
    splitWidth > 0 ? (minimumConversationPixels / splitWidth) * 100 : minimumConversationWidth;
  return Math.min(maximumConversationWidth, Math.max(minimumConversationWidth, measured));
}

function normalizedConversationWidth(value: number, splitWidth: number): number {
  const measuredMinimum = measuredConversationMinimum(splitWidth);
  return Math.min(
    maximumConversationWidth,
    Math.max(minimumConversationWidth, measuredMinimum, value),
  );
}

function BuilderStyles(): ReactElement {
  return (
    <style jsx global>{`
      .zapp-builder-shell {
        min-height: 100vh;
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-canvas);
        font-family: var(--zapp-font-sans);
      }

      .zapp-builder-top-bar {
        position: relative;
        z-index: 2;
        display: flex;
        min-height: 4.5rem;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--zapp-border);
        background: var(--zapp-surface-raised);
      }

      .zapp-builder-project-identity,
      .zapp-builder-project-actions {
        display: flex;
        align-items: center;
        gap: 0.625rem;
      }

      .zapp-builder-project-identity {
        min-width: 0;
      }

      .zapp-builder-project-name {
        overflow: hidden;
        margin: 0;
        font-size: var(--zapp-text-18);
        line-height: 1.3;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .zapp-builder-project-title {
        display: grid;
        min-width: 0;
        gap: 0.05rem;
      }

      .zapp-builder-save-state {
        color: var(--zapp-text-tertiary);
        font-size: var(--zapp-text-12);
      }

      .zapp-builder-project-actions {
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .zapp-builder-action-link,
      .zapp-builder-settings-link {
        display: inline-flex;
        min-height: 2.5rem;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        padding: 0.45rem 0.75rem;
        border: 1px solid var(--zapp-border);
        border-radius: var(--zapp-radius-pill);
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-raised);
        font-size: var(--zapp-text-14);
        font-weight: 600;
        text-decoration: none;
      }

      .zapp-builder-settings-link {
        width: 2.5rem;
        padding: 0;
      }

      .zapp-builder-action-link:hover,
      .zapp-builder-settings-link:hover {
        background: var(--zapp-surface-subtle);
      }

      .zapp-builder-action-link:focus-visible,
      .zapp-builder-settings-link:focus-visible,
      .zapp-builder-deploy-help:focus-visible {
        outline: 3px solid var(--zapp-focus);
        outline-offset: 2px;
      }

      .zapp-builder-action-icon {
        width: 1.125rem;
        height: 1.125rem;
        flex: 0 0 auto;
      }

      .zapp-builder-sync-pill {
        display: inline-flex;
        align-items: center;
        padding: 0.15rem 0.45rem;
        border-radius: var(--zapp-radius-pill);
        font-size: var(--zapp-text-12);
        font-weight: 700;
      }

      .zapp-builder-sync-pill[data-sync-state='synced'] {
        color: var(--zapp-status-success);
        background: var(--zapp-support-managed-bg);
      }

      .zapp-builder-sync-pill[data-sync-state='ahead'] {
        color: var(--zapp-status-warning);
        background: var(--zapp-surface-subtle);
      }

      .zapp-builder-sync-pill[data-sync-state='diverged'] {
        color: var(--zapp-status-danger);
        background: var(--zapp-danger-surface);
      }

      .zapp-builder-sync-pill[data-sync-state='unavailable'] {
        color: var(--zapp-text-secondary);
        background: var(--zapp-surface-subtle);
      }

      .zapp-builder-deploy-help {
        display: inline-flex;
        border-radius: var(--zapp-radius-pill);
      }

      .zapp-builder-notice {
        margin: 0;
        padding: 0.625rem 1rem;
        border-bottom: 1px solid var(--zapp-border);
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-subtle);
        font-size: var(--zapp-text-14);
      }

      .zapp-builder-workspace {
        display: grid;
        min-height: calc(100vh - 4.5rem);
        grid-template-columns: minmax(0, 1fr);
        transition: grid-template-columns 160ms ease;
      }

      .zapp-builder-workspace[data-inline-mission='open'] {
        grid-template-columns: minmax(0, 1fr) 20rem;
      }

      .zapp-builder-split {
        display: grid;
        min-width: 0;
        min-height: 0;
        grid-template-columns: minmax(380px, var(--conversation-width)) 0.625rem minmax(0, 1fr);
      }

      .zapp-builder-pane {
        min-width: 0;
        overflow: auto;
        padding: 1.25rem;
        background: var(--zapp-surface-raised);
      }

      .zapp-builder-pane:last-child {
        background: var(--zapp-surface-canvas);
      }

      .zapp-builder-separator {
        position: relative;
        display: flex;
        cursor: col-resize;
        align-items: center;
        justify-content: center;
        border-inline: 1px solid var(--zapp-border);
        background: var(--zapp-surface-subtle);
        touch-action: none;
      }

      .zapp-builder-separator:focus-visible {
        z-index: 1;
        outline: 3px solid var(--zapp-focus);
        outline-offset: -3px;
      }

      .zapp-builder-separator-handle {
        width: 0.2rem;
        height: 2rem;
        border-radius: var(--zapp-radius-pill);
        background: var(--zapp-border-strong);
      }

      .zapp-builder-surface-tabs {
        min-height: 100%;
      }

      .zapp-builder-mission-control {
        min-width: 0;
        padding: 1rem;
        border-left: 1px solid var(--zapp-border);
        background: var(--zapp-surface-raised);
        box-shadow: var(--zapp-shadow-overlay);
      }

      .zapp-builder-mission-control-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1rem;
      }

      .zapp-builder-mission-control-header h2 {
        margin: 0;
        font-size: var(--zapp-text-18);
      }

      .zapp-builder-mobile-switcher {
        display: none;
      }

      .zapp-builder-load-state {
        display: grid;
        min-height: 100vh;
        place-content: center;
        gap: 1rem;
        padding: 1.5rem;
        color: var(--zapp-text-primary);
        background: var(--zapp-surface-canvas);
        font-family: var(--zapp-font-sans);
      }

      @media (max-width: 1279px) {
        .zapp-builder-workspace[data-inline-mission='open'] {
          grid-template-columns: minmax(0, 1fr);
        }
      }

      @media (max-width: 1023px) {
        .zapp-builder-shell {
          padding-bottom: 4.5rem;
        }

        .zapp-builder-top-bar {
          align-items: flex-start;
          flex-direction: column;
        }

        .zapp-builder-project-actions {
          width: 100%;
          justify-content: flex-start;
        }

        .zapp-builder-workspace,
        .zapp-builder-split {
          display: block;
          min-height: calc(100vh - 10rem);
        }

        .zapp-builder-pane {
          min-height: calc(100vh - 14.5rem);
        }

        .zapp-builder-pane[data-mobile-active='false'] {
          display: none;
        }

        .zapp-builder-separator {
          display: none;
        }

        .zapp-builder-mobile-switcher {
          position: fixed;
          z-index: 3;
          right: 0;
          bottom: 0;
          left: 0;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0.5rem;
          padding: 0.75rem 1rem;
          border-top: 1px solid var(--zapp-border);
          background: var(--zapp-surface-raised);
        }
      }

      @media (max-width: 700px) {
        .zapp-builder-project-identity,
        .zapp-builder-project-actions {
          align-items: flex-start;
          flex-direction: column;
        }

        .zapp-builder-project-actions,
        .zapp-builder-project-actions > * {
          width: 100%;
        }

        .zapp-builder-action-link,
        .zapp-builder-settings-link {
          width: 100%;
        }
      }
    `}</style>
  );
}

function MissionControlEmpty(): ReactElement {
  return (
    <EmptyState
      description="Run phases and verification evidence will appear after a run starts."
      title="No run in progress"
    />
  );
}

const missionTabs = ['Overview', 'Tasks', 'Agents', 'Activity', 'Files/Commits', 'Tests', 'Approvals', 'Risks'] as const;
type MissionTab = (typeof missionTabs)[number];
type ApprovalKind = NonNullable<ResolveApprovalInput['kind']>;
const approvalKinds = new Set<ApprovalKind>([
  'budget_increase', 'specification', 'plan', 'plan_diff', 'migration', 'deploy',
]);

function isApprovalKind(value: string): value is ApprovalKind {
  return approvalKinds.has(value as ApprovalKind);
}

function MissionControlPanel({ organizationId, runId, onOpenPreview, onCompare }: {
  readonly organizationId: string;
  readonly runId: string;
  readonly onOpenPreview: () => void;
  readonly onCompare: () => void;
}): ReactElement {
  const client = useMemo(() => createControlPlaneClient(organizationId), [organizationId]);
  const [activeTab, setActiveTab] = useState<MissionTab>('Overview');
  const [announcement, setAnnouncement] = useState('');
  const [data, setData] = useState<MissionControlData>();
  const [redirect, setRedirect] = useState('');

  const reload = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setData(await client.getMissionControl(runId, signal));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setAnnouncement('Mission Control could not refresh.');
    }
  }, [client, runId]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const interval = window.setInterval(() => { void reload(controller.signal); }, 2_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [reload]);

  const runAction = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setAnnouncement(`${label} requested.`);
    try {
      await action();
      await reload();
      setAnnouncement(`${label} applied.`);
    } catch {
      await reload();
      setAnnouncement(`${label} was not applied.`);
    }
  };

  const resolveApproval = (approvalId: string, type: string, decision: 'approved' | 'rejected'): void => {
    if (!isApprovalKind(type)) {
      setAnnouncement('This approval type is not supported.');
      return;
    }
    void runAction(decision === 'approved' ? 'Approval' : 'Rejection', () =>
      client.resolveRunApproval(runId, approvalId, { kind: type, decision }),
    );
  };

  if (data === undefined) return <p role="status">Loading Mission Control…</p>;
  const content: Record<MissionTab, ReactElement> = {
    Overview: <Overview data={data} />,
    Tasks: <TaskGraph data={data} onRetry={(taskId) => { void runAction('Task retry', () => client.retryRunTask(runId, taskId)); }} onSkip={(phaseId) => { void runAction('Phase skip', () => client.skipRunPhase(runId, phaseId)); }} />,
    Agents: <Agents data={data} />,
    Activity: <Activity data={data} />,
    'Files/Commits': <FilesCommits data={data} onCompare={onCompare} />,
    Tests: <Tests data={data} />,
    Approvals: <Approvals data={data} onResolve={resolveApproval} />,
    Risks: <Risks data={data} />,
  };
  return <div className="zapp-mission-content">
    <div aria-label="Mission Control views" role="tablist">{missionTabs.map((tab) => <button aria-selected={activeTab === tab} key={tab} onClick={() => { setActiveTab(tab); }} role="tab" type="button">{tab}</button>)}</div>
    <div aria-live="polite" className="zapp-mission-announcement">{announcement}</div>
    <div aria-label={`${activeTab} view`} role="tabpanel">{content[activeTab]}</div>
    <div aria-label="Run actions">
      {data.run.status === 'paused' ? <button onClick={() => { void runAction('Resume', () => client.resumeRun(runId)); }} type="button">Resume</button> : <button onClick={() => { void runAction('Pause', () => client.pauseRun(runId)); }} type="button">Pause</button>}
      <button onClick={() => { if (globalThis.confirm('Cancel this run?')) void runAction('Cancel', () => client.cancelRun(runId)); }} type="button">Cancel</button>
      <button onClick={onOpenPreview} type="button">Open preview</button>
      <form onSubmit={(event) => { event.preventDefault(); const prompt = redirect.trim(); if (prompt.length === 0) return; void runAction('Redirect', () => client.redirectRun(runId, prompt)); setRedirect(''); }}>
        <label>Redirect instructions<input maxLength={4_000} onChange={(event) => { setRedirect(event.target.value); }} value={redirect} /></label>
        <button disabled={redirect.trim().length === 0} type="submit">Redirect</button>
      </form>
    </div>
  </div>;
}

export function Shell({ projectId }: ShellProps): ReactElement {
  const session = useAppSession();
  const [activeRun, setActiveRun] = useState<BuilderRun>();
  const [desktopSplit, setDesktopSplit] = useState(false);
  const [effectiveConversationWidth, setEffectiveConversationWidth] =
    useState(defaultConversationWidth);
  const [conversationMinimum, setConversationMinimum] = useState(minimumConversationWidth);
  const [errorDetail, setErrorDetail] = useState<string>();
  const [focusPreviewRequest, setFocusPreviewRequest] = useState(0);
  const [firstPrompt, setFirstPrompt] = useState<string>();
  const [inlineMissionControl, setInlineMissionControl] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [missionControlOpen, setMissionControlOpen] = useState(false);
  const [navigation, setNavigation] = useState<BuilderNavigation>(DEFAULT_BUILDER_NAVIGATION);
  const [navigationReady, setNavigationReady] = useState(false);
  const [failedPreferenceKeys, setFailedPreferenceKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [project, setProject] = useState<ProjectResponse>();
  const [previewAttachments, setPreviewAttachments] = useState<readonly ConversationImageInput[]>(
    [],
  );
  const preferredConversationWidthRef = useRef(defaultConversationWidth);
  const activeResizePointerIdRef = useRef<number | null>(null);
  const missionControlTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreMissionControlFocusRef = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const readySession = session.snapshot.status === 'ready' ? session.snapshot : undefined;
  const organizationId = readySession?.membership.organization.id;
  const allowedModels = readySession?.membership.allowedModels ?? [];

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = (): void => {
      setDesktopSplit(media.matches);
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    const restore = (): void => {
      setNavigation(parseBuilderNavigation(new URLSearchParams(window.location.search)));
      setNavigationReady(true);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener('popstate', restore);
    };
  }, []);

  useEffect(() => {
    if (!navigationReady) return;
    const current = new URLSearchParams(window.location.search);
    for (const key of ['mode', 'view', 'section', 'pane']) current.delete(key);
    const builder = new URLSearchParams(serializeBuilderNavigation(navigation));
    builder.forEach((value, key) => {
      current.set(key, value);
    });
    const query = current.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
    );
  }, [navigation, navigationReady]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const update = (): void => {
      setInlineMissionControl(media.matches);
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    let current = true;
    const isCurrent = (): boolean => current;

    const load = async (): Promise<void> => {
      setErrorDetail(undefined);
      setFailedPreferenceKeys(new Set());
      setLoadFailed(false);
      setFirstPrompt(undefined);
      setProject(undefined);
      if (session.snapshot.status === 'loading') return;
      if (session.snapshot.status !== 'ready') {
        setLoadFailed(true);
        return;
      }
      try {
        const organizationId = session.snapshot.membership.organization.id;
        const loadedProject = await getProject(organizationId, projectId);
        if (!isCurrent()) return;

        const restoredWidth = safeConversationWidth(
          localStorage.getItem(conversationWidthKey(projectId)),
        );
        preferredConversationWidthRef.current = restoredWidth;
        setEffectiveConversationWidth(restoredWidth);
        setMissionControlOpen(localStorage.getItem(missionControlKey(projectId)) === 'true');
        setFirstPrompt(readFirstPrompt(projectId));
        setProject(loadedProject);
      } catch (error) {
        if (error instanceof ZappApiError && error.status === 401) {
          window.location.replace('/login');
          return;
        }
        if (current) setLoadFailed(true);
      }
    };

    void load();
    return () => {
      current = false;
    };
  }, [loadAttempt, projectId, session.snapshot]);

  const updateConversationWidth = useCallback((nextWidth: number) => {
    const splitWidth = splitRef.current?.getBoundingClientRect().width ?? 0;
    const clamped = normalizedConversationWidth(nextWidth, splitWidth);
    preferredConversationWidthRef.current = clamped;
    setEffectiveConversationWidth(clamped);
    return clamped;
  }, []);

  const persistPreference = useCallback((key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
      setFailedPreferenceKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    } catch {
      setFailedPreferenceKeys((current) => {
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        return next;
      });
    }
  }, []);

  const saveConversationWidth = useCallback(
    (nextWidth: number) => {
      const clamped = updateConversationWidth(nextWidth);
      persistPreference(conversationWidthKey(projectId), String(clamped));
    },
    [persistPreference, projectId, updateConversationWidth],
  );

  const persistCurrentConversationWidth = useCallback((): void => {
    persistPreference(
      conversationWidthKey(projectId),
      String(preferredConversationWidthRef.current),
    );
  }, [persistPreference, projectId]);

  const toggleMissionControl = useCallback(
    (open: boolean): void => {
      setMissionControlOpen(open);
      persistPreference(missionControlKey(projectId), String(open));
    },
    [persistPreference, projectId],
  );

  useEffect(() => {
    if (missionControlOpen || !restoreMissionControlFocusRef.current) return;
    restoreMissionControlFocusRef.current = false;
    missionControlTriggerRef.current?.focus();
  }, [missionControlOpen]);

  useLayoutEffect(() => {
    if (project === undefined || splitRef.current === null) return;
    const split = splitRef.current;
    const normalize = (): void => {
      if (!desktopSplit) {
        setConversationMinimum(minimumConversationWidth);
        setEffectiveConversationWidth(preferredConversationWidthRef.current);
        return;
      }
      const splitWidth = split.getBoundingClientRect().width;
      setConversationMinimum(measuredConversationMinimum(splitWidth));
      setEffectiveConversationWidth(
        normalizedConversationWidth(preferredConversationWidthRef.current, splitWidth),
      );
    };
    normalize();
    const observer = new ResizeObserver(normalize);
    observer.observe(split);
    return () => {
      observer.disconnect();
    };
  }, [desktopSplit, project]);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent): void => {
      if (
        activeResizePointerIdRef.current === null ||
        event.pointerId !== activeResizePointerIdRef.current ||
        splitRef.current === null
      ) {
        return;
      }
      const bounds = splitRef.current.getBoundingClientRect();
      updateConversationWidth(((event.clientX - bounds.left) / bounds.width) * 100);
    };
    const stop = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== activeResizePointerIdRef.current) return;
      activeResizePointerIdRef.current = null;
      persistCurrentConversationWidth();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      activeResizePointerIdRef.current = null;
    };
  }, [persistCurrentConversationWidth, updateConversationWidth]);

  const closeInlineMissionControl = (): void => {
    restoreMissionControlFocusRef.current = true;
    toggleMissionControl(false);
  };

  const previewSurface = (): void => {
    setNavigation((current) => ({
      ...current,
      mode: 'preview',
      pane: 'workspace',
      preview: 'preview',
    }));
    setFocusPreviewRequest((value) => value + 1);
  };

  const openCommit = (): void => {
    setNavigation((current) => ({
      ...current,
      mode: 'preview',
      pane: 'workspace',
      preview: 'code',
    }));
  };

  const selectMode = (mode: BuilderMode): void => {
    if (mode === 'preview' && navigation.mode === 'preview') {
      previewSurface();
      return;
    }
    setNavigation((current) => ({ ...current, mode, pane: 'workspace' }));
  };

  const selectManageSection = (section: ManageSection): void => {
    setNavigation((current) => ({ ...current, manage: section }));
  };

  const selectPane = (pane: BuilderPane): void => {
    setNavigation((current) => ({ ...current, pane }));
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    saveConversationWidth(effectiveConversationWidth + (event.key === 'ArrowLeft' ? -2 : 2));
  };

  const beginResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (activeResizePointerIdRef.current !== null) return;
    event.preventDefault();
    activeResizePointerIdRef.current = event.pointerId;
  };

  const retry = (): void => {
    session.retry();
    setLoadAttempt((value) => value + 1);
  };

  if (loadFailed) {
    return (
      <>
        <BuilderStyles />
        <main className="zapp-builder-load-state">
          <ErrorState
            description="Your session and project data remain unchanged."
            onAskAgent={() => {
              setErrorDetail('The agent can help after the project session reconnects.');
            }}
            onFixAutomatically={retry}
            onInspectDetails={() => {
              setErrorDetail('The session or project read could not be completed.');
            }}
            onRetry={retry}
            title="We could not load this project"
          />
          {errorDetail === undefined ? null : <p role="status">{errorDetail}</p>}
        </main>
      </>
    );
  }

  if (project === undefined || organizationId === undefined || readySession === undefined) {
    return (
      <>
        <BuilderStyles />
        <main className="zapp-builder-load-state">Loading builder…</main>
      </>
    );
  }

  const missionTrigger = (
    <Button
      aria-expanded={missionControlOpen}
      onClick={
        inlineMissionControl
          ? () => {
              toggleMissionControl(!missionControlOpen);
            }
          : undefined
      }
      ref={missionControlTriggerRef}
      variant="secondary"
    >
      Mission Control
    </Button>
  );
  const missionControl = inlineMissionControl ? (
    missionTrigger
  ) : (
    <Drawer
      description="Current run status and verification evidence."
      onOpenChange={toggleMissionControl}
      open={missionControlOpen}
      title="Mission Control"
      trigger={missionTrigger}
    >
      {activeRun === undefined ? <MissionControlEmpty /> : <MissionControlPanel organizationId={organizationId} runId={activeRun.id} onOpenPreview={previewSurface} onCompare={openCommit} />}
    </Drawer>
  );
  const splitStyle = {
    '--conversation-width': `${String(effectiveConversationWidth)}%`,
  } as CSSProperties;
  const announcedConversationMinimum = Math.ceil(conversationMinimum);
  const announcedConversationWidth = Math.max(
    announcedConversationMinimum,
    Math.round(effectiveConversationWidth),
  );
  const fallbackCommitSha = project.branches.find((branch) =>
    activeRun?.branchId === undefined || activeRun.branchId === null
      ? branch.name === project.repository?.defaultBranch
      : branch.id === activeRun.branchId,
  )?.headCommitSha;

  return (
    <>
      <BuilderStyles />
      <AppShell
        activePath={`/projects/${projectId}`}
        invalidOrganization={false}
        onSignOut={() => session.signOut(organizationId)}
        onSwitchOrganization={session.switchOrganization}
        recentProjects={[{ id: projectId, name: project.project.name }]}
        session={readySession}
      >
      <div className="zapp-builder-shell">
        <TopBar
          deploy={<BuilderDeploy organizationId={organizationId} projectId={projectId} />}
          missionControl={missionControl}
          projectId={projectId}
          projectName={project.project.name}
          supportLevel={project.project.supportLevel}
          syncState="unavailable"
        />
        {readySession.invalidOrganization ? (
          <p className="zapp-builder-notice" role="status">
            Invalid organization selection. Showing your active organization.
          </p>
        ) : null}
        {failedPreferenceKeys.size > 0 ? (
          <p className="zapp-builder-notice" role="status">
            Preferences could not be saved.
          </p>
        ) : null}
        <IncidentBanner
          onRunCreated={setActiveRun}
          organizationId={organizationId}
          projectId={projectId}
        />
        <div
          className="zapp-builder-workspace"
          data-inline-mission={inlineMissionControl && missionControlOpen ? 'open' : 'closed'}
          data-testid="builder-workspace"
        >
          <div className="zapp-builder-split" ref={splitRef} style={splitStyle}>
            <section
              aria-label="Conversation"
              className="zapp-builder-pane"
              data-mobile-active={navigation.pane === 'conversation' ? 'true' : 'false'}
              id="conversation-pane"
            >
              <Thread
                {...(activeRun === undefined ? {} : { adoptedRun: activeRun })}
                allowedModels={allowedModels}
                branches={project.branches}
                incomingImages={previewAttachments}
                {...(firstPrompt === undefined ? {} : { initialPrompt: firstPrompt })}
                onOpenCommit={openCommit}
                onRunChange={setActiveRun}
                organizationId={organizationId}
                projectId={projectId}
              />
            </section>
            <div
              aria-controls="conversation-pane surface-pane"
              aria-label="Resize conversation pane"
              aria-orientation="vertical"
              aria-valuemax={maximumConversationWidth}
              aria-valuemin={announcedConversationMinimum}
              aria-valuenow={announcedConversationWidth}
              aria-valuetext={`${String(announcedConversationWidth)}% conversation`}
              className="zapp-builder-separator"
              onKeyDown={resizeWithKeyboard}
              onPointerDown={beginResize}
              role="separator"
              tabIndex={0}
            >
              <span aria-hidden="true" className="zapp-builder-separator-handle" />
            </div>
            <section
              aria-label="Workspace"
              className="zapp-builder-pane"
              data-mobile-active={navigation.pane === 'workspace' ? 'true' : 'false'}
              id="surface-pane"
            >
              <WorkingSurface
                {...(fallbackCommitSha === undefined || fallbackCommitSha === null
                  ? {}
                  : { fallbackCommitSha })}
                focusPreviewRequest={focusPreviewRequest}
                onAttachPreviewCapture={(file, capture) => {
                  const id = crypto.randomUUID();
                  return new Promise<boolean>((resolve) => {
                    setPreviewAttachments((current) => [
                      ...current,
                      {
                        capture,
                        file,
                        id,
                        onConsumed(accepted) {
                          setPreviewAttachments((pending) =>
                            pending.filter((candidate) => candidate.id !== id),
                          );
                          if (accepted) {
                            selectPane('conversation');
                          }
                          resolve(accepted);
                        },
                      },
                    ]);
                  });
                }}
                onAttachPreviewSelection={(file, selection: SelectedPreviewElement) => {
                  const id = crypto.randomUUID();
                  return new Promise<boolean>((resolve) => {
                    setPreviewAttachments((current) => [
                      ...current,
                      {
                        file,
                        id,
                        onConsumed(accepted) {
                          setPreviewAttachments((pending) =>
                            pending.filter((candidate) => candidate.id !== id),
                          );
                          if (accepted) selectPane('conversation');
                          resolve(accepted);
                        },
                        selection,
                      },
                    ]);
                  });
                }}
                onRunCreated={setActiveRun}
                manageSection={navigation.manage}
                mode={navigation.mode}
                onManageSectionChange={selectManageSection}
                onModeChange={selectMode}
                onValueChange={(preview) => {
                  setNavigation((current) => ({ ...current, preview }));
                }}
                organizationId={organizationId}
                projectId={projectId}
                {...(activeRun === undefined ? {} : { runId: activeRun.id })}
                value={navigation.preview}
              />
            </section>
          </div>
          {inlineMissionControl && missionControlOpen ? (
            <aside aria-label="Mission Control" className="zapp-builder-mission-control">
              <div className="zapp-builder-mission-control-header">
                <h2>Mission Control</h2>
                <Button onClick={closeInlineMissionControl} variant="ghost">
                  Close
                </Button>
              </div>
              {activeRun === undefined ? <MissionControlEmpty /> : <MissionControlPanel organizationId={organizationId} runId={activeRun.id} onOpenPreview={previewSurface} onCompare={openCommit} />}
            </aside>
          ) : null}
        </div>
        <nav aria-label="Builder pane" className="zapp-builder-mobile-switcher">
          <Button
            aria-pressed={navigation.pane === 'conversation'}
            onClick={() => {
              selectPane('conversation');
            }}
            variant={navigation.pane === 'conversation' ? 'primary' : 'ghost'}
          >
            Conversation
          </Button>
          <Button
            aria-pressed={navigation.pane === 'workspace'}
            onClick={() => {
              selectPane('workspace');
            }}
            variant={navigation.pane === 'workspace' ? 'primary' : 'ghost'}
          >
            Workspace
          </Button>
        </nav>
      </div>
      </AppShell>
    </>
  );
}
