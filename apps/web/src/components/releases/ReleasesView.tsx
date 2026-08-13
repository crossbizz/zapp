'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactElement } from 'react';

import { useAppSession } from '../../hooks/useAppSession';
import {
  createControlPlaneClient,
  type DeploymentPreviewData,
  type DeploymentProgressData,
} from '../../lib/api';
import { ConfirmDialog } from '../deploy/ConfirmDialog';
import { ReadinessSheet } from '../deploy/ReadinessSheet';
import { StageTimeline } from '../deploy/StageTimeline';
import { SuccessCard } from '../deploy/SuccessCard';
import { AppShell } from '../shell/AppShell';
import { PageFrame } from '../shell/PageFrame';

type Client = ReturnType<typeof createControlPlaneClient>;
type ReleasePage = Awaited<ReturnType<Client['listProjectReleases']>>;
type ReleaseDetail = Awaited<ReturnType<Client['getRelease']>>;
type Evidence = Awaited<ReturnType<Client['getReleaseEvidence']>>['evidence'];

export interface ReleasesViewProps {
  readonly projectId: string;
  readonly releaseId?: string;
}

export function ReleasesView({ projectId, releaseId }: ReleasesViewProps): ReactElement {
  const pathname = usePathname();
  const embedded = pathname === `/projects/${projectId}`;
  const appSession = useAppSession();
  const organizationId = appSession.organizationId;
  const role = appSession.membership?.role;
  const [page, setPage] = useState<ReleasePage>();
  const [detail, setDetail] = useState<ReleaseDetail>();
  const [evidence, setEvidence] = useState<Evidence>();
  const [status, setStatus] = useState('Loading releases…');
  const [deployStep, setDeployStep] = useState<
    'readiness' | 'confirm' | 'timeline' | 'success'
  >();
  const [preview, setPreview] = useState<DeploymentPreviewData>();
  const [deployment, setDeployment] = useState<DeploymentProgressData>();
  const [dataDisposition, setDataDisposition] = useState<'preserve' | 'transfer' | 'reset'>();

  async function load(cursor?: string): Promise<void> {
    if (organizationId === undefined) throw new Error('Join an organization to view releases.');
    const client = createControlPlaneClient(organizationId);
    if (releaseId === undefined) {
      setPage(await client.listProjectReleases(projectId, cursor));
    } else {
      const [releaseDetail, releaseEvidence] = await Promise.all([
        client.getRelease(releaseId),
        client.getReleaseEvidence(releaseId),
      ]);
      if (releaseDetail.release.projectId !== projectId) {
        throw new Error('Release does not belong to this project.');
      }
      setDetail(releaseDetail);
      setEvidence(releaseEvidence.evidence);
    }
    setStatus('');
  }

  useEffect(() => {
    if (organizationId === undefined) return;
    let active = true;
    setStatus('Loading releases…');
    void load().catch(() => {
      if (active) setStatus('Releases could not be loaded.');
    });
    return () => {
      active = false;
    };
  }, [organizationId, projectId, releaseId]);

  useEffect(() => {
    if (
      organizationId === undefined ||
      deployment === undefined ||
      deployStep !== 'timeline' ||
      deployment.status === 'failed'
    ) {
      return;
    }
    const interval = globalThis.setInterval(() => {
      void createControlPlaneClient(organizationId)
        .getDeployment(deployment.deploymentId)
        .then((next) => {
          setDeployment(next);
          if (next.terminalSuccess !== null) setDeployStep('success');
        })
        .catch(() => {
          setStatus('Deployment progress could not be refreshed.');
        });
    }, 1500);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, [deployStep, deployment, organizationId]);

  async function mutate(
    work: (client: Client) => Promise<unknown>,
    success: string,
  ): Promise<void> {
    if (organizationId === undefined) return;
    setStatus('Working…');
    try {
      await work(createControlPlaneClient(organizationId));
      await load();
      setStatus(success);
    } catch {
      setStatus('The release action could not be completed.');
    }
  }

  async function openDeploy(): Promise<void> {
    if (organizationId === undefined || releaseId === undefined) return;
    setStatus('Loading deployment confirmation…');
    try {
      setPreview(
        await createControlPlaneClient(organizationId).getDeploymentPreview(releaseId),
      );
      setDeployStep('readiness');
      setStatus('');
    } catch {
      setStatus('Deployment confirmation could not be loaded.');
    }
  }

  async function confirmDeploy(): Promise<void> {
    if (organizationId === undefined || releaseId === undefined || preview === undefined) return;
    setStatus('Starting deployment…');
    try {
      const client = createControlPlaneClient(organizationId);
      const started = await client.deployRelease(releaseId, {
        deploymentType: preview.deploymentType,
        ...(dataDisposition === undefined ? {} : { dataDisposition }),
      });
      const progress = await client.getDeployment(started.deploymentId);
      setDeployment(progress);
      setDeployStep(progress.terminalSuccess === null ? 'timeline' : 'success');
      setStatus('');
    } catch {
      setStatus('The deployment could not be started.');
    }
  }

  async function readinessAction(
    findingId: string,
    action: 'fix' | 'review' | 'waive',
    reason?: string,
  ): Promise<void> {
    if (organizationId === undefined || releaseId === undefined) return;
    await mutate(
      (client) =>
        client.runReadinessAction(releaseId, {
          findingId,
          action,
          ...(reason === undefined ? {} : { reason }),
        }),
      'Readiness action started.',
    );
    setDeployStep(undefined);
  }

  async function deploymentAction(
    action: 'retry' | 'fix' | 'ask',
    stage?: string,
  ): Promise<void> {
    if (organizationId === undefined || deployment === undefined) return;
    await mutate(
      (client) =>
        client.runDeploymentAction(deployment.deploymentId, {
          action,
          ...(stage === undefined ? {} : { stage }),
          ...(action === 'ask'
            ? { prompt: 'Explain the failure and recommend the safest next step.' }
            : {}),
        }),
      'Deployment action started.',
    );
  }

  const sessionMessage =
    appSession.snapshot.status === 'loading'
      ? 'Loading releases…'
      : appSession.snapshot.status === 'empty'
        ? 'Join an organization to view releases.'
        : appSession.snapshot.status === 'error'
          ? 'Your workspace could not be loaded.'
          : undefined;

  const actions = releaseId === undefined ? (
    <>
      <Link href={`/projects/${projectId}`}>Back to project</Link>
      <Link href={`/projects/${projectId}/health`}>Production health</Link>
    </>
  ) : (
    <Link href={`/projects/${projectId}/releases`}>Release history</Link>
  );

  let content: ReactElement;
  if (sessionMessage !== undefined) {
    content = (
      <PageFrame title={releaseId === undefined ? 'Releases' : `Release ${releaseId}`}>
        <p
          className={appSession.snapshot.status === 'loading' ? 'zapp-page-status' : 'zapp-page-alert'}
          role={appSession.snapshot.status === 'loading' ? 'status' : 'alert'}
        >
          {sessionMessage}
        </p>
      </PageFrame>
    );
  } else if (releaseId === undefined) {
    content = (
      <PageFrame
        actions={actions}
        description="Review release evidence, deployment readiness, and production history."
        eyebrow="Ship with confidence"
        title="Releases"
      >
        <p aria-live="polite" className="zapp-page-status">{status}</p>
        <section aria-label="Release history">
          {page?.items.length === 0 ? (
            <div className="zapp-page-card"><p>No releases yet.</p></div>
          ) : null}
          <div className="zapp-page-list">
            {page?.items.map((release) => (
              <article key={release.id}>
                <h2><Link href={`/projects/${projectId}/releases/${release.id}`}>{release.id}</Link></h2>
                <p>
                  {release.status} · {release.supportLevel} · commit{' '}
                  <code>{release.commitSha.slice(0, 7)}</code>
                </p>
                <p>
                  Created by {release.createdBy} at{' '}
                  <time dateTime={release.createdAt}>
                    {new Date(release.createdAt).toLocaleString()}
                  </time>
                </p>
                {release.activeProduction ? <strong>Active in production</strong> : null}
                <p>{release.deployments.length} deployment{release.deployments.length === 1 ? '' : 's'}</p>
              </article>
            ))}
          </div>
        </section>
        {page?.nextCursor === null || page?.nextCursor === undefined ? null : (
          <button onClick={() => void load(page.nextCursor ?? undefined)} type="button">
            Next releases
          </button>
        )}
        <section className="zapp-page-card">
          <h2>Healthy rollback targets</h2>
          {page?.rollbackTargets.length === 0 ? <p>No healthy rollback targets yet.</p> : null}
          <ul>
            {page?.rollbackTargets.map((target) => (
              <li key={target.id}>
                {target.releaseId} · {target.provider} · <code>{target.commitSha.slice(0, 7)}</code>
              </li>
            ))}
          </ul>
        </section>
      </PageFrame>
    );
  } else {
    const canMutate = role === 'owner' || role === 'builder';
    const sections = evidence === undefined
      ? []
      : (['build', 'typecheck', 'tests', 'browser_tests', 'security', 'migration', 'preview', 'rollback'] as const).map(
          (name) => ({ name, block: evidence[name] }),
        );
    content = (
      <PageFrame
        actions={actions}
        description="Inspect readiness, evidence, and deployment controls before production changes."
        eyebrow="Release control"
        title={`Release ${releaseId}`}
      >
        <p aria-live="polite" className="zapp-page-status">{status}</p>
        {detail === undefined ? null : (
          <section className="zapp-page-card zapp-page-card--emphasis">
            <p>
              Status: <strong>{detail.release.status}</strong> · commit{' '}
              <code>{detail.release.commitSha}</code>
            </p>
            <p>Readiness: <strong>{detail.readiness.state}</strong></p>
            <ul>
              {detail.readiness.findings.map((finding) => (
                <li key={finding.id}>
                  {finding.severity}: {finding.title} — {finding.detail}
                </li>
              ))}
            </ul>
            {canMutate ? (
              <div className="zapp-page-button-row">
                <button
                  disabled={detail.readiness.state === 'blocked' || detail.release.status === 'approved'}
                  onClick={() => void mutate((client) => client.approveRelease(releaseId), 'Release approved.')}
                  type="button"
                >
                  Approve release
                </button>
                <button
                  className="zapp-page-button--primary"
                  disabled={detail.release.status !== 'approved'}
                  onClick={() => void openDeploy()}
                  type="button"
                >
                  Deploy
                </button>
                <button
                  onClick={() => void mutate((client) => client.forkRelease(releaseId), 'Repair branch created.')}
                  type="button"
                >
                  Fork to repair
                </button>
              </div>
            ) : null}
          </section>
        )}
        {deployStep === 'readiness' && detail !== undefined ? (
          <ReadinessSheet
            onAction={(findingId, action, reason) => void readinessAction(findingId, action, reason)}
            onClose={() => { setDeployStep(undefined); }}
            onContinue={() => { setDeployStep('confirm'); }}
            readiness={detail.readiness}
          />
        ) : null}
        {deployStep === 'confirm' && preview !== undefined ? (
          <ConfirmDialog
            disposition={dataDisposition}
            onBack={() => { setDeployStep('readiness'); }}
            onConfirm={() => void confirmDeploy()}
            onDisposition={setDataDisposition}
            preview={preview}
          />
        ) : null}
        {deployStep === 'timeline' && deployment !== undefined ? (
          <StageTimeline
            onAction={(action, stage) => void deploymentAction(action, stage)}
            progress={deployment}
          />
        ) : null}
        {deployStep === 'success' && deployment !== undefined ? (
          <SuccessCard progress={deployment} />
        ) : null}
        {evidence === undefined ? null : (
          <section aria-label="Evidence report" className="zapp-page-card">
            <h2>Evidence report</h2>
            <p>Specification v{evidence.specification_version}</p>
            <div className="zapp-page-grid">
              {sections.map(({ name, block }) => (
                <section className="zapp-page-card" key={name}>
                  <h3>{name.replaceAll('_', ' ')}</h3>
                  <strong>{block.status}</strong>
                  <ul>
                    {block.gates.map((gate) => (
                      <li key={gate.gateId}>
                        {gate.gateId}: {gate.status}
                        {gate.evidenceArtifactIds.map((artifactId) => (
                          <span key={artifactId}>
                            {' '}· <a href={`/v1/releases/${releaseId}/evidence#${encodeURIComponent(artifactId)}`}>{artifactId}</a>
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <h3>Acceptance criteria</h3>
            <table className="zapp-page-table">
              <thead><tr><th>Criterion</th><th>Result</th><th>Evidence</th><th>Comments</th></tr></thead>
              <tbody>
                {evidence.criteria.map((criterion) => (
                  <tr data-result={criterion.result} key={criterion.criterionId}>
                    <th>{criterion.criterionId}</th>
                    <td><strong>{criterion.result}</strong></td>
                    <td>{criterion.evidenceArtifactIds.length === 0 ? 'None' : criterion.evidenceArtifactIds.join(', ')}</td>
                    <td>{criterion.verifierComments.length === 0 ? 'None' : criterion.verifierComments.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>Known risks</h3>
            <ul>{evidence.known_risks.length === 0 ? <li>None</li> : evidence.known_risks.map((risk) => <li key={risk.id}>{risk.detail}</li>)}</ul>
          </section>
        )}
      </PageFrame>
    );
  }

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
