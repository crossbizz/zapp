import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function Agents({ data }: { readonly data: MissionControlData }): ReactElement {
  return <ul aria-label="Active agents">{data.activeAgents.map((agent) => {
    const current = data.recentToolCalls.find((call) => call.agentId === agent.agentId && call.status === 'running');
    return <li key={agent.agentId}><strong>{agent.role}</strong>{current === undefined ? '' : ` — ${current.toolName}`}</li>;
  })}</ul>;
}
