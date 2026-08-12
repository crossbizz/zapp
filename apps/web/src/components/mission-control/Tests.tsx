import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function Tests({ data }: { readonly data: MissionControlData }): ReactElement {
  return <section aria-label="Test runs"><ul>{data.testRuns.map((run) => <li data-state={run.status} key={run.testRunId}>{run.type}: {run.status}</li>)}</ul>{data.screenshots.map((shot) => <p key={shot.artifactId}>Screenshot evidence: {shot.artifactId}</p>)}</section>;
}
