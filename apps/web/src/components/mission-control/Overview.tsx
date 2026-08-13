import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function Overview({ data }: { readonly data: MissionControlData }): ReactElement {
  const percent = data.progress.total === 0 ? 0 : Math.round((data.progress.done / data.progress.total) * 100);
  return <section aria-label="Run overview">
    <h3>{data.currentPhase?.title ?? 'Preparing run'}</h3>
    <p data-run-status={data.run.status}>Run status: {data.run.status}</p>
    <progress aria-label="Run progress" max={data.progress.total || 1} value={data.progress.done} />
    <p>{data.progress.done} of {data.progress.total} tasks complete ({percent}%)</p>
    <p>Cost: {data.cost.creditsUsed} credits{data.cost.budget === null ? '' : ` of ${String(data.cost.budget)}`}</p>
    <p>Preview: {data.previewStatus?.status ?? 'not started'}</p>
  </section>;
}
