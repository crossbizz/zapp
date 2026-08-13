import type { ReactElement } from 'react';
import type { DeploymentProgressData } from '../../lib/api';

const stages = ['readiness_check', 'build_artifact', 'configure_secrets', 'apply_migrations', 'provision_runtime', 'start_services', 'production_health_check', 'go_live'] as const;

export function StageTimeline({ progress, onAction }: { readonly progress: DeploymentProgressData; readonly onAction: (action: 'retry' | 'fix' | 'ask', stage?: string) => void }): ReactElement {
  const byStage = new Map(progress.events.map((event) => [event.stage, event]));
  const failed = [...progress.events].reverse().find((event) => event.status === 'failed');
  return <section aria-label="Deployment timeline"><h2>Deploying</h2>{failed === undefined ? null : <p><strong>Production unaffected.</strong> The previous release remains active.</p>}<ol>{stages.map((stage) => { const event = byStage.get(stage); return <li key={stage}><strong>{stage.replaceAll('_', ' ')}</strong> — {event?.status ?? 'pending'}{event === undefined ? null : <> · {(event.elapsedMs / 1000).toFixed(1)}s · {event.summary}{event.evidenceArtifactId === null ? null : <> · Evidence {event.evidenceArtifactId}</>}</>}</li>; })}</ol>{failed === undefined ? null : <div><button onClick={() => { onAction('retry', failed.stage); }} type="button">Retry stage-safe</button><button onClick={() => { onAction('fix', failed.stage); }} type="button">Fix automatically</button><button onClick={() => { onAction('ask', failed.stage); }} type="button">Ask agent</button></div>}</section>;
}
