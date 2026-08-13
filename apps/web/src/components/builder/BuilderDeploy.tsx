'use client';

import { useEffect, useState, type ReactElement } from 'react';

import {
  createControlPlaneClient,
  type DeploymentPreviewData,
  type DeploymentProgressData,
} from '../../lib/api';
import { ConfirmDialog } from '../deploy/ConfirmDialog';
import { ReadinessSheet } from '../deploy/ReadinessSheet';
import { StageTimeline } from '../deploy/StageTimeline';
import { SuccessCard } from '../deploy/SuccessCard';

type DeploymentStep = 'confirm' | 'readiness' | 'success' | 'timeline';
type ReleaseStatus = 'approved' | 'candidate' | 'ready' | 'warnings';
type ReleaseReadiness = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getRelease']>
>['readiness'];

export function BuilderDeploy({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}): ReactElement {
  const [releaseId, setReleaseId] = useState<string>();
  const [releaseStatus, setReleaseStatus] = useState<ReleaseStatus>();
  const [step, setStep] = useState<DeploymentStep>();
  const [preview, setPreview] = useState<DeploymentPreviewData>();
  const [progress, setProgress] = useState<DeploymentProgressData>();
  const [readiness, setReadiness] = useState<ReleaseReadiness>();
  const [disposition, setDisposition] = useState<'preserve' | 'transfer' | 'reset'>();
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const discoverRelease = async (): Promise<void> => {
      try {
        const page = await createControlPlaneClient(organizationId).listProjectReleases(projectId);
        if (!active) return;
        const release = page.items.find(({ status: nextStatus }) => nextStatus === 'approved') ??
          page.items.find(({ status: nextStatus }) =>
            nextStatus === 'candidate' || nextStatus === 'ready' || nextStatus === 'warnings');
        if (release !== undefined) {
          setReleaseId(release.id);
          setReleaseStatus(release.status as ReleaseStatus);
          setStatus('');
          return;
        }
      } catch {
        if (active) setStatus('Deployment is unavailable until a release is ready.');
      }
      if (active) timer = setTimeout(() => { void discoverRelease(); }, 1_000);
    };
    void discoverRelease();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [organizationId, projectId]);

  async function open(): Promise<void> {
    if (releaseId === undefined) return;
    setStatus('Loading deployment confirmation…');
    try {
      const client = createControlPlaneClient(organizationId);
      const [detail, nextPreview] = await Promise.all([
        client.getRelease(releaseId),
        client.getDeploymentPreview(releaseId),
      ]);
      if (
        detail.release.projectId !== projectId ||
        !['approved', 'candidate', 'ready', 'warnings'].includes(detail.release.status)
      ) {
        throw new Error('Release is not deployable.');
      }
      setReleaseStatus(detail.release.status as ReleaseStatus);
      setReadiness(detail.readiness);
      setPreview(nextPreview);
      setStep('readiness');
      setStatus('');
    } catch {
      setStatus('Deployment confirmation could not be loaded.');
    }
  }

  async function continueAfterReadiness(): Promise<void> {
    if (releaseId === undefined) return;
    if (releaseStatus === 'approved') {
      setStep('confirm');
      return;
    }
    setStatus('Approving release…');
    try {
      const approved = await createControlPlaneClient(organizationId).approveRelease(releaseId);
      if (approved.release.status !== 'approved') throw new Error('Release was not approved.');
      setReleaseStatus('approved');
      setStep('confirm');
      setStatus('');
    } catch {
      setStatus('The release could not be approved.');
    }
  }

  async function confirm(): Promise<void> {
    if (releaseId === undefined || preview === undefined) return;
    setStatus('Starting deployment…');
    try {
      const client = createControlPlaneClient(organizationId);
      const started = await client.deployRelease(releaseId, {
        deploymentType: preview.deploymentType,
        ...(disposition === undefined ? {} : { dataDisposition: disposition }),
      });
      const nextProgress = await client.getDeployment(started.deploymentId);
      setProgress(nextProgress);
      setStep(nextProgress.terminalSuccess === null ? 'timeline' : 'success');
      setStatus('');
    } catch {
      setStatus('The deployment could not be started.');
    }
  }

  return (
    <>
      <button disabled={releaseId === undefined} onClick={() => { void open(); }} type="button">
        Deploy
      </button>
      <p aria-live="polite">{status}</p>
      {step === 'readiness' && readiness !== undefined ? (
        <ReadinessSheet
          onAction={() => { setStatus('Resolve the readiness finding before deployment.'); }}
          onClose={() => { setStep(undefined); }}
          onContinue={() => { void continueAfterReadiness(); }}
          readiness={readiness}
        />
      ) : null}
      {step === 'confirm' && preview !== undefined ? (
        <ConfirmDialog
          disposition={disposition}
          onBack={() => { setStep('readiness'); }}
          onConfirm={() => { void confirm(); }}
          onDisposition={setDisposition}
          preview={preview}
        />
      ) : null}
      {step === 'timeline' && progress !== undefined ? (
        <StageTimeline onAction={() => { setStatus('Deployment action requested.'); }} progress={progress} />
      ) : null}
      {step === 'success' && progress !== undefined ? <SuccessCard progress={progress} /> : null}
    </>
  );
}
