import type { ReactElement } from 'react';
import type { DeploymentProgressData } from '../../lib/api';

export function SuccessCard({ progress }: { readonly progress: DeploymentProgressData }): ReactElement {
  const success = progress.terminalSuccess;
  if (success === null) throw new Error('SuccessCard requires terminal success');
  return <section aria-label="Deployment succeeded"><h2>Deployment succeeded</h2><p><a href={success.permanentUrl}>{success.permanentUrl}</a> <button onClick={() => { void navigator.clipboard.writeText(success.permanentUrl); }} type="button">Copy URL</button></p><p>Release {success.release.id} · commit <code>{success.release.commitSha}</code></p><p>Health: {success.productionHealth.status}</p><p><a href={success.evidence.statusLink}>Evidence</a> · <a href={success.monitoring.faroAppLink}>Faro</a> · <a href={success.monitoring.posthogAnnotationLink}>PostHog</a></p><p><a href={success.customDomainAction.href}>Add custom domain</a></p>{success.previousHealthyRelease === null ? null : <p><a href={success.previousHealthyRelease.rollbackAction.href}>Rollback to {success.previousHealthyRelease.releaseId}</a></p>}<p>{success.previewChanges.note}</p></section>;
}
