import { Button } from '@zapp/ui';
import Link from 'next/link';
import type { ReactElement } from 'react';

import { ProjectCard } from '../projects/ProjectCard';
import type { ProjectDashboardState } from '../projects/useProjectDashboard';
import styles from './home.module.css';

export interface RecentProjectsProps {
  readonly dashboard: ProjectDashboardState;
}

export function RecentProjects({ dashboard }: RecentProjectsProps): ReactElement {
  return (
    <section aria-labelledby="recent-projects-title" className={styles.recentPanel}>
      <header className={styles.recentHeader}>
        <div>
          <p className={styles.recentEyebrow}>Workspace</p>
          <h2 id="recent-projects-title">My projects</h2>
        </div>
        <div className={styles.recentActions}>
          <button
            aria-label="Refresh projects"
            className={styles.refreshProjects}
            onClick={dashboard.retry}
            type="button"
          >
            <span aria-hidden="true">↻</span>
          </button>
          <Link className={styles.browseProjects} href="/projects">
            Browse all projects <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>

      {dashboard.projectsFailed ? (
        <div className={styles.recentFailure} role="alert">
          <p>Projects could not load.</p>
          <Button onClick={dashboard.retry} variant="secondary">Retry</Button>
        </div>
      ) : dashboard.loading && dashboard.projects.length === 0 ? (
        <p aria-live="polite" className={styles.recentState} role="status">Loading projects…</p>
      ) : dashboard.projects.length === 0 ? (
        <p className={styles.recentState}>No projects yet. Start with a prompt above.</p>
      ) : (
        <div className={styles.recentGrid}>
          {dashboard.projects.map((project) => (
            <ProjectCard
              key={project.id}
              loadingSummary={!dashboard.summaryFailed && !dashboard.summaries.has(project.id)}
              onRetrySummary={dashboard.retry}
              project={project}
              summary={dashboard.summaries.get(project.id)}
              summaryFailed={dashboard.summaryFailed}
              {...(dashboard.thumbnailUrls.get(project.id) === undefined
                ? {}
                : { thumbnailUrl: dashboard.thumbnailUrls.get(project.id) })}
            />
          ))}
        </div>
      )}
    </section>
  );
}
