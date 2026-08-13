'use client';

import type { ConversationCard } from '@zapp/api-client';
import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type RunSpecificationData } from '../../lib/api';

type SpecificationCard = Extract<ConversationCard, { kind: 'specification' }>;

export function SpecSummaryCard({ card, organizationId, runId }: { readonly card: SpecificationCard; readonly organizationId: string; readonly runId: string }): ReactElement {
  const client = createControlPlaneClient(organizationId);
  const [data, setData] = useState<RunSpecificationData>();
  const [edit, setEdit] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void client.getRunSpecification(runId, card.artifactId, controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setStatus('Specification could not be loaded.'); });
    return () => { controller.abort(); };
  }, [card.artifactId, runId]);
  if (data === undefined) return <p role="status">{status || 'Loading specification…'}</p>;
  const specification = data.specification.content;
  return <article aria-label="Specification summary" className="zapp-conversation-card">
    <h3>Specification v{data.specification.version}</h3><p>{specification.problem}</p>
    <details><summary>Full specification</summary>
      <h4>Goals</h4><ul>{specification.goals.map((item) => <li key={item}>{item}</li>)}</ul>
      <h4>User journeys</h4><ul>{specification.journeys.map((item) => <li key={item}>{item}</li>)}</ul>
      <h4>Acceptance criteria</h4><ul>{specification.acceptanceCriteria.map((item) => <li key={item.id}>{item.id}: {item.text}</li>)}</ul>
      <h4>Risks</h4><ul>{specification.risks.map((item) => <li key={item}>{item}</li>)}</ul>
    </details>
    <button onClick={() => { void client.resolveRunApproval(runId, card.approvalId, { kind: 'specification', decision: 'approved' }).then(() => { setStatus('Specification approved.'); }).catch(() => { setStatus('Specification was not approved.'); }); }} type="button">Start building</button>
    <button onClick={() => { void client.sendRunMessage(runId, { content: 'Keep discussing this specification before approval.' }); }} type="button">Keep discussing</button>
    <label>Edit details<textarea onChange={(event) => { setEdit(event.target.value); }} value={edit} /></label>
    {edit.trim().length === 0 ? null : <p>Ask the agent to explain the plan, cost, and risk consequences before accepting this change.</p>}
    <button disabled={edit.trim().length === 0} onClick={() => { void client.sendRunMessage(runId, { content: `Proposed specification edit; explain consequences before applying: ${edit.trim()}` }).then(() => { setStatus('Edit sent for consequence review.'); }); }} type="button">Review edit consequences</button>
    <p aria-live="polite">{status}</p>
  </article>;
}
