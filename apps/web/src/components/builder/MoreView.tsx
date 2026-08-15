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
  | 'analytics'
  | 'cloud'
  | 'ai'
  | 'agents'
  | 'payments'
  | 'connectors'
  | 'security'
  | 'seo';

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

function subviewForSurface(surface: PreviewSection): MoreSubview {
  if (surface === 'logs') return 'cloud';
  if (surface === 'tests') return 'security';
  return 'analytics';
}

function SettingsCard({ description, href, title }: { readonly description: string; readonly href: string; readonly title: string }): ReactElement {
  return <div className={styles.moreEmpty}>
    <span aria-hidden="true" className={styles.moreEmptyIcon}>◇</span>
    <h2>{title}</h2>
    <p>{description}</p>
    <Link href={href}>Open settings</Link>
  </div>;
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
  useEffect(() => { setSubview(subviewForSurface(activeSurface)); }, [activeSurface]);

  const select = (next: MoreSubview): void => {
    setSubview(next);
    if (next === 'cloud') onSurfaceChange('logs');
    else if (next === 'security') onSurfaceChange('tests');
    else if (next === 'analytics') onSurfaceChange('health');
  };

  let content: ReactElement;
  switch (subview) {
    case 'analytics': {
      const previewReady = events.some((event) => event.type === 'preview.ready');
      content = <section aria-label="Analytics overview" className={styles.analytics}>
        <header><p>PROJECT ACTIVITY</p><h2>Analytics</h2><span>Live data from this build</span></header>
        <div className={styles.metricGrid}>
          <article><span>Current run</span><strong>{runStatus ?? 'Not started'}</strong></article>
          <article><span>Activity events</span><strong>{events.length}</strong></article>
          <article><span>Preview</span><strong>{previewReady ? 'Ready' : 'Waiting'}</strong></article>
        </div>
      </section>;
      break;
    }
    case 'cloud':
      content = <LogView organizationId={organizationId} projectId={projectId} />;
      break;
    case 'security':
      content = <TestRuns onRunCreated={onRunCreated} organizationId={organizationId} projectId={projectId} {...(runId === undefined ? {} : { runId })} />;
      break;
    case 'ai':
      content = <SettingsCard description="Connect and manage the model providers available to this project." href={`/projects/${projectId}/settings/integrations`} title="AI models" />;
      break;
    case 'agents':
      content = <SettingsCard description="Manage the services and permissions your agent can use." href={`/projects/${projectId}/settings/integrations`} title="Agent integrations" />;
      break;
    case 'payments':
      content = <SettingsCard description="Configure the payment provider used by the application." href={`/projects/${projectId}/settings/payments`} title="Payments" />;
      break;
    case 'connectors':
      content = <SettingsCard description="Connect external services through the project integrations API." href={`/projects/${projectId}/settings/integrations`} title="Connectors" />;
      break;
    case 'seo':
      content = <SettingsCard description="Configure discoverability and AI-search metadata for releases." href={`/projects/${projectId}/settings/general`} title="SEO & AI search" />;
      break;
  }

  return <div className={styles.moreLayout}>
    <nav aria-label="More project views" className={styles.moreNavigation} role="tablist">
      {navigation.map(([id, label]) => <button aria-selected={subview === id} key={id} onClick={() => { select(id); }} role="tab" tabIndex={subview === id ? 0 : -1} type="button"><span aria-hidden="true">◇</span>{label}</button>)}
    </nav>
    <div className={styles.moreContent}>{content}</div>
  </div>;
}
