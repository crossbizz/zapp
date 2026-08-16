'use client';

import { Button, Card } from '@zapp/ui';
import Link from 'next/link';
import { useRef, useState, type ReactElement } from 'react';

import { createControlPlaneClient } from '../../lib/api';
import styles from './projects.module.css';
import { ProjectThumbnail } from './ProjectThumbnail';
import { toProjectCardView } from './project-card-view';

type Client = ReturnType<typeof createControlPlaneClient>;
type Project = Awaited<ReturnType<Client['listProjects']>>['items'][number];
type Summary = Awaited<ReturnType<Client['getProjectSummaries']>>['summaries'][number];

export type ProjectDeletionState =
  | { readonly status: 'idle' }
  | { readonly status: 'confirming' }
  | { readonly operationKey: string; readonly status: 'requesting' }
  | { readonly operationKey: string; readonly status: 'queued' | 'running' }
  | {
      readonly message: string;
      readonly operationKey: string;
      readonly status: 'reconciling';
    }
  | {
      readonly message: string;
      readonly operationKey: string;
      readonly retryUsesSameKey: boolean;
      readonly status: 'failed';
    };

export interface ProjectCardProps {
  readonly canDelete?: boolean;
  readonly deletionState?: ProjectDeletionState;
  readonly loadingSummary: boolean;
  readonly onDelete?: (returnFocusElement: HTMLButtonElement) => void;
  readonly onRetryDelete?: () => void;
  readonly onRetrySummary: () => void;
  readonly project: Project;
  readonly summary: Summary | undefined;
  readonly summaryFailed: boolean;
  readonly thumbnailUrl?: string | undefined;
}

export function ProjectCard({
  canDelete = false,
  deletionState = { status: 'idle' },
  loadingSummary,
  onDelete,
  onRetryDelete,
  onRetrySummary,
  project,
  summary,
  summaryFailed,
  thumbnailUrl,
}: ProjectCardProps): ReactElement {
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const view = toProjectCardView(project, summary);
  const deleting =
    deletionState.status === 'requesting' ||
    deletionState.status === 'queued' ||
    deletionState.status === 'running';
  return (
    <Card aria-label={project.name} as="article" className={styles.projectCard}>
      {canDelete ? (
        <div
          className={styles.projectActionsMenu}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setActionsOpen(false);
              actionsTriggerRef.current?.focus();
            }
          }}
        >
          <button
            aria-expanded={actionsOpen}
            aria-label={`Project actions for ${project.name}`}
            aria-disabled={deletionState.status !== 'idle'}
            className={styles.projectActionsTrigger}
            onClick={() => {
              if (deletionState.status !== 'idle') return;
              setActionsOpen((current) => !current);
            }}
            ref={actionsTriggerRef}
            type="button"
          >
            <span aria-hidden="true">•••</span>
          </button>
          {actionsOpen ? (
            <div className={styles.projectActionsPopover}>
              <button
                onClick={() => {
                  setActionsOpen(false);
                  const trigger = actionsTriggerRef.current;
                  if (trigger !== null) onDelete?.(trigger);
                }}
                type="button"
              >
                Delete project
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ProjectThumbnail alt={view.thumbnail?.alt} name={view.name} url={thumbnailUrl} />
      <h2>{project.name}</h2>

      {summaryFailed ? (
        <div className={styles.summaryFailure} role="alert">
          <p>Project details could not load.</p>
          <Button aria-label="Retry project details" onClick={onRetrySummary} variant="secondary">
            Retry
          </Button>
        </div>
      ) : loadingSummary || summary === undefined ? (
        <p aria-live="polite" className={styles.summaryLoading} role="status">
          Loading project details…
        </p>
      ) : (
        <div className={styles.summary}>
          <p className={styles.activity}>
            {view.activity.dateTime === null ? (
              view.activity.label
            ) : (
              <time dateTime={view.activity.dateTime}>{view.activity.label}</time>
            )}
          </p>
          <div className={styles.environmentStatuses}>
            <p data-state={view.preview.state}>
              <span aria-hidden="true" data-status-icon="true">
                ◇
              </span>{' '}
              <span>{`Preview: ${view.preview.label}`}</span>
            </p>
            <p data-state={view.production.state}>
              <span aria-hidden="true" data-status-icon="true">
                ◆
              </span>{' '}
              <span>{`Production: ${view.production.label}`}</span>
            </p>
          </div>
          <p className={styles.readiness}>Deploy readiness: {view.readiness.label}</p>
        </div>
      )}

      {deleting ? (
        <p aria-live="polite" className={styles.deletionStatus} role="status">
          Deleting…
        </p>
      ) : deletionState.status === 'failed' ? (
        <div className={styles.deletionFailure} role="alert">
          <p>Deletion failed. {deletionState.message}</p>
          <Button onClick={onRetryDelete} variant="secondary">
            Retry deletion
          </Button>
        </div>
      ) : deletionState.status === 'reconciling' ? (
        <div className={styles.deletionReconciliation} role="status">
          <p>Deletion status unknown. {deletionState.message}</p>
          <Button onClick={onRetryDelete} variant="secondary">
            Retry deletion
          </Button>
        </div>
      ) : null}

      <div className={styles.cardActions}>
        <Link
          aria-label={`Open ${project.name}`}
          className={styles.openLink}
          href={`/projects/${encodeURIComponent(project.id)}`}
        >
          Open
        </Link>
        {summary?.deployReadiness?.state === 'ready' ? (
          <Link
            aria-label={`Deploy ${project.name}`}
            className={styles.deployLink}
            href={`/projects/${encodeURIComponent(project.id)}/releases`}
          >
            Deploy
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
