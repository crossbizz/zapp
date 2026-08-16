'use client';

import type { RunEvent } from '@zapp/api-client';
import Link from 'next/link';
import { useEffect, useState, type ReactElement } from 'react';

import type { BuilderRun } from '../../lib/api';
import { LogView } from '../logs/LogView';
import { TestRuns } from '../tests/TestRuns';
import type { PreviewSection } from './builder-navigation';
import styles from './builder.module.css';

type MoreSubview =
  'analytics' | 'cloud' | 'ai' | 'agents' | 'payments' | 'connectors' | 'security' | 'seo';
type CloudSubview = 'overview' | 'secrets' | 'logs' | 'usage';

const navigation = [
  ['analytics', 'Analytics'],
  ['cloud', 'Cloud'],
  ['ai', 'AI'],
  ['agents', 'Agent integrations'],
  ['payments', 'Payments'],
  ['connectors', 'Connectors'],
  ['security', 'Security'],
  ['seo', 'SEO & AI search'],
] as const satisfies readonly (readonly [MoreSubview, string])[];

const cloudNavigation = [
  ['overview', 'Overview'],
  ['secrets', 'Secrets'],
  ['logs', 'Logs'],
  ['usage', 'Usage'],
] as const satisfies readonly (readonly [CloudSubview, string])[];

function MoreIcon({ kind }: { readonly kind: CloudSubview | MoreSubview }): ReactElement {
  const shared = {
    'aria-hidden': true,
    viewBox: '0 0 24 24',
  } as const;

  switch (kind) {
    case 'analytics':
    case 'usage':
      return (
        <svg {...shared}>
          <path d="M4 19V9m6 10V5m6 14v-7m4 7H2" />
        </svg>
      );
    case 'cloud':
      return (
        <svg {...shared}>
          <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z" />
        </svg>
      );
    case 'ai':
      return (
        <svg {...shared}>
          <path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Zm6 11 .7 2.3L21 17.5l-2.3 1.2L18 21l-.7-2.3-2.3-1.2 2.3-1.2L18 14Z" />
        </svg>
      );
    case 'agents':
      return (
        <svg {...shared}>
          <path d="m12 3 8 9-8 9-8-9 8-9Z" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      );
    case 'payments':
      return (
        <svg {...shared}>
          <rect height="14" rx="2" width="18" x="3" y="5" />
          <path d="M3 9h18m-14 6h4" />
        </svg>
      );
    case 'connectors':
      return (
        <svg {...shared}>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <circle cx="12" cy="18" r="2.5" />
          <path d="m8 7.5 3 7.8m5-7.8-3 7.8M8.5 6h7" />
        </svg>
      );
    case 'security':
      return (
        <svg {...shared}>
          <path d="M12 3 5 6v5c0 4.7 2.7 8 7 10 4.3-2 7-5.3 7-10V6l-7-3Z" />
        </svg>
      );
    case 'seo':
      return (
        <svg {...shared}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </svg>
      );
    case 'overview':
      return (
        <svg {...shared}>
          <rect height="7" rx="1" width="7" x="3" y="3" />
          <rect height="7" rx="1" width="7" x="14" y="3" />
          <rect height="7" rx="1" width="7" x="3" y="14" />
          <rect height="7" rx="1" width="7" x="14" y="14" />
        </svg>
      );
    case 'secrets':
      return (
        <svg {...shared}>
          <circle cx="8" cy="12" r="4" />
          <path d="M12 12h9m-3 0v3m-3-3v2" />
        </svg>
      );
    case 'logs':
      return (
        <svg {...shared}>
          <path d="M5 5h14M5 12h14M5 19h14" />
          <circle cx="2.5" cy="5" r=".5" />
          <circle cx="2.5" cy="12" r=".5" />
          <circle cx="2.5" cy="19" r=".5" />
        </svg>
      );
  }
}

function subviewForSurface(surface: PreviewSection): MoreSubview {
  if (surface === 'logs') return 'cloud';
  if (surface === 'tests') return 'security';
  return 'analytics';
}

function SettingsCard({
  description,
  href,
  icon,
  title,
}: {
  readonly description: string;
  readonly href: string;
  readonly icon: MoreSubview;
  readonly title: string;
}): ReactElement {
  return (
    <div className={styles.moreEmpty}>
      <span className={styles.moreEmptyIcon}>
        <MoreIcon kind={icon} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      <Link href={href}>Open settings</Link>
    </div>
  );
}

