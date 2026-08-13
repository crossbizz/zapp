import type { createControlPlaneClient } from '../../lib/api';

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

export interface ProjectStatusView {
  readonly label: string;
  readonly state: string;
}

export interface ProjectCardView {
  readonly activity: {
    readonly dateTime: string | null;
    readonly label: string;
  };
  readonly href: string;
  readonly id: string;
  readonly name: string;
  readonly preview: ProjectStatusView;
  readonly production: ProjectStatusView;
  readonly readiness: ProjectStatusView;
  readonly supportLevel: Project['supportLevel'];
  readonly thumbnail: Summary['previewThumbnail'] | null;
}

function activityLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export function toProjectCardView(
  project: Project,
  summary: Summary | undefined,
): ProjectCardView {
  const lastActivityAt = summary?.lastActivityAt ?? null;
  const previewState = summary?.preview.status ?? 'not_started';
  const productionState = summary?.production.status ?? 'not_deployed';
  const readinessState = summary?.deployReadiness?.state ?? 'unavailable';

  return {
    activity: {
      dateTime: lastActivityAt,
      label: lastActivityAt === null ? 'No activity yet' : `Last activity ${activityLabel(lastActivityAt)}`,
    },
    href: `/projects/${encodeURIComponent(project.id)}`,
    id: project.id,
    name: project.name,
    preview: { label: previewLabels[previewState], state: previewState },
    production: { label: productionLabels[productionState], state: productionState },
    readiness: {
      label: readinessState === 'unavailable' ? 'Unavailable' : readinessLabels[readinessState],
      state: readinessState,
    },
    supportLevel: project.supportLevel,
    thumbnail: summary?.previewThumbnail ?? null,
  };
}
