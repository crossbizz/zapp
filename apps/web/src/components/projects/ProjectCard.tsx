'use client';

import { Button, Card, SupportLevelBadge } from '@zapp/ui';
import Link from 'next/link';
import type { ReactElement } from 'react';

import { createControlPlaneClient } from '../../lib/api';
import styles from './projects.module.css';

type Client = ReturnType<typeof createControlPlaneClient>;
type Project = Awaited<ReturnType<Client['listProjects']>>['items'][number];
type Summary = Awaited<ReturnType<Client['getProjectSummaries']>>['summaries'][number];

const previewLabels = {
  failed: 'Failed',
  not_started: 'Not started',
  ready: 'Ready',
  starting: 'Starting',
} as const;

const productionLabels = {
  deploying: 'Deploying',
  failed: 'Failed',
  healthy: 'Healthy',
  not_deployed: 'Not deployed',
} as const;

const readinessLabels = {
  blocked: 'Blocked',
  ready: 'Ready',
  warnings: 'Warnings',
} as const;

function activityLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export interface ProjectCardProps {
  readonly loadingSummary: boolean;
  readonly onRetrySummary: () => void;
  readonly project: Project;
  readonly summary: Summary | undefined;
  readonly summaryFailed: boolean;
}

export function ProjectCard({
  loadingSummary,
  onRetrySummary,
  project,
  summary,
  summaryFailed,
}: ProjectCardProps): ReactElement {
  return (
    <Card as="article" className={styles.projectCard}>
      <h2>{project.name}</h2>
      <SupportLevelBadge level={project.supportLevel} />

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
            {summary.lastActivityAt === null ? (
              'No activity yet'
            ) : (
              <>
                Last activity{' '}
                <time dateTime={summary.lastActivityAt}>{activityLabel(summary.lastActivityAt)}</time>
              </>
            )}
          </p>
          <div className={styles.environmentStatuses}>
            <p data-state={summary.preview.status}>
              <span aria-hidden="true" data-status-icon="true">
                ◇
              </span>{' '}
              <span>{`Preview: ${previewLabels[summary.preview.status]}`}</span>
            </p>
            <p data-state={summary.production.status}>
              <span aria-hidden="true" data-status-icon="true">
                ◆
              </span>{' '}
              <span>{`Production: ${productionLabels[summary.production.status]}`}</span>
            </p>
          </div>
          <p className={styles.readiness}>
            Deploy readiness:{' '}
            {summary.deployReadiness === null
              ? 'Unavailable'
              : readinessLabels[summary.deployReadiness.state]}
          </p>
        </div>
      )}

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
