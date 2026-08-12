'use client';

import { Button, Dialog } from '@zapp/ui';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';

import { createControlPlaneClient } from '../../lib/api';
import { captureProjectCreated } from '../../lib/activation';
import styles from './projects.module.css';

type Client = ReturnType<typeof createControlPlaneClient>;
type RepositoryPage = Awaited<ReturnType<Client['listGitHubRepositories']>>;
type Repository = RepositoryPage['items'][number];
type BranchPage = Awaited<ReturnType<Client['listGitHubBranches']>>;
type Branch = BranchPage['items'][number];
type ImportStatus = Awaited<ReturnType<Client['getGitHubImport']>>;
type DurableStatus = ImportStatus['status'];
type FailureCode = NonNullable<ImportStatus['errorCode']> | 'request_failed';

const statusLabels = {
  failed: 'Failed',
  mirroring: 'Mirroring',
  queued: 'Queued',
  scan_accepted: 'Scan accepted',
  scan_pending: 'Scan pending',
  submitting: 'Submitting',
} as const;

const failureLabels: Record<FailureCode, string> = {
  branch_not_found: 'Branch not found.',
  github_unavailable: 'GitHub is unavailable.',
  mirror_failed: 'Mirror failed.',
  repository_not_found: 'Repository not found.',
  request_failed: 'The import request could not complete.',
  scan_unavailable: 'The capability scan is unavailable.',
};

export interface GitHubInstallCallback {
  readonly code: string;
  readonly installationId: string;
  readonly state: string;
}

interface PendingImport {
  readonly branch: string;
  readonly importOperationKey: string;
  readonly installationId: string;
  readonly projectId?: string;
  readonly projectOperationKey: string;
  readonly repo: string;
}

export interface GitHubImportDialogProps {
  readonly callback: GitHubInstallCallback | undefined;
  readonly onCallbackConsumed: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly organizationId: string;
}

