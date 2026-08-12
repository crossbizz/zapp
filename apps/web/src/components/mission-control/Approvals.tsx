import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function Approvals({ data, onResolve }: {
  readonly data: MissionControlData;
  readonly onResolve: (approvalId: string, type: string, decision: 'approved' | 'rejected') => void;
}): ReactElement {
  return <section aria-label="Approvals"><ul>{data.approvals.map((approval) => <li key={approval.approvalId}>
    <strong>{approval.type.replaceAll('_', ' ')}</strong> — {approval.status}
    {approval.status === 'pending' ? <span>
      <button onClick={() => { onResolve(approval.approvalId, approval.type, 'approved'); }} type="button">Approve</button>
      <button onClick={() => { onResolve(approval.approvalId, approval.type, 'rejected'); }} type="button">Reject</button>
    </span> : null}
  </li>)}</ul></section>;
}
