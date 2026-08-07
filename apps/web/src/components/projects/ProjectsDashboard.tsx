'use client';

import { ZappApiError } from '@zapp/api-client';
import { Button, Card, EmptyState, SupportLevelBadge } from '@zapp/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type MeResponse } from '../../lib/api';
import { activeMemberships, organizationStorageKey, resolveOrganization } from '../../lib/session';
import styles from './projects.module.css';
import { NewProjectDialog } from './NewProjectDialog';

type ProjectPage = Awaited<ReturnType<ReturnType<typeof createControlPlaneClient>['listProjects']>>;
type Project = ProjectPage['items'][number];

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
  const [profile, setProfile] = useState<MeResponse>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>();
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [projectsAttempt, setProjectsAttempt] = useState(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const activeOrganizationRef = useRef(organizationId);
  const requestGenerationRef = useRef(0);
  const paginationAbortRef = useRef<AbortController | undefined>(undefined);

  activeOrganizationRef.current = organizationId;

  useEffect(() => {
    let current = true;

    const loadSession = async (): Promise<void> => {
      setSessionFailed(false);
      try {
        const me = await createControlPlaneClient().getMe();
        if (!current) return;
        const override = new URLSearchParams(window.location.search).get('organizationId');
        const selected = resolveOrganization(
          me.memberships,
          override,
          localStorage.getItem(organizationStorageKey(me.user.id)),
        );
        setProfile(me);
        activeOrganizationRef.current = selected.membership?.organization.id;
        setOrganizationId(selected.membership?.organization.id);
        if (selected.membership !== undefined) {
          localStorage.setItem(
            organizationStorageKey(me.user.id),
            selected.membership.organization.id,
          );
        }
      } catch (error) {
        if (error instanceof ZappApiError && error.status === 401) {
          window.location.replace('/login');
          return;
        }
        if (current) setSessionFailed(true);
      }
    };

    void loadSession();
    return () => {
      current = false;
    };
  }, [sessionAttempt]);

  useEffect(() => {
    if (organizationId === undefined) return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = undefined;
    const controller = new AbortController();
    let current = true;

    const loadProjects = async (): Promise<void> => {
      setProjects([]);
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
    };
  }, [organizationId, projectsAttempt]);

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
  }, [nextCursor, organizationId]);

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

  if (sessionFailed) {
    return (
      <main className={styles.dashboard}>
        <RetryFailure
          description="The public session profile request did not complete."
          onRetry={() => {
            setSessionAttempt((value) => value + 1);
          }}
          title="We could not load your organizations."
        />
      </main>
    );
  }

  if (profile === undefined) {
    return (
      <main className={styles.dashboard}>
        <p aria-live="polite" className={styles.loading} role="status">
          Loading projects…
        </p>
      </main>
    );
  }

  const memberships = activeMemberships(profile.memberships);

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
  const allowedModels = selectedMembership?.allowedModels ?? [];

  return (
    <main className={styles.dashboard}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Workspace</p>
          <h1>Projects</h1>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.organizationPicker}>
            <span>Organization</span>
            <select
              aria-label="Organization"
              onChange={(event) => {
                const selectedId = event.target.value;
                localStorage.setItem(organizationStorageKey(profile.user.id), selectedId);
                requestGenerationRef.current += 1;
                paginationAbortRef.current?.abort();
                paginationAbortRef.current = undefined;
                activeOrganizationRef.current = selectedId;
                loadingMoreRef.current = false;
                setProjects([]);
                setNextCursor(undefined);
                setProjectsFailed(false);
                setProjectsLoading(true);
                setOrganizationId(selectedId);
                const nextSearchParams = new URLSearchParams(window.location.search);
                nextSearchParams.delete('organizationId');
                const query = nextSearchParams.toString();
                router.replace(query.length === 0 ? pathname : `${pathname}?${query}`, {
                  scroll: false,
                });
              }}
              value={organizationId}
            >
              {memberships.map((membership) => (
                <option key={membership.organization.id} value={membership.organization.id}>
                  {membership.organization.name}
                </option>
              ))}
            </select>
          </label>
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
            <Card as="article" className={styles.projectCard} key={projectItem.id}>
              <h2>{projectItem.name}</h2>
              <SupportLevelBadge level={projectItem.supportLevel} />
              <Link
                aria-label={`Open ${projectItem.name}`}
                className={styles.openLink}
                href={`/projects/${encodeURIComponent(projectItem.id)}`}
              >
                Open
              </Link>
            </Card>
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
    </main>
  );
}
