import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function TaskGraph({ data, onRetry, onSkip }: {
  readonly data: MissionControlData;
  readonly onRetry: (taskId: string) => void;
  readonly onSkip: (phaseId: string) => void;
}): ReactElement {
  return <section aria-label="Task dependency graph">
    <ol>
      {data.taskGraph.nodes.map((task) => {
        const dependencies = data.taskGraph.edges.filter((edge) => edge.to === task.id).map((edge) => edge.from);
        const retry = data.actions.retryFailedTasks.find((action) => action.taskId === task.id);
        return <li data-state={task.status} key={task.id}>
          <strong>{task.title}</strong> — {task.status}
          {dependencies.length === 0 ? null : <small> after {dependencies.join(', ')}</small>}
          {retry?.eligible === true ? <button onClick={() => { onRetry(task.id); }} type="button">Retry failed task</button> : null}
        </li>;
      })}
    </ol>
    {data.actions.skipOptionalPhases.filter((action) => action.eligible).map((action) =>
      <button key={action.phaseId} onClick={() => { onSkip(action.phaseId); }} type="button">Skip optional phase</button>,
    )}
  </section>;
}
