'use client';

import { Button, Card, SupportLevelBadge } from '@zapp/ui';
import Link from 'next/link';
import type { ReactElement } from 'react';

import { createControlPlaneClient } from '../../lib/api';
import styles from './projects.module.css';
import { ProjectThumbnail } from './ProjectThumbnail';
import { toProjectCardView } from './project-card-view';

type Client = ReturnType<typeof createControlPlaneClient>;
type Project = Awaited<ReturnType<Client['listProjects']>>['items'][number];
type Summary = Awaited<ReturnType<Client['getProjectSummaries']>>['summaries'][number];

export interface ProjectCardProps {
  readonly loadingSummary: boolean;
  readonly onRetrySummary: () => void;
  readonly project: Project;
  readonly summary: Summary | undefined;
  readonly summaryFailed: boolean;
  readonly thumbnailUrl?: string | undefined;
}

export function ProjectCard({
  loadingSummary,
  onRetrySummary,
  project,
  summary,
  summaryFailed,
  thumbnailUrl,
}: ProjectCardProps): ReactElement {
  const view = toProjectCardView(project, summary);
  return (
    <Card as="article" className={styles.projectCard}>
      <ProjectThumbnail alt={view.thumbnail?.alt} name={view.name} url={thumbnailUrl} />
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
            {view.activity.dateTime === null
              ? view.activity.label
              : <time dateTime={view.activity.dateTime}>{view.activity.label}</time>}
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
          <p className={styles.readiness}>
            Deploy readiness:{' '}
            {view.readiness.label}
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