export function MoreView({
  activeSurface,
  events,
  onRunCreated,
  onSurfaceChange,
  organizationId,
  projectId,
  runId,
  runStatus,
}: {
  readonly activeSurface: PreviewSection;
  readonly events: readonly RunEvent[];
  readonly onRunCreated: (run: BuilderRun) => void;
  readonly onSurfaceChange: (surface: PreviewSection) => void;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly runStatus?: BuilderRun['status'];
}): ReactElement {
  const [subview, setSubview] = useState<MoreSubview>(() => subviewForSurface(activeSurface));
  const [cloudSubview, setCloudSubview] = useState<CloudSubview>('logs');
  useEffect(() => {
    setSubview(subviewForSurface(activeSurface));
  }, [activeSurface]);

  const select = (next: MoreSubview): void => {
    setSubview(next);
    if (next === 'cloud') {
      setCloudSubview('overview');
      onSurfaceChange('logs');
    } else if (next === 'security') onSurfaceChange('tests');
    else if (next === 'analytics') onSurfaceChange('health');
  };

  let content: ReactElement;
  switch (subview) {
    case 'analytics': {
      const previewReady = events.some((event) => event.type === 'preview.ready');
      content = (
        <section aria-label="Analytics overview" className={styles.analytics}>
          <header>
            <p>PROJECT ACTIVITY</p>
            <h2>Analytics</h2>
            <span>Live data from this build</span>
          </header>
          <div className={styles.metricGrid}>
            <article>
              <span>Current run</span>
              <strong>{runStatus ?? 'Not started'}</strong>
            </article>
            <article>
              <span>Activity events</span>
              <strong>{events.length}</strong>
            </article>
            <article>
              <span>Preview</span>
              <strong>{previewReady ? 'Ready' : 'Waiting'}</strong>
            </article>
          </div>
        </section>
      );
      break;
    }
    case 'cloud':
      if (cloudSubview === 'logs') {
        content = <LogView organizationId={organizationId} projectId={projectId} />;
      } else if (cloudSubview === 'secrets') {
        content = (
          <SettingsCard
            description="Store and manage environment variables through the project integrations API."
            href={`/projects/${projectId}/settings/integrations`}
            icon="cloud"
            title="Secrets"
          />
        );
      } else if (cloudSubview === 'usage') {
        content = (
          <section aria-label="Cloud usage" className={styles.analytics}>
            <header>
              <p>CLOUD ACTIVITY</p>
              <h2>Usage</h2>
              <span>Current workspace activity for this project</span>
            </header>
            <div className={styles.metricGrid}>
              <article>
                <span>Current run</span>
                <strong>{runStatus ?? 'Not started'}</strong>
              </article>
              <article>
                <span>Run events</span>
                <strong>{events.length}</strong>
              </article>
            </div>
          </section>
        );
      } else {
        content = (
          <section aria-label="Cloud overview" className={styles.cloudOverview}>
            <header>
              <p>CLOUD</p>
              <h2>Cloud</h2>
              <span>Inspect runtime activity and configure project services.</span>
            </header>
            <div className={styles.cloudCards}>
              <button
                onClick={() => {
                  setCloudSubview('logs');
                }}
                type="button"
              >
                <MoreIcon kind="logs" />
                <span>
                  <strong>Logs</strong>
                  <small>Monitor workspace output and runtime failures</small>
                </span>
                <b aria-hidden="true">›</b>
              </button>
              <button
                onClick={() => {
                  setCloudSubview('secrets');
                }}
                type="button"
              >
                <MoreIcon kind="secrets" />
                <span>
                  <strong>Secrets</strong>
                  <small>Manage environment variables securely</small>
                </span>
                <b aria-hidden="true">›</b>
              </button>
            </div>
          </section>
        );
      }
      break;
    case 'security':
      content = (
        <TestRuns
          onRunCreated={onRunCreated}
          organizationId={organizationId}
          projectId={projectId}
          {...(runId === undefined ? {} : { runId })}
        />
      );
      break;
    case 'ai':
      content = (
        <SettingsCard
          description="Connect and manage the model providers available to this project."
          href={`/projects/${projectId}/settings/integrations`}
          icon="ai"
          title="AI models"
        />
      );
      break;
    case 'agents':
      content = (
        <SettingsCard
          description="Manage the services and permissions your agent can use."
          href={`/projects/${projectId}/settings/integrations`}
          icon="agents"
          title="Agent integrations"
        />
      );
      break;
    case 'payments':
      content = (
        <SettingsCard
          description="Configure the payment provider used by the application."
          href={`/projects/${projectId}/settings/payments`}
          icon="payments"
          title="Payments"
        />
      );
      break;
    case 'connectors':
      content = (
        <SettingsCard
          description="Connect external services through the project integrations API."
          href={`/projects/${projectId}/settings/integrations`}
          icon="connectors"
          title="Connectors"
        />
      );
      break;
    case 'seo':
      content = (
        <SettingsCard
          description="Configure discoverability and AI-search metadata for releases."
          href={`/projects/${projectId}/settings/general`}
          icon="seo"
          title="SEO & AI search"
        />
      );
      break;
  }

  return (
    <div className={styles.moreLayout}>
      <nav aria-label="More project views" className={styles.moreNavigation} role="tablist">
        {navigation.map(([id, label]) => (
          <div className={styles.moreNavigationGroup} key={id}>
            <button
              aria-selected={subview === id}
              onClick={() => {
                select(id);
              }}
              role="tab"
              tabIndex={subview === id ? 0 : -1}
              type="button"
            >
              <MoreIcon kind={id} />
              {label}
            </button>
            {id === 'cloud' && subview === 'cloud' ? (
              <div
                aria-label="Cloud project views"
                className={styles.cloudNavigation}
                role="tablist"
              >
                {cloudNavigation.map(([cloudId, cloudLabel]) => (
                  <button
                    aria-selected={cloudSubview === cloudId}
                    key={cloudId}
                    onClick={() => {
                      setCloudSubview(cloudId);
                    }}
                    role="tab"
                    tabIndex={cloudSubview === cloudId ? 0 : -1}
                    type="button"
                  >
                    <MoreIcon kind={cloudId} />
                    {cloudLabel}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </nav>
      <div className={styles.moreContent}>{content}</div>
    </div>
  );
}
