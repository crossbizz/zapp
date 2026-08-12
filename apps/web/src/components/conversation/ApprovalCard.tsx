'use client';

import type { ConversationCard } from '@zapp/api-client';
import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type MissionControlData, type ResolveApprovalInput } from '../../lib/api';

type GenericApprovalCard = Extract<ConversationCard, { kind: 'approval' }>;

export function ApprovalCard({ card, organizationId, runId }: { readonly card: GenericApprovalCard; readonly organizationId: string; readonly runId: string }): ReactElement {
  const client = createControlPlaneClient(organizationId);
  const [approval, setApproval] = useState<MissionControlData['approvals'][number]>();
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void client.getMissionControl(runId, controller.signal).then((data) => { setApproval(data.approvals.find((item) => item.approvalId === card.approvalId)); }).catch(() => { if (!controller.signal.aborted) setStatus('Approval details could not be loaded.'); });
    return () => { controller.abort(); };
  }, [card.approvalId, runId]);
  const resolve = (decision: 'approved' | 'rejected'): void => {
    const body = { kind: card.approvalKind, decision, ...(reason.trim().length === 0 ? {} : { reason: reason.trim() }) } as ResolveApprovalInput;
    void client.resolveRunApproval(runId, card.approvalId, body).then(() => { setStatus(decision === 'approved' ? 'Approved.' : 'Rejected.'); }).catch(() => { setStatus('The approval was not resolved.'); });
  };
  return <article aria-label="Approval request" className="zapp-conversation-card">
    <h3>{card.approvalKind.replaceAll('_', ' ')}</h3>
    {approval === undefined ? null : <pre>{JSON.stringify(approval.request, null, 2)}</pre>}
    <label>Reason<textarea onChange={(event) => { setReason(event.target.value); }} value={reason} /></label>
    <button onClick={() => { resolve('approved'); }} type="button">Approve</button><button onClick={() => { resolve('rejected'); }} type="button">Reject</button>
    <p aria-live="polite">{status}</p>
  </article>;
}
