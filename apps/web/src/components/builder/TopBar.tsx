import { SupportLevelBadge } from '@zapp/ui';
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

export type RepositorySyncState = 'synced' | 'ahead' | 'diverged' | 'unavailable';

const syncLabels: Readonly<Record<RepositorySyncState, string>> = {
  ahead: 'Ahead',
  diverged: 'Diverged',
  synced: 'Synced',
  unavailable: 'Unavailable',
};

interface TopBarProps {
  readonly deploy: ReactNode;
  readonly missionControl: ReactNode;
  readonly mode: 'manage' | 'preview';
  readonly onModeChange: (mode: 'manage' | 'preview') => void;
  readonly projectId: string;
  readonly projectName: string;
  readonly supportLevel: 'compatible' | 'verified' | 'managed';
  readonly syncState: RepositorySyncState;
}

function GitHubIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="zapp-builder-action-icon" viewBox="0 0 24 24">
      <path
        d="M12 2.8a9.4 9.4 0 0 0-3 18.3c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .8.1-.7.4-1.2.7-1.4-2.3-.3-4.7-1.1-4.7-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.7s.8-.3 2.8 1a9.5 9.5 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.3.2 2.3.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.7 5 .4.3.7 1 .7 1.9v2.7c0 .3.2.6.7.5A9.4 9.4 0 0 0 12 2.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SettingsIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="zapp-builder-action-icon" viewBox="0 0 24 24">
      <path
        d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8 3.5-.1-1.2 2-1.6-2-3.4-2.4 1a8.2 8.2 0 0 0-2.1-1.2L15 3h-4l-.4 2.6a8.2 8.2 0 0 0-2.1 1.2l-2.4-1-2 3.4 2 1.6L6 12l.1 1.2-2 1.6 2 3.4 2.4-1a8.2 8.2 0 0 0 2.1 1.2L11 21h4l.4-2.6a8.2 8.2 0 0 0 2.1-1.2l2.4 1 2-3.4-2-1.6.1-1.2Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function ProjectsIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="zapp-builder-action-icon" viewBox="0 0 24 24">
      <rect height="6" rx="1.25" width="6" x="4" y="4" />
      <rect height="6" rx="1.25" width="6" x="14" y="4" />
      <rect height="6" rx="1.25" width="6" x="4" y="14" />
      <rect height="6" rx="1.25" width="6" x="14" y="14" />
    </svg>
  );
}

function BuilderModeIcon({ mode }: { readonly mode: 'manage' | 'preview' }): ReactElement {
  return mode === 'preview' ? (
    <svg aria-hidden="true" className="zapp-builder-action-icon" viewBox="0 0 24 24">
      <rect height="13" rx="1.8" width="18" x="3" y="4" />
      <path d="M9 21h6M12 17v4" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ) : (
    <svg aria-hidden="true" className="zapp-builder-action-icon" viewBox="0 0 24 24">
      <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeLinecap="round" />
      <circle cx="9" cy="6" fill="currentColor" r="1.8" />
      <circle cx="15" cy="12" fill="currentColor" r="1.8" />
      <circle cx="11" cy="18" fill="currentColor" r="1.8" />
    </svg>
  );
}

export function TopBar({
  deploy,
  missionControl,
  mode,
  onModeChange,
  projectId,
  projectName,
  supportLevel,
  syncState,
}: TopBarProps): ReactElement {
  return (
    <div aria-label="Project editor" className="zapp-builder-top-bar" role="region">
      <div className="zapp-builder-project-identity">
        <Link aria-label="zapp.build home" className="zapp-builder-home-link" href="/">
          <span aria-hidden="true">z</span>
        </Link>
        <span aria-hidden="true" className="zapp-builder-header-divider" />
        <Link
          aria-label="Projects"
          className="zapp-builder-projects-link"
          href="/projects"
          title="All projects"
        >
          <ProjectsIcon />
        </Link>
        <div className="zapp-builder-project-title">
          <h1 className="zapp-builder-project-name">{projectName}</h1>
        </div>
        <SupportLevelBadge level={supportLevel} />
      </div>
      <div aria-label="Builder mode" className="zapp-builder-mode-switcher" role="group">
        {(['preview', 'manage'] as const).map((item) => (
          <button
            aria-label={item === 'preview' ? 'Preview' : 'Manage'}
            aria-pressed={mode === item}
            key={item}
            onClick={() => {
              onModeChange(item);
            }}
            title={`${item === 'preview' ? 'Preview' : 'Manage'} mode`}
            type="button"
          >
            <BuilderModeIcon mode={item} />
          </button>
        ))}
      </div>
      <nav aria-label="Project actions" className="zapp-builder-project-actions">
        <a
          className="zapp-builder-action-link"
          href={`/projects/${projectId}/settings/integrations`}
        >
          <GitHubIcon />
          <span>GitHub</span>
          <span className="zapp-builder-sync-pill" data-sync-state={syncState}>
            {syncLabels[syncState]}
          </span>
        </a>
        {deploy}
        {missionControl}
        <a
          aria-label="Project settings"
          className="zapp-builder-settings-link"
          href={`/projects/${projectId}/settings/general`}
        >
          <SettingsIcon />
        </a>
      </nav>
    </div>
  );
}
