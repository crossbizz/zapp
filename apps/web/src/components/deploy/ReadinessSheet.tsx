import type { ReactElement } from 'react';
import type { ReleaseReadinessData } from '../../lib/api';

const headings = { ready: 'Ready to deploy', warnings: 'Warnings found', blocked: 'Deployment blocked' } as const;

export function ReadinessSheet({ readiness, onAction, onContinue, onClose }: {
  readonly readiness: ReleaseReadinessData;
  readonly onAction: (findingId: string, action: 'fix' | 'review' | 'waive', reason?: string) => void;
  readonly onContinue: () => void;
  readonly onClose: () => void;
}): ReactElement {
  return <section aria-label="Deployment readiness" role="dialog"><h2>{headings[readiness.state]}</h2><ul>{readiness.findings.map((finding) => <li key={finding.id}><strong>{finding.title}</strong><p>{finding.detail}</p><button onClick={() => { const action = finding.action === 'fix_and_recheck' ? 'fix' : finding.action; const reason = action === 'waive' ? globalThis.prompt('Waiver reason')?.trim() : undefined; if (action === 'waive' && !reason) return; onAction(finding.id, action, reason); }} type="button">{finding.action === 'fix_and_recheck' ? 'Fix and recheck' : finding.action === 'review' ? 'Review' : 'Waive'}</button></li>)}</ul><div style={{ display: 'flex', gap: 8 }}><button onClick={onClose} type="button">Cancel</button><button disabled={readiness.state === 'blocked'} onClick={onContinue} type="button">Continue</button></div></section>;
}
