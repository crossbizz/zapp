'use client';

import { ZappApiError } from '@zapp/api-client';
import { Button, EmptyState } from '@zapp/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { useAppSession, type ReadyAppSession } from '../../hooks/useAppSession';
import { createControlPlaneClient, type ProjectDeletionData } from '../../lib/api';
import { appSessionStorageKey } from '../../lib/app-session';
import { AppShell } from '../shell/AppShell';
import styles from './projects.module.css';
import { GitHubImportDialog, type GitHubInstallCallback } from './GitHubImportDialog';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { NewProjectLink } from './NewProjectLink';
import { ProjectCard, type ProjectDeletionState } from './ProjectCard';
import { decodeThumbnail, revokeThumbnail } from './project-thumbnail';

type ProjectPage = Awaited<ReturnType<ReturnType<typeof createControlPlaneClient>['listProjects']>>;
type Project = ProjectPage['items'][number];
type ProjectSummaryPage = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getProjectSummaries']>
>;
type ProjectSummary = ProjectSummaryPage['summaries'][number];

const PAGE_SIZE = 24;
const DELETION_POLL_DELAYS_MS = [500, 1_000, 2_000] as const;
const MAX_DELETION_POLLS = 30;

interface DeletionDialogTarget {
  readonly project: Project;
  readonly returnFocusElement: HTMLButtonElement;
}

interface DeletionPollInput {
  readonly attempt: number;
  readonly generation: number;
  readonly operationKey: string;
  readonly organizationId: string;
  readonly projectId: string;
}

interface RetryFailureProps {
  readonly description: string;
  readonly onRetry: () => void;
  readonly title: string;
}

function RetryFailure({ description, onRetry, title }: RetryFailureProps): ReactElement {
  return (
    <section className={`${styles.failure ?? ''} zapp-state zapp-error-state`} role="alert">
      <h2 className="zapp-state__title">{title}</h2>
      <p className="zapp-state__description">{description}</p>
      <Button onClick={onRetry} variant="secondary">
        Retry
      </Button>
    </section>
  );
}

