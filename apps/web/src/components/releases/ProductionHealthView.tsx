'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactElement } from 'react';

import { useAppSession } from '../../hooks/useAppSession';
import {
  createControlPlaneClient,
  type ProductionHistoryData,
  type RollbackPreviewData,
} from '../../lib/api';
import { AppShell } from '../shell/AppShell';
import { PageFrame } from '../shell/PageFrame';

export function ProductionHealthView({ projectId }: { readonly projectId: string }): ReactElement {
  const pathname = usePathname();
  const embedded = pathname === `/projects/${projectId}`;
  const appSession = useAppSession();
  const organizationId = appSession.organizationId;
  const [history, setHistory] = useState<ProductionHistoryData>();
  const [target, setTarget] = useState<string>();
  const [preview, setPreview] = useState<RollbackPreviewData>();
  const [reason, setReason] = useState('Restore the previous healthy production release.');
  const [status, setStatus] = useState('Loading production health…');

  async function load(): Promise<void> {
    if (organizationId === undefined) {
      throw new Error('Join an organization to view production health.');
    }
    const data = await createControlPlaneClient(organizationId).getProductionHistory(projectId);
    setHistory(data);
    setTarget(data.healthyTargets[0]?.id);
    setStatus('');
  }

  useEffect(() => {
    if (organizationId === undefined) return;
    setStatus('Loading production health…');
    void load().catch(() => {
      setStatus('Production health could not be loaded.');
    });
  }, [organizationId, projectId]);

  async function previewRollback(): Promise<void> {
    const current = history?.deployments[0];
    if (organizationId === undefined || current === undefined || target === undefined) return;
    setStatus('Checking rollback compatibility…');
    try {
      setPreview(
        await createControlPlaneClient(organizationId).getRollbackPreview(
          current.releaseId,
          target,
        ),
      );
      setStatus('');
    } catch {
      setStatus('Rollback compatibility could not be checked.');
    }
  }

  async function rollback(): Promise<void> {
    const current = history?.deployments[0];
    if (organizationId === undefined || current === undefined || preview === undefined) return;
    setStatus('Starting rollback…');
    try {
      await createControlPlaneClient(organizationId).rollbackRelease(current.releaseId, {
        toDeploymentId: preview.targetDeploymentId,
        reason,
      });
      setStatus('Rollback started.');
    } catch {
      setStatus('Rollback could not be started.');
    }
  }

  async function createFix(releaseId: string): Promise<void> {
    if (organizationId === undefined) return;
    setStatus('Creating Fix run…');
    try {
      await createControlPlaneClient(organizationId).forkRelease(releaseId);
      setStatus('Fix run created.');
    } catch {
      setStatus('Fix run could not be created.');
    }
  }

  const sessionMessage =
    appSession.snapshot.status === 'loading'
      ? 'Loading production health…'
      : appSession.snapshot.status === 'empty'
        ? 'Join an organization to view production health.'
        : appSession.snapshot.status === 'error'
          ? 'Your workspace could not be loaded.'
          : undefined;
  const latestHealth = history?.health[0];
  const content = (
    <PageFrame
      actions={(
        <>
          <Link href={`/projects/${projectId}`}>Back to project</Link>
          <Link href={`/projects/${projectId}/releases`}>Releases</Link>
        </>
      )}
      description="Monitor production evidence and make guarded rollback decisions."
      eyebrow="Production operations"
      title="Production health"
    >
      {sessionMessage === undefined ? (
        <>
          <p aria-live="polite" className="zapp-page-status">{status}</p>
          {latestHealth === undefined ? (
            <section className="zapp-page-card">
              <p>No production health result yet.</p>
            </section>
          ) : (
            <section aria-label="Production health summary" className="zapp-page-card zapp-page-card--emphasis">
              <h2>{latestHealth.status === 'healthy' ? 'Healthy' : 'Health checks failed'}</h2>
              <p>
                Endpoint: {latestHealth.result.production.healthEndpoint.status} · Error rate:{' '}
                {latestHealth.result.production.errorRate.status} · Smoke:{' '}
                {latestHealth.result.production.smoke.status}
              </p>
              <p>Web vitals and request details are available from linked Grafana/Faro monitoring annotations.</p>
            </section>
          )}
          <div className="zapp-page-grid">
            <section aria-label="Synthetic check history" className="zapp-page-card">
              <h2>Synthetic checks</h2>
              {history?.synthetics.length === 0 ? <p>No synthetic checks yet.</p> : null}
              <ol className="zapp-page-list">
                {history?.synthetics.map((check) => (
                  <li key={check.id}>
                    <time dateTime={check.completedAt}>{new Date(check.completedAt).toLocaleString()}</time>{' '}
                    · {check.status} · {check.summary}
                    {check.status === 'failed' ? (
                      <button onClick={() => void createFix(check.releaseId)} type="button">Create Fix run</button>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
            <section aria-label="Release annotations" className="zapp-page-card">
              <h2>Release annotations</h2>
              {history?.annotations.length === 0 ? <p>No release annotations yet.</p> : null}
              <ol className="zapp-page-list">
                {history?.annotations.map((annotation) => (
                  <li key={annotation.id}>
                    <time dateTime={annotation.occurredAt}>{new Date(annotation.occurredAt).toLocaleString()}</time>{' '}
                    · {annotation.kind} · <a href={annotation.link}>{annotation.provider}</a>
                  </li>
                ))}
              </ol>
            </section>
          </div>
          <section aria-label="Rollback" className="zapp-page-card">
            <h2>Rollback</h2>
            <div className="zapp-page-form-row">
              <label className="zapp-page-field">
                Healthy target
                <select onChange={(event) => { setTarget(event.target.value); }} value={target}>
                  <option value="">Select a target</option>
                  {history?.healthyTargets.map((item) => (
                    <option key={item.id} value={item.id}>{item.releaseId} · {item.commitSha.slice(0, 7)}</option>
                  ))}
                </select>
              </label>
              <button disabled={!target} onClick={() => void previewRollback()} type="button">Preview rollback</button>
            </div>
            {preview === undefined ? null : (
              <div className="zapp-page-card">
                <h3>Database state: {preview.databaseState}</h3>
                {preview.databaseState === 'incompatible' ? (
                  <p>Rollback is blocked because the target database state is incompatible.</p>
                ) : preview.databaseState === 'requires_compensation' ? (
                  <p>A reviewed compensation plan is required before rollback. This does not imply the database has been rolled back.</p>
                ) : (
                  <p>The database state is compatible.</p>
                )}
                <div className="zapp-page-form-row">
                  <label className="zapp-page-field">
                    Reason
                    <input onChange={(event) => { setReason(event.target.value); }} value={reason} />
                  </label>
                  <button
                    className="zapp-page-button--primary"
                    disabled={!preview.allowed || reason.trim().length === 0}
                    onClick={() => void rollback()}
                    type="button"
                  >
                    Start rollback
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      ) : (
        <p
          className={appSession.snapshot.status === 'loading' ? 'zapp-page-status' : 'zapp-page-alert'}
          role={appSession.snapshot.status === 'loading' ? 'status' : 'alert'}
        >
          {sessionMessage}
        </p>
      )}
    </PageFrame>
  );

  if (embedded || appSession.snapshot.status !== 'ready') return content;
  const readySession = appSession.snapshot;
  return (
    <AppShell
      activePath="/projects"
      invalidOrganization={readySession.invalidOrganization}
      onSignOut={() => appSession.signOut(readySession.membership.organization.id)}
      onSwitchOrganization={appSession.switchOrganization}
      session={readySession}
    >
      {content}
    </AppShell>
  );
}
