'use client';

import type { ConversationCard } from '@zapp/api-client';
import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type RunPlanData } from '../../lib/api';

type PlanCard = Extract<ConversationCard, { kind: 'plan' }>;

export function PlanReviewCard({ card, organizationId, runId }: { readonly card: PlanCard; readonly organizationId: string; readonly runId: string }): ReactElement {
  const client = createControlPlaneClient(organizationId);
  const [data, setData] = useState<RunPlanData>();
  const [changes, setChanges] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void client.getRunPlan(runId, card.artifactId, controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setStatus('Plan could not be loaded.'); });
    return () => { controller.abort(); };
  }, [card.artifactId, runId]);
  if (data === undefined) return <p role="status">{status || 'Loading implementation plan…'}</p>;
  return <article aria-label="Plan review" className="zapp-conversation-card">
    <h3>Implementation plan</h3><p>{data.plan.phaseCount} phases · {data.plan.taskCount} tasks</p>
    {data.plan.phases.map((phase) => <details key={phase.id}><summary>{phase.title} · {phase.acceptanceCriteria.length} acceptance criteria{phase.optional ? ' · Optional' : ''}</summary>
      <ul>{data.plan.tasks.filter((task) => task.phaseId === phase.id).map((task) => <li key={task.id}>{task.title} <span>{task.riskLevel} risk</span> · {task.acceptanceCriteria.length} criteria</li>)}</ul>
    </details>)}
    <button onClick={() => { void client.resolveRunApproval(runId, card.approvalId, { kind: card.approvalKind, decision: 'approved' }).then(() => { setStatus('Plan approved.'); }).catch(() => { setStatus('Plan was not approved.'); }); }} type="button">Approve plan</button>
    <label>Requested changes<textarea onChange={(event) => { setChanges(event.target.value); }} value={changes} /></label>
    <button disabled={changes.trim().length === 0} onClick={() => { void client.resolveRunApproval(runId, card.approvalId, { kind: card.approvalKind, decision: 'rejected', reason: changes.trim() }).then(() => { setStatus('Plan changes requested.'); }); }} type="button">Request changes</button>
    <p aria-live="polite">{status}</p>
  </article>;
}
