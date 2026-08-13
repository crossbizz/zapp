import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function Activity({ data }: { readonly data: MissionControlData }): ReactElement {
  return <ol aria-label="Recent activity">{data.recentToolCalls.map((call) => <li key={`${String(call.sequence)}:${call.toolCallId}`}>
    <span>{call.userSummary ?? call.toolName}</span> <small>{call.status}</small>
    <details><summary>Raw detail</summary><code>{call.toolName} · {call.durationMs === null ? 'running' : `${String(call.durationMs)}ms`}</code></details>
  </li>)}</ol>;
}
