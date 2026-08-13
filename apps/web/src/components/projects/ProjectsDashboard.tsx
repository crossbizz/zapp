'use client';

import { Button, EmptyState } from '@zapp/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { useAppSession, type ReadyAppSession } from '../../hooks/useAppSession';
import { createControlPlaneClient } from '../../lib/api';
import { appSessionStorageKey } from '../../lib/app-session';
import { AppShell } from '../shell/AppShell';
import styles from './projects.module.css';
import {
  GitHubImportDialog,
  type GitHubInstallCallback,
} from './GitHubImportDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { ProjectCard } from './ProjectCard';
import { decodeThumbnail, revokeThumbnail } from './project-thumbnail';

type ProjectPage = Awaited<ReturnType<ReturnType<typeof createControlPlaneClient>['listProjects']>>;
type Project = ProjectPage['items'][number];
type ProjectSummaryPage = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getProjectSummaries']>
>;
type ProjectSummary = ProjectSummaryPage['summaries'][number];

const PAGE_SIZE = 24;

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
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const activeOrganizationRef = useRef(organizationId);
  const requestGenerationRef = useRef(0);
  const paginationAbortRef = useRef<AbortController | undefined>(undefined);
  const summaryAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const thumbnailUrlsRef = useRef<ReadonlyMap<string, string>>(new Map());

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

  useEffect(() => {
    if (session.snapshot.status !== 'ready') return;
    const selectedId = session.snapshot.membership.organization.id;
    activeOrganizationRef.current = selectedId;
    setOrganizationId((current) => current ?? selectedId);
  }, [session.snapshot]);

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
  const allowedModels = selectedMembership.allowedModels;
  const shellSession: ReadyAppSession = {
    ...readySession,
    membership: selectedMembership,
  };

  const switchOrganization = (selectedId: string): void => {
    localStorage.setItem(appSessionStorageKey(readySession.profile.user.id), selectedId);
    requestGenerationRef.current += 1;
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
          <Link className={styles.templateLink} href="/templates">Browse templates</Link>
          <GitHubImportDialog
            callback={githubCallback}
            onCallbackConsumed={clearGitHubCallback}
            onOpenChange={setGitHubImportOpen}
            open={githubImportOpen}
            organizationId={organizationId}
          />
          <NewProjectDialog allowedModels={allowedModels} organizationId={organizationId} />
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
          <NewProjectDialog allowedModels={allowedModels} organizationId={organizationId} />
        </EmptyState>
      ) : (
        <section aria-label="Projects" className={styles.grid}>
          {projects.map((projectItem) => (
            <ProjectCard
              key={projectItem.id}
              loadingSummary={summaryLoadingIds.has(projectItem.id)}
              onRetrySummary={() => {
                void loadSummaries([projectItem.id], organizationId, requestGenerationRef.current);
              }}
              project={projectItem}
              summary={summaries.get(projectItem.id)}
              summaryFailed={summaryFailedIds.has(projectItem.id)}
              thumbnailUrl={thumbnailUrls.get(projectItem.id)}
            />
          ))}
        </section>
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
