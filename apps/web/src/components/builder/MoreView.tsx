'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type BuilderRun } from '../../lib/api';
import { LogView } from '../logs/LogView';
import { IntegrationsSettings } from '../settings/IntegrationsSettings';
import { PaymentsSettings } from '../settings/PaymentsSettings';
import { SecretsSettings } from '../settings/SecretsSettings';
import type { ProjectSettingsSection } from '../settings/settings-types';
import { useProjectSettings } from '../settings/useProjectSettings';
import { TestRuns } from '../tests/TestRuns';
import type { MoreSubview } from './builder-navigation';
import styles from './builder.module.css';

type CloudSubview = 'overview' | 'secrets' | 'logs' | 'usage';
type UsageResponse = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getUsageSummary']>
>;
type ReleasesResponse = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['listProjectReleases']>
>;

const navigation = [
  ['analytics', 'Analytics'],
  ['cloud', 'Cloud'],
  ['ai', 'AI'],
  ['mcp', 'Agent integrations'],
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
  const shared = { 'aria-hidden': true, viewBox: '0 0 24 24' } as const;

  switch (kind) {
    case 'analytics':
    case 'usage':
      return <svg {...shared}><path d="M4 19V9m6 10V5m6 14v-7m4 7H2" /></svg>;
    case 'cloud':
      return <svg {...shared}><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z" /></svg>;
    case 'ai':
      return <svg {...shared}><path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Zm6 11 .7 2.3L21 17.5l-2.3 1.2L18 21l-.7-2.3-2.3-1.2 2.3-1.2L18 14Z" /></svg>;
    case 'mcp':
      return <svg {...shared}><path d="m12 3 8 9-8 9-8-9 8-9Z" /><circle cx="12" cy="12" r="2" /></svg>;
    case 'payments':
      return <svg {...shared}><rect height="14" rx="2" width="18" x="3" y="5" /><path d="M3 9h18m-14 6h4" /></svg>;
    case 'connectors':
      return <svg {...shared}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="m8 7.5 3 7.8m5-7.8-3 7.8M8.5 6h7" /></svg>;
    case 'security':
      return <svg {...shared}><path d="M12 3 5 6v5c0 4.7 2.7 8 7 10 4.3-2 7-5.3 7-10V6l-7-3Z" /></svg>;
    case 'seo':
      return <svg {...shared}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>;
    case 'overview':
      return <svg {...shared}><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><rect height="7" rx="1" width="7" x="14" y="14" /></svg>;
    case 'secrets':
      return <svg {...shared}><circle cx="8" cy="12" r="4" /><path d="M12 12h9m-3 0v3m-3-3v2" /></svg>;
    case 'logs':
      return <svg {...shared}><path d="M5 5h14M5 12h14M5 19h14" /><circle cx="2.5" cy="5" r=".5" /><circle cx="2.5" cy="12" r=".5" /><circle cx="2.5" cy="19" r=".5" /></svg>;
  }
}

function monthWindow(): { readonly from: string; readonly to: string } {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

function EmbeddedSettings({
  projectId,
  section,
}: {
  readonly projectId: string;
  readonly section: Extract<ProjectSettingsSection, 'integrations' | 'payments' | 'secrets'>;
}): ReactElement {
  const controller = useProjectSettings(projectId, section);
  return (
    <section aria-label={`${section} settings`} className={styles.embeddedMoreSettings}>
      <p aria-live="polite" className={styles.moreStatus}>{controller.status}</p>
      {section === 'secrets' ? <SecretsSettings controller={controller} /> : null}
      {section === 'integrations' ? <IntegrationsSettings controller={controller} /> : null}
      {section === 'payments' ? <PaymentsSettings controller={controller} /> : null}
    </section>
  );
}

function UsageView({
  organizationId,
  projectId,
  title,
}: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly title: 'AI' | 'Usage';
}): ReactElement {
  const billingWindow = useMemo(monthWindow, []);
  const scopeKey = `${organizationId}:${projectId}`;
  const [result, setResult] = useState<{
    readonly error?: string;
    readonly scopeKey: string;
    readonly usage?: UsageResponse;
  }>();

  useEffect(() => {
    const abort = new AbortController();
    void createControlPlaneClient(organizationId)
      .getUsageSummary(billingWindow, abort.signal)
      .then((response) => {
        if (!abort.signal.aborted) setResult({ scopeKey, usage: response });
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setResult({ error: 'Usage could not be loaded.', scopeKey });
        }
      });
    return () => {
      abort.abort();
    };
  }, [billingWindow, organizationId, scopeKey]);

  const usage = result?.scopeKey === scopeKey ? result.usage : undefined;
  const error = result?.scopeKey === scopeKey ? result.error : undefined;
  const projectCredits = usage?.usage.byProject.find((item) => item.projectId === projectId)?.credits
    ?? '0.0000';
  return (
    <section aria-label={`${title} usage`} className={styles.analytics}>
      <header>
        <p>{title === 'AI' ? 'MODEL USAGE' : 'CLOUD ACTIVITY'}</p>
        <h2>{title}</h2>
        <span>Current billing-window usage from the workspace usage API.</span>
      </header>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <div className={styles.metricGrid}>
        <article><span>Project usage</span><strong>{projectCredits} credits</strong></article>
        <article><span>Usage categories</span><strong>{usage?.usage.byCategory.length ?? 0}</strong></article>
        <article><span>Tracked runs</span><strong>{usage?.usage.byRun.length ?? 0}</strong></article>
      </div>
    </section>
  );
}

