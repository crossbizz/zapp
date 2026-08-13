'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactElement } from 'react';
import { createControlPlaneClient, type MeResponse, type ProductionHistoryData, type RollbackPreviewData } from '../../lib/api';
import { organizationStorageKey, resolveOrganization } from '../../lib/session';

function membershipFor(me: MeResponse) { return resolveOrganization(me.memberships, new URL(globalThis.location.href).searchParams.get('organization'), localStorage.getItem(organizationStorageKey(me.user.id))).membership; }

export function ProductionHealthView({ projectId }: { readonly projectId: string }): ReactElement {
  const [organizationId, setOrganizationId] = useState<string>();
  const [history, setHistory] = useState<ProductionHistoryData>();
  const [target, setTarget] = useState<string>();
  const [preview, setPreview] = useState<RollbackPreviewData>();
  const [reason, setReason] = useState('Restore the previous healthy production release.');
  const [status, setStatus] = useState('Loading production health…');

  async function load(): Promise<void> {
    const me = await createControlPlaneClient().getMe(); const membership = membershipFor(me);
    if (membership === undefined) throw new Error('Join an organization to view production health.');
    const data = await createControlPlaneClient(membership.organization.id).getProductionHistory(projectId);
    setOrganizationId(membership.organization.id); setHistory(data); setTarget(data.healthyTargets[0]?.id); setStatus('');
  }
  useEffect(() => { void load().catch(() => { setStatus('Production health could not be loaded.'); }); }, [projectId]);

  async function previewRollback(): Promise<void> {
    const current = history?.deployments[0]; if (organizationId === undefined || current === undefined || target === undefined) return;
    setStatus('Checking rollback compatibility…');
    try { setPreview(await createControlPlaneClient(organizationId).getRollbackPreview(current.releaseId, target)); setStatus(''); }
    catch { setStatus('Rollback compatibility could not be checked.'); }
  }
  async function rollback(): Promise<void> {
    const current = history?.deployments[0]; if (organizationId === undefined || current === undefined || preview === undefined) return;
    setStatus('Starting rollback…');
    try { await createControlPlaneClient(organizationId).rollbackRelease(current.releaseId, { toDeploymentId: preview.targetDeploymentId, reason }); setStatus('Rollback started.'); }
    catch { setStatus('Rollback could not be started.'); }
  }
  async function createFix(releaseId: string): Promise<void> {
    if (organizationId === undefined) return; setStatus('Creating Fix run…');
    try { await createControlPlaneClient(organizationId).forkRelease(releaseId); setStatus('Fix run created.'); } catch { setStatus('Fix run could not be created.'); }
  }

  const latestHealth = history?.health[0];
  return <main style={{ fontFamily: 'system-ui', margin: '0 auto', maxWidth: 960, padding: 32 }}><Link href={`/projects/${projectId}`}>← Back to project</Link><h1>Production health</h1><p aria-live="polite">{status}</p>{latestHealth === undefined ? <p>No production health result yet.</p> : <section aria-label="Production health summary"><h2>{latestHealth.status === 'healthy' ? 'Healthy' : 'Health checks failed'}</h2><p>Endpoint: {latestHealth.result.production.healthEndpoint.status} · Error rate: {latestHealth.result.production.errorRate.status} · Smoke: {latestHealth.result.production.smoke.status}</p><p>Web vitals and request details are available from linked Grafana/Faro monitoring annotations.</p></section>}<section aria-label="Synthetic check history"><h2>Synthetic checks</h2><ol>{history?.synthetics.map((check) => <li key={check.id}><time dateTime={check.completedAt}>{new Date(check.completedAt).toLocaleString()}</time> · {check.status} · {check.summary}{check.status === 'failed' ? <button onClick={() => { void createFix(check.releaseId); }} type="button">Create Fix run</button> : null}</li>)}</ol></section><section aria-label="Release annotations"><h2>Release annotations</h2><ol>{history?.annotations.map((annotation) => <li key={annotation.id}><time dateTime={annotation.occurredAt}>{new Date(annotation.occurredAt).toLocaleString()}</time> · {annotation.kind} · <a href={annotation.link}>{annotation.provider}</a></li>)}</ol></section><section aria-label="Rollback"><h2>Rollback</h2><label>Healthy target<select onChange={(event) => { setTarget(event.target.value); }} value={target}><option value="">Select a target</option>{history?.healthyTargets.map((item) => <option key={item.id} value={item.id}>{item.releaseId} · {item.commitSha.slice(0, 7)}</option>)}</select></label><button disabled={!target} onClick={() => { void previewRollback(); }} type="button">Preview rollback</button>{preview === undefined ? null : <div><h3>Database state: {preview.databaseState}</h3>{preview.databaseState === 'incompatible' ? <p>Rollback is blocked because the target database state is incompatible.</p> : preview.databaseState === 'requires_compensation' ? <p>A reviewed compensation plan is required before rollback. This does not imply the database has been rolled back.</p> : <p>The database state is compatible.</p>}<label>Reason<input onChange={(event) => { setReason(event.target.value); }} value={reason} /></label><button disabled={!preview.allowed || reason.trim().length === 0} onClick={() => { void rollback(); }} type="button">Start rollback</button></div>}</section></main>;
}
