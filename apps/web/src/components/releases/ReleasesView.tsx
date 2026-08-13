'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type DeploymentPreviewData, type DeploymentProgressData, type MeResponse } from '../../lib/api';
import { organizationStorageKey, resolveOrganization } from '../../lib/session';
import { ConfirmDialog } from '../deploy/ConfirmDialog';
import { ReadinessSheet } from '../deploy/ReadinessSheet';
import { StageTimeline } from '../deploy/StageTimeline';
import { SuccessCard } from '../deploy/SuccessCard';

type Client = ReturnType<typeof createControlPlaneClient>;
type ReleasePage = Awaited<ReturnType<Client['listProjectReleases']>>;
type ReleaseDetail = Awaited<ReturnType<Client['getRelease']>>;
type Evidence = Awaited<ReturnType<Client['getReleaseEvidence']>>['evidence'];

function membershipFor(me: MeResponse) {
  return resolveOrganization(me.memberships, new URL(globalThis.location.href).searchParams.get('organization'), localStorage.getItem(organizationStorageKey(me.user.id))).membership;
}

export function ReleasesView({ projectId, releaseId }: { readonly projectId: string; readonly releaseId?: string }): ReactElement {
  const [organizationId, setOrganizationId] = useState<string>();
  const [role, setRole] = useState<'owner' | 'builder' | 'viewer'>();
  const [page, setPage] = useState<ReleasePage>();
  const [detail, setDetail] = useState<ReleaseDetail>();
  const [evidence, setEvidence] = useState<Evidence>();
  const [status, setStatus] = useState('Loading releases…');
  const [deployStep, setDeployStep] = useState<'readiness' | 'confirm' | 'timeline' | 'success'>();
  const [preview, setPreview] = useState<DeploymentPreviewData>();
  const [deployment, setDeployment] = useState<DeploymentProgressData>();
  const [dataDisposition, setDataDisposition] = useState<'preserve' | 'transfer' | 'reset'>();

  async function load(cursor?: string): Promise<void> {
    const me = await createControlPlaneClient().getMe();
    const membership = membershipFor(me);
    if (membership === undefined) throw new Error('Join an organization to view releases.');
    const client = createControlPlaneClient(membership.organization.id);
    setOrganizationId(membership.organization.id); setRole(membership.role);
    if (releaseId === undefined) setPage(await client.listProjectReleases(projectId, cursor));
    else {
      const [releaseDetail, releaseEvidence] = await Promise.all([client.getRelease(releaseId), client.getReleaseEvidence(releaseId)]);
      if (releaseDetail.release.projectId !== projectId) throw new Error('Release does not belong to this project.');
      setDetail(releaseDetail); setEvidence(releaseEvidence.evidence);
    }
    setStatus('');
  }

  useEffect(() => { let active = true; void load().catch(() => { if (active) setStatus('Releases could not be loaded.'); }); return () => { active = false; }; }, [projectId, releaseId]);

  useEffect(() => {
    if (organizationId === undefined || deployment === undefined || deployStep !== 'timeline' || deployment.status === 'failed') return;
    const interval = globalThis.setInterval(() => {
      void createControlPlaneClient(organizationId).getDeployment(deployment.deploymentId).then((next) => {
        setDeployment(next);
        if (next.terminalSuccess !== null) setDeployStep('success');
      }).catch(() => { setStatus('Deployment progress could not be refreshed.'); });
    }, 1500);
    return () => { globalThis.clearInterval(interval); };
  }, [deployStep, deployment, organizationId]);

  async function mutate(work: (client: Client) => Promise<unknown>, success: string): Promise<void> {
    if (organizationId === undefined) return; setStatus('Working…');
    try { await work(createControlPlaneClient(organizationId)); await load(); setStatus(success); }
    catch { setStatus('The release action could not be completed.'); }
  }

  async function openDeploy(): Promise<void> {
    if (organizationId === undefined || releaseId === undefined) return;
    setStatus('Loading deployment confirmation…');
    try { setPreview(await createControlPlaneClient(organizationId).getDeploymentPreview(releaseId)); setDeployStep('readiness'); setStatus(''); }
    catch { setStatus('Deployment confirmation could not be loaded.'); }
  }

  async function confirmDeploy(): Promise<void> {
    if (organizationId === undefined || releaseId === undefined || preview === undefined) return;
    setStatus('Starting deployment…');
    try {
      const client = createControlPlaneClient(organizationId);
      const started = await client.deployRelease(releaseId, { deploymentType: preview.deploymentType, ...(dataDisposition === undefined ? {} : { dataDisposition }) });
      const progress = await client.getDeployment(started.deploymentId);
      setDeployment(progress); setDeployStep(progress.terminalSuccess === null ? 'timeline' : 'success'); setStatus('');
    } catch { setStatus('The deployment could not be started.'); }
  }

  async function readinessAction(findingId: string, action: 'fix' | 'review' | 'waive', reason?: string): Promise<void> {
    if (organizationId === undefined || releaseId === undefined) return;
    await mutate((client) => client.runReadinessAction(releaseId, { findingId, action, ...(reason === undefined ? {} : { reason }) }), 'Readiness action started.');
    setDeployStep(undefined);
  }

  async function deploymentAction(action: 'retry' | 'fix' | 'ask', stage?: string): Promise<void> {
    if (organizationId === undefined || deployment === undefined) return;
    await mutate((client) => client.runDeploymentAction(deployment.deploymentId, { action, ...(stage === undefined ? {} : { stage }), ...(action === 'ask' ? { prompt: 'Explain the failure and recommend the safest next step.' } : {}) }), 'Deployment action started.');
  }

  if (releaseId === undefined) return <main style={{ fontFamily: 'system-ui', margin: '0 auto', maxWidth: 960, padding: 32 }}><Link href={`/projects/${projectId}`}>← Back to project</Link><h1>Releases</h1><p aria-live="polite">{status}</p><section aria-label="Release history">{page?.items.map((release) => <article key={release.id} style={{ border: '1px solid #ddd', margin: '12px 0', padding: 16 }}><h2><Link href={`/projects/${projectId}/releases/${release.id}`}>{release.id}</Link></h2><p>{release.status} · {release.supportLevel} · commit <code>{release.commitSha.slice(0, 7)}</code></p><p>Created by {release.createdBy} at <time dateTime={release.createdAt}>{new Date(release.createdAt).toLocaleString()}</time></p>{release.activeProduction ? <strong>Active in production</strong> : null}<p>{release.deployments.length} deployment{release.deployments.length === 1 ? '' : 's'}</p></article>)}</section>{page?.nextCursor === null || page?.nextCursor === undefined ? null : <button onClick={() => { void load(page.nextCursor ?? undefined); }} type="button">Next releases</button>}<h2>Healthy rollback targets</h2><ul>{page?.rollbackTargets.map((target) => <li key={target.id}>{target.releaseId} · {target.provider} · <code>{target.commitSha.slice(0, 7)}</code></li>)}</ul></main>;

  const canMutate = role === 'owner' || role === 'builder';
  const sections = evidence === undefined ? [] : (['build', 'typecheck', 'tests', 'browser_tests', 'security', 'migration', 'preview', 'rollback'] as const).map((name) => ({ name, block: evidence[name] }));
  return <main style={{ fontFamily: 'system-ui', margin: '0 auto', maxWidth: 960, padding: 32 }}><Link href={`/projects/${projectId}/releases`}>← Release history</Link><h1>Release {releaseId}</h1><p aria-live="polite">{status}</p>{detail === undefined ? null : <><p>Status: <strong>{detail.release.status}</strong> · commit <code>{detail.release.commitSha}</code></p><p>Readiness: <strong>{detail.readiness.state}</strong></p><ul>{detail.readiness.findings.map((finding) => <li key={finding.id}>{finding.severity}: {finding.title} — {finding.detail}</li>)}</ul>{canMutate ? <div style={{ display: 'flex', gap: 8 }}><button disabled={detail.readiness.state === 'blocked' || detail.release.status === 'approved'} onClick={() => { void mutate((client) => client.approveRelease(releaseId), 'Release approved.'); }} type="button">Approve release</button><button disabled={detail.release.status !== 'approved'} onClick={() => { void openDeploy(); }} type="button">Deploy</button><button onClick={() => { void mutate((client) => client.forkRelease(releaseId), 'Repair branch created.'); }} type="button">Fork to repair</button></div> : null}</>}
    {deployStep === 'readiness' && detail !== undefined ? <ReadinessSheet onAction={(findingId, action, reason) => { void readinessAction(findingId, action, reason); }} onClose={() => { setDeployStep(undefined); }} onContinue={() => { setDeployStep('confirm'); }} readiness={detail.readiness} /> : null}
    {deployStep === 'confirm' && preview !== undefined ? <ConfirmDialog disposition={dataDisposition} onBack={() => { setDeployStep('readiness'); }} onConfirm={() => { void confirmDeploy(); }} onDisposition={setDataDisposition} preview={preview} /> : null}
    {deployStep === 'timeline' && deployment !== undefined ? <StageTimeline onAction={(action, stage) => { void deploymentAction(action, stage); }} progress={deployment} /> : null}
    {deployStep === 'success' && deployment !== undefined ? <SuccessCard progress={deployment} /> : null}
    {evidence === undefined ? null : <section aria-label="Evidence report"><h2>Evidence report</h2><p>Specification v{evidence.specification_version}</p>{sections.map(({ name, block }) => <section key={name}><h3>{name.replaceAll('_', ' ')}</h3><strong>{block.status}</strong><ul>{block.gates.map((gate) => <li key={gate.gateId}>{gate.gateId}: {gate.status}{gate.evidenceArtifactIds.map((artifactId) => <span key={artifactId}> · <a href={`/v1/releases/${releaseId}/evidence#${encodeURIComponent(artifactId)}`}>{artifactId}</a></span>)}</li>)}</ul></section>)}<h3>Acceptance criteria</h3><table><thead><tr><th>Criterion</th><th>Result</th><th>Evidence</th><th>Comments</th></tr></thead><tbody>{evidence.criteria.map((criterion) => <tr data-result={criterion.result} key={criterion.criterionId}><th>{criterion.criterionId}</th><td><strong>{criterion.result}</strong></td><td>{criterion.evidenceArtifactIds.length === 0 ? 'None' : criterion.evidenceArtifactIds.join(', ')}</td><td>{criterion.verifierComments.length === 0 ? 'None' : criterion.verifierComments.join('; ')}</td></tr>)}</tbody></table><h3>Known risks</h3><ul>{evidence.known_risks.length === 0 ? <li>None</li> : evidence.known_risks.map((risk) => <li key={risk.id}>{risk.detail}</li>)}</ul></section>}
  </main>;
}
