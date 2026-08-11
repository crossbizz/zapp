import type { ReactElement } from 'react';

export interface ToolActivity {
  readonly sequence: number;
  readonly state: 'completed' | 'failed' | 'started';
  readonly summary: string;
}

export interface ToolActivityLineProps {
  readonly activities: readonly ToolActivity[];
}

export function ToolActivityLine({ activities }: ToolActivityLineProps): ReactElement {
  const summaries = [
    ...new Set(
      activities
        .filter((activity) => activity.state !== 'started')
        .map((activity) => activity.summary),
    ),
  ];
  const visibleSummaries =
    summaries.length > 0 ? summaries : [...new Set(activities.map((activity) => activity.summary))];
  const failed = activities.some((activity) => activity.state === 'failed');
  const completed = activities.some((activity) => activity.state === 'completed');
  const suffix = failed ? ' !' : completed ? ' ✓' : '…';

  return (
    <details className="zapp-conversation-activity">
      <summary>{`${visibleSummaries.join(' · ')}${suffix}`}</summary>
      <ol>
        {activities.map((activity) => (
          <li key={`${String(activity.sequence)}-${activity.summary}`}>
            {activity.summary} ({activity.state})
          </li>
        ))}
      </ol>
    </details>
  );
}