export function ProjectsDashboard(): ReactElement {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAppSession();
  const [organizationId, setOrganizationId] = useState<string>();
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>();
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [projectsAttempt, setProjectsAttempt] = useState(0);
  const [githubImportOpen, setGitHubImportOpen] = useState(false);
  const [githubCallback, setGitHubCallback] = useState<GitHubInstallCallback>();
  const processedImportSearchRef = useRef<string | undefined>(undefined);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, ProjectSummary>>(new Map());
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [summaryFailedIds, setSummaryFailedIds] = useState<ReadonlySet<string>>(new Set());
  const [summaryLoadingIds, setSummaryLoadingIds] = useState<ReadonlySet<string>>(new Set());
  const [deletions, setDeletions] = useState<ReadonlyMap<string, ProjectDeletionState>>(new Map());
  const [deletionDialogTarget, setDeletionDialogTarget] = useState<DeletionDialogTarget>();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const activeOrganizationRef = useRef(organizationId);
  const requestGenerationRef = useRef(0);
  const paginationAbortRef = useRef<AbortController | undefined>(undefined);
  const summaryAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const thumbnailUrlsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const deletionControllersRef = useRef<Map<string, AbortController>>(new Map());
  const deletionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pollDeletionRef = useRef<(input: DeletionPollInput) => void>(() => undefined);

  activeOrganizationRef.current = organizationId;

  const clearThumbnailUrls = useCallback((): void => {
    for (const url of thumbnailUrlsRef.current.values()) revokeThumbnail(url);
    thumbnailUrlsRef.current = new Map();
    setThumbnailUrls(new Map());
  }, []);

  const replaceThumbnailUrl = useCallback((projectId: string, url: string): void => {
    const previous = thumbnailUrlsRef.current.get(projectId);
    if (previous !== undefined) revokeThumbnail(previous);
    const next = new Map(thumbnailUrlsRef.current).set(projectId, url);
    thumbnailUrlsRef.current = next;
    setThumbnailUrls(next);
  }, []);

  const removeThumbnailUrl = useCallback((projectId: string): void => {
    const previous = thumbnailUrlsRef.current.get(projectId);
    if (previous !== undefined) revokeThumbnail(previous);
    const next = new Map(thumbnailUrlsRef.current);
    next.delete(projectId);
    thumbnailUrlsRef.current = next;
    setThumbnailUrls(next);
  }, []);

  const stopDeletionOperation = useCallback((projectId: string): void => {
    deletionControllersRef.current.get(projectId)?.abort();
    deletionControllersRef.current.delete(projectId);
    const timer = deletionTimersRef.current.get(projectId);
    if (timer !== undefined) clearTimeout(timer);
    deletionTimersRef.current.delete(projectId);
  }, []);

  const clearDeletionOperations = useCallback((): void => {
    for (const controller of deletionControllersRef.current.values()) controller.abort();
    deletionControllersRef.current.clear();
    for (const timer of deletionTimersRef.current.values()) clearTimeout(timer);
    deletionTimersRef.current.clear();
    setDeletions(new Map());
    setDeletionDialogTarget(undefined);
  }, []);

  useEffect(() => {
    if (session.snapshot.status !== 'ready') return;
    const selectedId = session.snapshot.membership.organization.id;
    activeOrganizationRef.current = selectedId;
    setOrganizationId((current) => current ?? selectedId);
  }, [session.snapshot]);

  useEffect(() => {
    clearDeletionOperations();
    return () => {
      for (const controller of deletionControllersRef.current.values()) controller.abort();
      deletionControllersRef.current.clear();
      for (const timer of deletionTimersRef.current.values()) clearTimeout(timer);
      deletionTimersRef.current.clear();
    };
  }, [clearDeletionOperations, organizationId]);

  const clearGitHubCallback = useCallback((): void => {
    setGitHubCallback(undefined);
  }, []);

  useEffect(() => {
    const rawSearch = window.location.search;
    const search = new URLSearchParams(rawSearch);
    if (search.get('import') !== 'github') {
      processedImportSearchRef.current = undefined;
      return;
    }
    if (processedImportSearchRef.current === rawSearch) return;
    processedImportSearchRef.current = rawSearch;
    const installationId = search.get('installation_id');
    const state = search.get('state');
    const code = search.get('code');
    setGitHubCallback(
      installationId === null || state === null || code === null
        ? undefined
        : { code, installationId, state },
    );
    setGitHubImportOpen(true);
    search.delete('import');
    search.delete('installation_id');
    search.delete('setup_action');
    search.delete('state');
    search.delete('code');
    const query = search.toString();
    router.replace(query.length === 0 ? pathname : `${pathname}?${query}`, { scroll: false });
  });

  const loadSummaries = useCallback(
    async (
      projectIds: readonly string[],
      requestedOrganization: string,
      generation: number,
    ): Promise<void> => {
      if (
        projectIds.length === 0 ||
        requestGenerationRef.current !== generation ||
        activeOrganizationRef.current !== requestedOrganization
      ) {
        return;
      }
      const controller = new AbortController();
      summaryAbortControllersRef.current.add(controller);
      const isCurrent = (): boolean =>
        !controller.signal.aborted &&
        requestGenerationRef.current === generation &&
        activeOrganizationRef.current === requestedOrganization;

      if (!isCurrent()) return;
      setSummaryFailedIds((current) => {
        const next = new Set(current);
        for (const projectId of projectIds) next.delete(projectId);
        return next;
      });
      if (!isCurrent()) return;
      setSummaryLoadingIds((current) => new Set([...current, ...projectIds]));

      try {
        const response = await createControlPlaneClient(requestedOrganization).getProjectSummaries(
          { projectId: [...projectIds] },
          controller.signal,
        );
        if (!isCurrent()) return;
        setSummaries((current) => {
          const next = new Map(current);
          for (const summary of response.summaries) next.set(summary.projectId, summary);
          return next;
        });
        const pending = response.summaries.filter((summary) => summary.previewThumbnail !== null);
        let nextThumbnail = 0;
        const loadThumbnail = async (): Promise<void> => {
          while (isCurrent()) {
            const summary = pending[nextThumbnail];
            nextThumbnail += 1;
            if (summary === undefined || summary.previewThumbnail === null) return;
            try {
              const thumbnail = await createControlPlaneClient(
                requestedOrganization,
              ).getProjectPreviewThumbnail(
                summary.projectId,
                summary.previewThumbnail.artifactId,
                controller.signal,
              );
              const url = URL.createObjectURL(decodeThumbnail(thumbnail));
              if (!isCurrent()) {
                revokeThumbnail(url);
                return;
              }
              replaceThumbnailUrl(summary.projectId, url);
            } catch {
              if (!isCurrent()) return;
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(6, pending.length) }, () => loadThumbnail()),
        );
      } catch {
        if (!isCurrent()) return;
        setSummaryFailedIds((current) => new Set([...current, ...projectIds]));
      } finally {
        summaryAbortControllersRef.current.delete(controller);
        if (isCurrent()) {
          setSummaryLoadingIds((current) => {
            const next = new Set(current);
            for (const projectId of projectIds) next.delete(projectId);
            return next;
          });
        }
      }
    },
    [replaceThumbnailUrl],
  );

  useEffect(() => {
    if (organizationId === undefined) return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = undefined;
    for (const summaryController of summaryAbortControllersRef.current) summaryController.abort();
    summaryAbortControllersRef.current.clear();
    const controller = new AbortController();
    let current = true;

    const loadProjects = async (): Promise<void> => {
      setProjects([]);
      setSummaries(new Map());
      clearThumbnailUrls();
      setSummaryFailedIds(new Set());
      setSummaryLoadingIds(new Set());
      setNextCursor(undefined);
      setProjectsFailed(false);
      setProjectsLoading(true);
      loadingMoreRef.current = false;
      setLoadingMore(false);
      try {
        const page = await createControlPlaneClient(organizationId).listProjects(
          { limit: PAGE_SIZE },
          controller.signal,
        );
        if (current && !controller.signal.aborted && requestGenerationRef.current === generation) {
          setProjects(page.items);
          setNextCursor(page.nextCursor);
          void loadSummaries(
            page.items.map((item) => item.id),
            organizationId,
            generation,
          );
        }
      } catch {
        if (current && !controller.signal.aborted && requestGenerationRef.current === generation) {
          setProjectsFailed(true);
        }
      } finally {
        if (current && !controller.signal.aborted && requestGenerationRef.current === generation) {
          setProjectsLoading(false);
        }
      }
    };

    void loadProjects();
    return () => {
      current = false;
      controller.abort();
      paginationAbortRef.current?.abort();
      for (const summaryController of summaryAbortControllersRef.current) summaryController.abort();
      summaryAbortControllersRef.current.clear();
      clearThumbnailUrls();
    };
  }, [clearThumbnailUrls, loadSummaries, organizationId, projectsAttempt]);

  const loadNextPage = useCallback(async (): Promise<void> => {
    if (
      organizationId === undefined ||
      nextCursor === undefined ||
      nextCursor === null ||
      loadingMoreRef.current
    ) {
      return;
    }
    const requestedOrganization = organizationId;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = controller;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await createControlPlaneClient(requestedOrganization).listProjects(
        {
          cursor: nextCursor,
          limit: PAGE_SIZE,
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        requestGenerationRef.current !== generation ||
        activeOrganizationRef.current !== requestedOrganization
      ) {
        return;
      }
      setProjects((current) => {
        const existing = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !existing.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      void loadSummaries(
        page.items.map((item) => item.id),
        requestedOrganization,
        generation,
      );
    } catch {
      if (
        !controller.signal.aborted &&
        requestGenerationRef.current === generation &&
        activeOrganizationRef.current === requestedOrganization
      ) {
        setProjectsFailed(true);
      }
    } finally {
      if (
        !controller.signal.aborted &&
        requestGenerationRef.current === generation &&
        paginationAbortRef.current === controller
      ) {
        paginationAbortRef.current = undefined;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [loadSummaries, nextCursor, organizationId]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null || nextCursor === undefined || nextCursor === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNextPage();
    });
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [loadNextPage, nextCursor]);

  const removeDeletedProject = useCallback(
    (projectId: string): void => {
      stopDeletionOperation(projectId);
      removeThumbnailUrl(projectId);
      setProjects((current) => current.filter((item) => item.id !== projectId));
      setSummaries((current) => {
        const next = new Map(current);
        next.delete(projectId);
        return next;
      });
      setSummaryFailedIds((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
      setSummaryLoadingIds((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
      setDeletions((current) => {
        const next = new Map(current);
        next.delete(projectId);
        return next;
      });
      setDeletionDialogTarget((current) =>
        current?.project.id === projectId ? undefined : current,
      );
    },
    [removeThumbnailUrl, stopDeletionOperation],
  );

  const deletionScopeIsCurrent = useCallback(
    (requestedOrganization: string, generation: number): boolean =>
      activeOrganizationRef.current === requestedOrganization &&
      requestGenerationRef.current === generation,
    [],
  );

  const scheduleDeletionPoll = useCallback(
    (input: DeletionPollInput): void => {
      if (!deletionScopeIsCurrent(input.organizationId, input.generation)) return;
      const previous = deletionTimersRef.current.get(input.projectId);
      if (previous !== undefined) clearTimeout(previous);
      const delay =
        DELETION_POLL_DELAYS_MS[Math.min(input.attempt, DELETION_POLL_DELAYS_MS.length - 1)] ??
        DELETION_POLL_DELAYS_MS[DELETION_POLL_DELAYS_MS.length - 1];
      const timer = setTimeout(() => {
        if (deletionTimersRef.current.get(input.projectId) !== timer) return;
        deletionTimersRef.current.delete(input.projectId);
        pollDeletionRef.current(input);
      }, delay);
      deletionTimersRef.current.set(input.projectId, timer);
    },
    [deletionScopeIsCurrent],
  );

  const projectIsOmittedFromFreshList = useCallback(
    async (
      projectId: string,
      requestedOrganization: string,
      generation: number,
      signal: AbortSignal,
    ): Promise<boolean> => {
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await createControlPlaneClient(requestedOrganization).listProjects(
          {
            ...(cursor === undefined ? {} : { cursor }),
            limit: 100,
          },
          signal,
        );
        if (
          signal.aborted ||
          !deletionScopeIsCurrent(requestedOrganization, generation) ||
          page.items.some((item) => item.id === projectId)
        ) {
          return false;
        }
        if (page.nextCursor === null) return true;
        cursor = page.nextCursor;
      }
      return false;
    },
    [deletionScopeIsCurrent],
  );

  const applyDeletionStatus = useCallback(
    (
      deletion: ProjectDeletionData,
      input: Omit<DeletionPollInput, 'attempt'>,
      nextAttempt: number,
    ): void => {
      if (!deletionScopeIsCurrent(input.organizationId, input.generation)) return;
      if (deletion.status === 'completed') {
        removeDeletedProject(input.projectId);
        return;
      }
      if (deletion.status === 'failed') {
        setDeletions((current) =>
          new Map(current).set(input.projectId, {
            message: 'The deletion worker reported a failure.',
            operationKey: input.operationKey,
            retryUsesSameKey: false,
            status: 'failed',
          }),
        );
        scheduleDeletionPoll({ ...input, attempt: nextAttempt });
        return;
      }
      setDeletions((current) =>
        new Map(current).set(input.projectId, {
          operationKey: input.operationKey,
          status: deletion.status === 'running' ? 'running' : 'queued',
        }),
      );
      scheduleDeletionPoll({ ...input, attempt: nextAttempt });
    },
    [deletionScopeIsCurrent, removeDeletedProject, scheduleDeletionPoll],
  );

  const pollDeletion = useCallback(
    async (input: DeletionPollInput): Promise<void> => {
      if (!deletionScopeIsCurrent(input.organizationId, input.generation)) return;
      if (input.attempt >= MAX_DELETION_POLLS) {
        setDeletions((current) =>
          new Map(current).set(input.projectId, {
            message: 'Deletion status timed out. Retry to reconcile the existing request.',
            operationKey: input.operationKey,
            status: 'reconciling',
          }),
        );
        return;
      }

      const controller = new AbortController();
      deletionControllersRef.current.set(input.projectId, controller);
      try {
        const response = await createControlPlaneClient(input.organizationId).getProjectDeletion(
          input.projectId,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          deletionControllersRef.current.get(input.projectId) !== controller ||
          !deletionScopeIsCurrent(input.organizationId, input.generation)
        ) {
          return;
        }
        deletionControllersRef.current.delete(input.projectId);
        applyDeletionStatus(response.deletion, input, input.attempt + 1);
      } catch (error) {
        if (
          controller.signal.aborted ||
          deletionControllersRef.current.get(input.projectId) !== controller ||
          !deletionScopeIsCurrent(input.organizationId, input.generation)
        ) {
          return;
        }
        if (error instanceof ZappApiError && error.status === 404) {
          const omitted = await projectIsOmittedFromFreshList(
            input.projectId,
            input.organizationId,
            input.generation,
            controller.signal,
          ).catch(() => false);
          if (omitted && deletionScopeIsCurrent(input.organizationId, input.generation)) {
            removeDeletedProject(input.projectId);
            return;
          }
        }
        if (deletionControllersRef.current.get(input.projectId) !== controller) return;
        deletionControllersRef.current.delete(input.projectId);
        scheduleDeletionPoll({ ...input, attempt: input.attempt + 1 });
      }
    },
    [
      applyDeletionStatus,
      deletionScopeIsCurrent,
      projectIsOmittedFromFreshList,
      removeDeletedProject,
      scheduleDeletionPoll,
    ],
  );

  pollDeletionRef.current = (input): void => {
    void pollDeletion(input);
  };

  const requestProjectDeletion = useCallback(
    async (
      project: Project,
      operationKey: string,
      reconciliationKey = operationKey,
    ): Promise<void> => {
      const requestedOrganization = project.organizationId;
      const generation = requestGenerationRef.current;
      stopDeletionOperation(project.id);
      const controller = new AbortController();
      deletionControllersRef.current.set(project.id, controller);
      setDeletions((current) =>
        new Map(current).set(project.id, { operationKey, status: 'requesting' }),
      );
      try {
        const response = await createControlPlaneClient(requestedOrganization).deleteProject(
          project.id,
          operationKey,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          deletionControllersRef.current.get(project.id) !== controller ||
          !deletionScopeIsCurrent(requestedOrganization, generation)
        ) {
          return;
        }
        deletionControllersRef.current.delete(project.id);
        applyDeletionStatus(
          response.deletion,
          {
            generation,
            operationKey,
            organizationId: requestedOrganization,
            projectId: project.id,
          },
          0,
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          deletionControllersRef.current.get(project.id) !== controller ||
          !deletionScopeIsCurrent(requestedOrganization, generation)
        ) {
          return;
        }
        deletionControllersRef.current.delete(project.id);
        if (error instanceof ZappApiError && error.status === 409) {
          setDeletions((current) =>
            new Map(current).set(project.id, {
              operationKey: reconciliationKey,
              status: 'queued',
            }),
          );
          scheduleDeletionPoll({
            attempt: 0,
            generation,
            operationKey: reconciliationKey,
            organizationId: requestedOrganization,
            projectId: project.id,
          });
          return;
        }
        setDeletions((current) =>
          new Map(current).set(project.id, {
            message: 'The request outcome could not be confirmed.',
            operationKey,
            status: 'reconciling',
          }),
        );
      }
    },
    [applyDeletionStatus, deletionScopeIsCurrent, scheduleDeletionPoll, stopDeletionOperation],
  );

  const beginDelete = useCallback(
    (project: Project, returnFocusElement: HTMLButtonElement): void => {
      setDeletionDialogTarget({ project, returnFocusElement });
      setDeletions((current) => new Map(current).set(project.id, { status: 'confirming' }));
    },
    [],
  );

  const cancelDelete = useCallback((): void => {
    const projectId = deletionDialogTarget?.project.id;
    if (projectId === undefined) return;
    setDeletions((current) => {
      const next = new Map(current);
      if (next.get(projectId)?.status === 'confirming') next.delete(projectId);
      return next;
    });
  }, [deletionDialogTarget]);

  const confirmDelete = useCallback((): void => {
    const project = deletionDialogTarget?.project;
    if (project === undefined) return;
    void requestProjectDeletion(project, crypto.randomUUID());
  }, [deletionDialogTarget, requestProjectDeletion]);

  const retryDelete = useCallback(
    (project: Project): void => {
      const state = deletions.get(project.id);
      if (state?.status !== 'failed' && state?.status !== 'reconciling') return;
      void requestProjectDeletion(
        project,
        state.status === 'reconciling' || state.retryUsesSameKey
          ? state.operationKey
          : crypto.randomUUID(),
        state.operationKey,
      );
    },
    [deletions, requestProjectDeletion],
  );

  if (session.snapshot.status === 'error') {
    return (
      <main className={styles.dashboard}>
        <RetryFailure
          description="The public session profile request did not complete."
          onRetry={session.retry}
          title="We could not load your organizations."
        />
      </main>
    );
  }

  if (session.snapshot.status === 'loading') {
    return (
      <main className={styles.dashboard}>
        <p aria-live="polite" className={styles.loading} role="status">
          Loading projects…
        </p>
      </main>
    );
  }

  if (session.snapshot.status === 'empty') {
    return (
      <main className={styles.dashboard}>
        <h1>Projects</h1>
        <p>No active organization.</p>
      </main>
    );
  }

  const readySession = session.snapshot;
  const memberships = readySession.memberships;

  if (organizationId === undefined) {
    return (
      <main className={styles.dashboard}>
        <h1>Projects</h1>
        <p>No active organization.</p>
      </main>
    );
  }

  const selectedMembership = memberships.find((membership) => {
    return membership.organization.id === organizationId;
  });
  if (selectedMembership === undefined) {
    return <main className={styles.dashboard}>Loading projects…</main>;
  }
  const shellSession: ReadyAppSession = {
    ...readySession,
    membership: selectedMembership,
  };

  const switchOrganization = (selectedId: string): void => {
    localStorage.setItem(appSessionStorageKey(readySession.profile.user.id), selectedId);
    requestGenerationRef.current += 1;
    clearDeletionOperations();
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = undefined;
    for (const summaryController of summaryAbortControllersRef.current) summaryController.abort();
    summaryAbortControllersRef.current.clear();
    activeOrganizationRef.current = selectedId;
    setGitHubCallback(undefined);
    loadingMoreRef.current = false;
    setProjects([]);
    setSummaries(new Map());
    clearThumbnailUrls();
    setSummaryFailedIds(new Set());
    setSummaryLoadingIds(new Set());
    setNextCursor(undefined);
    setProjectsFailed(false);
    setProjectsLoading(true);
    setOrganizationId(selectedId);
    const nextSearchParams = new URLSearchParams(window.location.search);
    nextSearchParams.delete('organizationId');
    const query = nextSearchParams.toString();
    router.replace(query.length === 0 ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  return (
    <AppShell
      activePath="/projects"
      invalidOrganization={readySession.invalidOrganization}
      onSignOut={() => session.signOut(organizationId)}
      onSwitchOrganization={switchOrganization}
      recentProjects={projects}
      session={shellSession}
    >
      <div className={styles.dashboard}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Workspace</p>
            <h1>Projects</h1>
          </div>
          <div className={styles.headerActions}>
            <Link className={styles.templateLink} href="/templates">
              Browse templates
            </Link>
            <GitHubImportDialog
              callback={githubCallback}
              onCallbackConsumed={clearGitHubCallback}
              onOpenChange={setGitHubImportOpen}
              open={githubImportOpen}
              organizationId={organizationId}
            />
            <NewProjectLink />
          </div>
        </header>

        {projectsFailed ? (
          <RetryFailure
            description="The tenant-scoped project list request did not complete."
            onRetry={() => {
              setProjectsAttempt((value) => value + 1);
            }}
            title="We could not load projects."
          />
        ) : projectsLoading ? (
          <p aria-live="polite" className={styles.loading} role="status">
            Loading projects…
          </p>
        ) : projects.length === 0 && nextCursor === null ? (
          <EmptyState
            className={styles.emptyState}
            description="Start from a prompt and zapp will create the project and its first build."
            title="No projects yet"
          >
            <NewProjectLink />
          </EmptyState>
        ) : (
          <section aria-label="Projects" className={styles.grid}>
            {projects.map((projectItem) => (
              <ProjectCard
                canDelete={selectedMembership.role === 'owner'}
                deletionState={deletions.get(projectItem.id) ?? { status: 'idle' }}
                key={projectItem.id}
                loadingSummary={summaryLoadingIds.has(projectItem.id)}
                onDelete={(returnFocusElement) => {
                  beginDelete(projectItem, returnFocusElement);
                }}
                onRetryDelete={() => {
                  retryDelete(projectItem);
                }}
                onRetrySummary={() => {
                  void loadSummaries(
                    [projectItem.id],
                    organizationId,
                    requestGenerationRef.current,
                  );
                }}
                project={projectItem}
                summary={summaries.get(projectItem.id)}
                summaryFailed={summaryFailedIds.has(projectItem.id)}
                thumbnailUrl={thumbnailUrls.get(projectItem.id)}
              />
            ))}
          </section>
        )}
        {deletionDialogTarget === undefined ? null : (
          <DeleteProjectDialog
            busy={deletions.get(deletionDialogTarget.project.id)?.status === 'requesting'}
            onCancel={cancelDelete}
            onConfirm={confirmDelete}
            open={deletions.get(deletionDialogTarget.project.id)?.status === 'confirming'}
            projectName={deletionDialogTarget.project.name}
            returnFocusElement={deletionDialogTarget.returnFocusElement}
          />
        )}
        {nextCursor === undefined || nextCursor === null ? null : (
          <div aria-hidden="true" className={styles.sentinel} ref={sentinelRef} />
        )}
        {loadingMore ? (
          <p aria-live="polite" className={styles.paginationStatus} role="status">
            Loading more projects…
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}