export function GitHubImportDialog({
  callback,
  onCallbackConsumed,
  onOpenChange,
  open,
  organizationId,
}: GitHubImportDialogProps): ReactElement {
  const router = useRouter();
  const [installationId, setInstallationId] = useState<string>();
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [repositoryCursor, setRepositoryCursor] = useState<string | null>();
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  const [branches, setBranches] = useState<readonly Branch[]>([]);
  const [branchCursor, setBranchCursor] = useState<string | null>();
  const [selectedBranch, setSelectedBranch] = useState('');
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [completingInstall, setCompletingInstall] = useState(false);
  const [importStatus, setImportStatus] = useState<DurableStatus | 'submitting'>();
  const [failureCode, setFailureCode] = useState<FailureCode>();
  const pendingImportRef = useRef<PendingImport | undefined>(undefined);
  const repositoryAbortRef = useRef<AbortController | undefined>(undefined);
  const branchAbortRef = useRef<AbortController | undefined>(undefined);
  const operationAbortRef = useRef<AbortController | undefined>(undefined);
  const pollAbortRef = useRef<AbortController | undefined>(undefined);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const processedCallbackRef = useRef<string | undefined>(undefined);
  const branchGenerationRef = useRef(0);
  const openRef = useRef(open);
  const previousOpenRef = useRef(open);

  const stopPolling = useCallback((): void => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = undefined;
    if (pollTimerRef.current !== undefined) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = undefined;
  }, []);

  const reset = useCallback((): void => {
    repositoryAbortRef.current?.abort();
    repositoryAbortRef.current = undefined;
    branchAbortRef.current?.abort();
    branchAbortRef.current = undefined;
    operationAbortRef.current?.abort();
    operationAbortRef.current = undefined;
    stopPolling();
    pendingImportRef.current = undefined;
    processedCallbackRef.current = undefined;
    branchGenerationRef.current += 1;
    setInstallationId(undefined);
    setRepositories([]);
    setRepositoryCursor(undefined);
    setSelectedRepositoryId('');
    setBranches([]);
    setBranchCursor(undefined);
    setSelectedBranch('');
    setLoadingRepositories(false);
    setLoadingBranches(false);
    setAuthorizing(false);
    setCompletingInstall(false);
    setImportStatus(undefined);
    setFailureCode(undefined);
  }, [stopPolling]);

  const loadRepositoryPage = useCallback(
    async (currentInstallationId: string, cursor?: string): Promise<void> => {
      repositoryAbortRef.current?.abort();
      const controller = new AbortController();
      repositoryAbortRef.current = controller;
      setLoadingRepositories(true);
      setFailureCode(undefined);
      try {
        const page = await createControlPlaneClient(organizationId).listGitHubRepositories(
          {
            installationId: currentInstallationId,
            ...(cursor === undefined ? {} : { cursor }),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setRepositories((current) => {
          const existing = new Set(current.map((repository) => repository.id));
          return [...current, ...page.items.filter((repository) => !existing.has(repository.id))];
        });
        setRepositoryCursor(page.nextCursor);
      } catch {
        if (!controller.signal.aborted) setFailureCode('request_failed');
      } finally {
        if (!controller.signal.aborted) setLoadingRepositories(false);
      }
    },
    [organizationId],
  );

  useEffect(() => {
    reset();
  }, [organizationId, reset]);

  useEffect(() => {
    if (!open) return;
    if (callback === undefined) return;
    const callbackIdentity = [
      organizationId,
      callback.installationId,
      callback.state,
      callback.code,
    ].join('\u0000');
    if (processedCallbackRef.current === callbackIdentity) return;
    processedCallbackRef.current = callbackIdentity;
    onCallbackConsumed();
    const controller = new AbortController();
    operationAbortRef.current?.abort();
    operationAbortRef.current = controller;
    setCompletingInstall(true);
    setFailureCode(undefined);

    void createControlPlaneClient(organizationId)
      .completeGitHubInstall(
        {
          code: callback.code,
          installationId: callback.installationId,
          state: callback.state,
        },
        undefined,
        controller.signal,
      )
      .then(async () => {
        if (controller.signal.aborted) return;
        setInstallationId(callback.installationId);
        setRepositories([]);
        await loadRepositoryPage(callback.installationId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailureCode('request_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setCompletingInstall(false);
      });
  }, [callback, loadRepositoryPage, onCallbackConsumed, open, organizationId]);

  useEffect(() => {
    return () => {
      repositoryAbortRef.current?.abort();
      branchAbortRef.current?.abort();
      operationAbortRef.current?.abort();
      stopPolling();
    };
  }, [stopPolling]);

  const authorize = async (): Promise<void> => {
    if (authorizing) return;
    const controller = new AbortController();
    operationAbortRef.current?.abort();
    operationAbortRef.current = controller;
    setAuthorizing(true);
    setFailureCode(undefined);
    try {
      const response = await createControlPlaneClient(organizationId).authorizeGitHubInstall(
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) window.location.assign(response.url);
    } catch {
      if (!controller.signal.aborted) setFailureCode('request_failed');
    } finally {
      if (!controller.signal.aborted) setAuthorizing(false);
    }
  };

  const loadBranchPage = useCallback(
    async (
      repositoryId: string,
      currentInstallationId: string,
      defaultBranch: string,
      generation: number,
      cursor?: string,
    ): Promise<void> => {
      branchAbortRef.current?.abort();
      const controller = new AbortController();
      branchAbortRef.current = controller;
      const isCurrent = (): boolean =>
        !controller.signal.aborted && branchGenerationRef.current === generation;
      setLoadingBranches(true);
      setFailureCode(undefined);
      try {
        const page = await createControlPlaneClient(organizationId).listGitHubBranches(
          repositoryId,
          {
            installationId: currentInstallationId,
            ...(cursor === undefined ? {} : { cursor }),
          },
          controller.signal,
        );
        if (!isCurrent()) return;
        setBranches((current) => {
          const existing = new Set(current.map((branch) => branch.name));
          return [...current, ...page.items.filter((branch) => !existing.has(branch.name))];
        });
        setBranchCursor(page.nextCursor);
        if (cursor === undefined) {
          const defaultBranchItem = page.items.find((branch) => branch.name === defaultBranch);
          setSelectedBranch(defaultBranchItem?.name ?? page.items[0]?.name ?? '');
        }
      } catch {
        if (isCurrent()) setFailureCode('request_failed');
      } finally {
        if (isCurrent()) setLoadingBranches(false);
      }
    },
    [organizationId],
  );

  const selectRepository = (event: ChangeEvent<HTMLSelectElement>): void => {
    const repositoryId = event.target.value;
    const generation = branchGenerationRef.current + 1;
    branchGenerationRef.current = generation;
    branchAbortRef.current?.abort();
    branchAbortRef.current = undefined;
    operationAbortRef.current?.abort();
    stopPolling();
    pendingImportRef.current = undefined;
    setSelectedRepositoryId(repositoryId);
    setBranches([]);
    setBranchCursor(undefined);
    setSelectedBranch('');
    setLoadingBranches(false);
    setImportStatus(undefined);
    setFailureCode(undefined);
    if (repositoryId.length === 0 || installationId === undefined) return;
    const repository = repositories.find((candidate) => candidate.id === repositoryId);
    if (repository === undefined) return;
    void loadBranchPage(repositoryId, installationId, repository.defaultBranch, generation);
  };

  const pollImport = useCallback(
    (projectId: string): void => {
      stopPolling();
      const controller = new AbortController();
      pollAbortRef.current = controller;

      const poll = (): void => {
        pollTimerRef.current = setTimeout(() => {
          void createControlPlaneClient(organizationId)
            .getGitHubImport(projectId, controller.signal)
            .then((progress) => {
              if (controller.signal.aborted) return;
              setImportStatus(progress.status);
              if (progress.status === 'scan_accepted') {
                stopPolling();
                pendingImportRef.current = undefined;
                onOpenChange(false);
                router.push(`/projects/${encodeURIComponent(projectId)}`);
                return;
              }
              if (progress.status === 'failed') {
                stopPolling();
                setFailureCode(progress.errorCode ?? 'request_failed');
                return;
              }
              poll();
            })
            .catch(() => {
              if (!controller.signal.aborted) {
                stopPolling();
                setFailureCode('request_failed');
                setImportStatus('failed');
              }
            });
        }, 1_000);
      };
      poll();
    },
    [onOpenChange, organizationId, router, stopPolling],
  );

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    openRef.current = open;
    if (!open) {
      stopPolling();
      return;
    }
    if (wasOpen) return;
    const pending = pendingImportRef.current;
    if (
      pending?.projectId !== undefined &&
      importStatus !== 'failed' &&
      importStatus !== 'scan_accepted'
    ) {
      pollImport(pending.projectId);
    }
  }, [importStatus, open, pollImport, stopPolling]);

  const startImport = async (retry = false): Promise<void> => {
    if (installationId === undefined || selectedBranch.length === 0) return;
    const repository = repositories.find((candidate) => candidate.id === selectedRepositoryId);
    if (repository === undefined) return;
    operationAbortRef.current?.abort();
    stopPolling();
    const controller = new AbortController();
    operationAbortRef.current = controller;
    let pending = retry ? pendingImportRef.current : undefined;
    if (pending === undefined) {
      pending = {
        branch: selectedBranch,
        importOperationKey: crypto.randomUUID(),
        installationId,
        projectOperationKey: crypto.randomUUID(),
        repo: repository.fullName,
      };
      pendingImportRef.current = pending;
    }
    setImportStatus('submitting');
    setFailureCode(undefined);
    try {
      const created = await createControlPlaneClient(organizationId).createProject(
        { name: pending.repo.slice(0, 80), sourceType: 'github_import' },
        pending.projectOperationKey,
        controller.signal,
      );
      captureProjectCreated({ organizationId, projectId: created.project.id });
      if (controller.signal.aborted) return;
      pending = { ...pending, projectId: created.project.id };
      pendingImportRef.current = pending;
      await createControlPlaneClient(organizationId).enqueueGitHubImport(
        created.project.id,
        {
          branch: pending.branch,
          installationId: pending.installationId,
          repo: pending.repo,
        },
        pending.importOperationKey,
        controller.signal,
      );
      setImportStatus('queued');
      if (openRef.current) pollImport(created.project.id);
    } catch {
      if (!controller.signal.aborted) {
        setImportStatus('failed');
        setFailureCode('request_failed');
      }
    }
  };

  const selectedRepository = repositories.find(
    (repository) => repository.id === selectedRepositoryId,
  );
  const handleOpenChange = (nextOpen: boolean): void => {
    openRef.current = nextOpen;
    if (!nextOpen) stopPolling();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog
      className={styles.githubImportDialog ?? ''}
      description="Connect an installation, choose a repository and branch, then zapp will mirror and scan it."
      onOpenChange={handleOpenChange}
      open={open}
      title="Import from GitHub"
      trigger={<Button variant="secondary">Import from GitHub</Button>}
    >
      <div className={styles.importFlow}>
        {installationId === undefined ? (
          <Button disabled={authorizing || completingInstall} onClick={() => void authorize()}>
            {authorizing || completingInstall ? 'Connecting…' : 'Connect GitHub'}
          </Button>
        ) : (
          <>
            <label className={styles.importField}>
              Repository
              <select
                disabled={loadingRepositories || importStatus === 'submitting'}
                onChange={selectRepository}
                value={selectedRepositoryId}
              >
                <option value="">Choose a repository</option>
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.fullName}
                    {repository.private ? ' (private)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {repositoryCursor === undefined || repositoryCursor === null ? null : (
              <Button
                disabled={loadingRepositories}
                onClick={() => void loadRepositoryPage(installationId, repositoryCursor)}
                variant="secondary"
              >
                Load more repositories
              </Button>
            )}
            {selectedRepository === undefined ? null : (
              <>
                <label className={styles.importField}>
                  Branch
                  <select
                    disabled={loadingBranches || importStatus === 'submitting'}
                    onChange={(event) => {
                      operationAbortRef.current?.abort();
                      stopPolling();
                      pendingImportRef.current = undefined;
                      setSelectedBranch(event.target.value);
                      setImportStatus(undefined);
                      setFailureCode(undefined);
                    }}
                    value={selectedBranch}
                  >
                    <option value="">Choose a branch</option>
                    {branches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
                {branchCursor === undefined || branchCursor === null ? null : (
                  <Button
                    disabled={loadingBranches}
                    onClick={() =>
                      void loadBranchPage(
                        selectedRepository.id,
                        installationId,
                        selectedRepository.defaultBranch,
                        branchGenerationRef.current,
                        branchCursor,
                      )
                    }
                    variant="secondary"
                  >
                    Load more branches
                  </Button>
                )}
              </>
            )}
            <Button
              disabled={
                selectedRepository === undefined ||
                selectedBranch.length === 0 ||
                pendingImportRef.current !== undefined ||
                importStatus === 'submitting'
              }
              onClick={() => void startImport()}
            >
              Import repository
            </Button>
          </>
        )}

        {loadingRepositories ? (
          <p aria-live="polite" role="status">
            Loading repositories…
          </p>
        ) : null}
        {loadingBranches ? (
          <p aria-live="polite" role="status">
            Loading branches…
          </p>
        ) : null}
        {importStatus === undefined ? null : (
          <p aria-live="polite" className={styles.importStatus} role="status">
            {statusLabels[importStatus]}
          </p>
        )}
        {failureCode === undefined ? null : (
          <div className={styles.importFailure} role="alert">
            <p>{failureLabels[failureCode]}</p>
            {pendingImportRef.current === undefined ? null : (
              <Button onClick={() => void startImport(true)} variant="secondary">
                Retry import
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