function AnalyticsView({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}): ReactElement {
  const scopeKey = `${organizationId}:${projectId}`;
  const [result, setResult] = useState<{
    readonly error?: string;
    readonly releases?: ReleasesResponse;
    readonly scopeKey: string;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    void createControlPlaneClient(organizationId)
      .listProjectReleases(projectId, undefined, abort.signal)
      .then((response) => {
        if (!abort.signal.aborted) setResult({ releases: response, scopeKey });
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setResult({ error: 'Release activity could not be loaded.', scopeKey });
        }
      });
    return () => {
      abort.abort();
    };
  }, [organizationId, projectId, scopeKey]);

  const releases = result?.scopeKey === scopeKey ? result.releases : undefined;
  const error = result?.scopeKey === scopeKey ? result.error : undefined;
  const production = releases?.items.filter((release) => release.activeProduction) ?? [];
  const deployments = releases?.items.flatMap((release) => release.deployments) ?? [];
  return (
    <section aria-label="Analytics overview" className={styles.analytics}>
      <header>
        <p>PROJECT ANALYTICS</p>
        <h2>Analytics</h2>
        <span>Production and release activity from this project's public release API.</span>
      </header>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <div className={styles.metricGrid}>
        <article><span>Releases</span><strong>{releases?.items.length ?? 0}</strong></article>
        <article><span>Production releases</span><strong>{production.length}</strong></article>
        <article><span>Deployments</span><strong>{deployments.length}</strong></article>
      </div>
      {releases !== undefined && releases.items.length === 0 ? (
        <div className={styles.moreEmptyInline}>
          <p>Publish the project to begin collecting production analytics.</p>
          <Link href={`/projects/${projectId}?view=releases`}>Open releases</Link>
        </div>
      ) : null}
    </section>
  );
}

function ConversationAction({
  button,
  description,
  icon,
  onConversationDraft,
  prompt,
  title,
}: {
  readonly button: string;
  readonly description: string;
  readonly icon: MoreSubview;
  readonly onConversationDraft: (content: string) => void;
  readonly prompt: string;
  readonly title: string;
}): ReactElement {
  return (
    <div className={styles.moreEmpty}>
      <span className={styles.moreEmptyIcon}><MoreIcon kind={icon} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      <button
        className="zapp-button zapp-button--primary"
        onClick={() => {
          onConversationDraft(prompt);
        }}
        type="button"
      >
        {button}
      </button>
    </div>
  );
}

export function MoreView({
  onConversationDraft,
  onRunCreated,
  onSubviewChange,
  organizationId,
  projectId,
  runId,
  subview,
}: {
  readonly onConversationDraft: (content: string) => void;
  readonly onRunCreated: (run: BuilderRun) => void;
  readonly onSubviewChange: (subview: MoreSubview) => void;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly subview: MoreSubview;
}): ReactElement {
  const [cloudSubview, setCloudSubview] = useState<CloudSubview>('overview');

  let content: ReactElement;
  switch (subview) {
    case 'analytics':
      content = <AnalyticsView organizationId={organizationId} projectId={projectId} />;
      break;
    case 'cloud':
      if (cloudSubview === 'logs') {
        content = <LogView organizationId={organizationId} projectId={projectId} />;
      } else if (cloudSubview === 'secrets') {
        content = <EmbeddedSettings projectId={projectId} section="secrets" />;
      } else if (cloudSubview === 'usage') {
        content = <UsageView organizationId={organizationId} projectId={projectId} title="Usage" />;
      } else {
        content = (
          <section aria-label="Cloud overview" className={styles.cloudOverview}>
            <header><p>CLOUD</p><h2>Cloud</h2><span>Configure project services and inspect runtime activity.</span></header>
            <div className={styles.cloudCards}>
              {cloudNavigation.slice(1).map(([id, label]) => (
                <button key={id} onClick={() => {
                  setCloudSubview(id);
                }} type="button">
                  <MoreIcon kind={id} />
                  <span><strong>{label}</strong><small>Open {label.toLowerCase()}</small></span>
                  <b aria-hidden="true">›</b>
                </button>
              ))}
            </div>
          </section>
        );
      }
      break;
    case 'ai':
      content = <UsageView organizationId={organizationId} projectId={projectId} title="AI" />;
      break;
    case 'mcp':
      content = (
        <ConversationAction
          button="Ask zapp to add an agent integration"
          description="Add a ChatGPT or Claude integration through the build conversation, then publish the project."
          icon="mcp"
          onConversationDraft={onConversationDraft}
          prompt="Add an agent integration for this project. Explain the publish and permission requirements before making changes."
          title="Agent integrations"
        />
      );
      break;
    case 'payments':
      content = <EmbeddedSettings projectId={projectId} section="payments" />;
      break;
    case 'connectors':
      content = <EmbeddedSettings projectId={projectId} section="integrations" />;
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
    case 'seo':
      content = (
        <ConversationAction
          button="Ask zapp to improve SEO"
          description="Audit page metadata, structured data, crawlability, and AI-search discoverability in the current project."
          icon="seo"
          onConversationDraft={onConversationDraft}
          prompt="Audit and improve this project's SEO and AI-search metadata. Review titles, descriptions, canonical URLs, robots directives, structured data, and social previews."
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
                onSubviewChange(id);
              }}
              role="tab"
              tabIndex={subview === id ? 0 : -1}
              type="button"
            >
              <MoreIcon kind={id} />{label}
            </button>
            {id === 'cloud' && subview === 'cloud' ? (
              <div aria-label="Cloud project views" className={styles.cloudNavigation} role="tablist">
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
                    <MoreIcon kind={cloudId} />{cloudLabel}
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
