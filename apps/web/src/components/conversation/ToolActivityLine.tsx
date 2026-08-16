import * as React from 'react';
import type { ReactElement } from 'react';

export interface ToolActivity {
  readonly count?: number;
  readonly sequence: number;
  readonly state: 'completed' | 'failed' | 'started';
  readonly summary: string;
  readonly tool?: string;
  readonly toolCallId?: string;
}

export interface ToolActivityLineProps {
  readonly activities: readonly ToolActivity[];
}

type ActivityCategory =
  | 'check'
  | 'command'
  | 'configuration'
  | 'dependency'
  | 'file'
  | 'inspection'
  | 'preview'
  | 'source-control';

const toolCategories = new Map<string, ActivityCategory>([
  ['apply_patch', 'file'],
  ['capture_screenshot', 'check'],
  ['check_deployment_health', 'check'],
  ['commit_changes', 'source-control'],
  ['copy_file', 'file'],
  ['create_branch', 'source-control'],
  ['create_checkpoint', 'source-control'],
  ['create_preview', 'preview'],
  ['delete_file', 'file'],
  ['deploy_release', 'preview'],
  ['execute_migration', 'configuration'],
  ['file_stats', 'inspection'],
  ['git_diff', 'inspection'],
  ['git_log', 'inspection'],
  ['git_show', 'inspection'],
  ['git_status', 'inspection'],
  ['grep', 'inspection'],
  ['inspect_browser_console', 'check'],
  ['inspect_network_requests', 'check'],
  ['install_dependency', 'dependency'],
  ['list_files', 'inspection'],
  ['merge_branch', 'source-control'],
  ['read_database_schema', 'inspection'],
  ['read_file', 'inspection'],
  ['read_logs', 'inspection'],
  ['read_project_contract', 'inspection'],
  ['read_test_results', 'inspection'],
  ['rename_file', 'file'],
  ['restart_dev_server', 'preview'],
  ['restore_file', 'source-control'],
  ['revert_commit', 'source-control'],
  ['rollback_release', 'preview'],
  ['run_browser_tests', 'check'],
  ['run_command', 'command'],
  ['run_dev_server', 'preview'],
  ['run_preview_smoke_test', 'check'],
  ['search_code', 'inspection'],
  ['set_environment_variable', 'configuration'],
  ['write_file', 'file'],
]);

interface ActivityBucket {
  readonly activities: readonly ToolActivity[];
  readonly category: ActivityCategory | undefined;
  readonly fallbackSummary: string | undefined;
}

function uniqueCalls(activities: readonly ToolActivity[]): number {
  return new Set(
    activities.map((activity) => activity.toolCallId ?? `sequence-${String(activity.sequence)}`),
  ).size;
}

function completedSummary(bucket: ActivityBucket): string {
  const callCount = uniqueCalls(bucket.activities);
  switch (bucket.category) {
    case 'file':
      return `Updated ${String(callCount)} project ${callCount === 1 ? 'file' : 'files'}`;
    case 'dependency': {
      const counts = bucket.activities.map((activity) => activity.count);
      if (counts.every((count): count is number => count !== undefined)) {
        const total = counts.reduce((sum, count) => sum + count, 0);
        return `Installed ${String(total)} ${total === 1 ? 'dependency' : 'dependencies'}`;
      }
      return 'Installed dependencies';
    }
    case 'inspection':
      return 'Reviewed project context';
    case 'command': {
      const activity = bucket.activities[0];
      return callCount === 1 && activity !== undefined
        ? activity.summary
        : `Ran ${String(callCount)} commands`;
    }
    case 'preview':
      return 'Updated the preview';
    case 'check':
      return 'Ran project checks';
    case 'source-control':
      return 'Updated source control';
    case 'configuration':
      return 'Updated project configuration';
    default:
      return bucket.fallbackSummary ?? 'Completed a task';
  }
}

function activeSummary(bucket: ActivityBucket): string {
  switch (bucket.category) {
    case 'file':
      return 'Updating project files';
    case 'dependency':
      return 'Installing dependencies';
    case 'inspection':
      return 'Reviewing project context';
    case 'command':
      return 'Running a command';
    case 'preview':
      return 'Preparing the preview';
    case 'check':
      return 'Running project checks';
    case 'source-control':
      return 'Updating source control';
    case 'configuration':
      return 'Updating project configuration';
    default:
      return bucket.fallbackSummary ?? 'Working';
  }
}

function activityBuckets(activities: readonly ToolActivity[]): readonly ActivityBucket[] {
  const buckets = new Map<string, ToolActivity[]>();
  for (const activity of activities) {
    const category = activity.tool === undefined ? undefined : toolCategories.get(activity.tool);
    const key = category ?? `fallback:${activity.summary}`;
    const existing = buckets.get(key) ?? [];
    existing.push(activity);
    buckets.set(key, existing);
  }
  return [...buckets.entries()].map(([key, bucketActivities]) => ({
    activities: bucketActivities,
    category: key.startsWith('fallback:') ? undefined : (key as ActivityCategory),
    fallbackSummary: key.startsWith('fallback:') ? key.slice('fallback:'.length) : undefined,
  }));
}

function limitedSummaries(buckets: readonly ActivityBucket[], completed: boolean): readonly string[] {
  const summaries = buckets.map((bucket) =>
    completed ? completedSummary(bucket) : activeSummary(bucket),
  );
  if (summaries.length <= 3) return summaries;
  const omittedCount = buckets
    .slice(2)
    .reduce((count, bucket) => count + uniqueCalls(bucket.activities), 0);
  return [...summaries.slice(0, 2), `Completed ${String(omittedCount)} more tasks`];
}

function activitySummary(activities: readonly ToolActivity[]): string {
  const failure = activities.find((activity) => activity.state === 'failed');
  if (failure !== undefined) return `${failure.summary} !`;

  const terminalCallIds = new Set(
    activities
      .filter((activity) => activity.state !== 'started')
      .map((activity) => activity.toolCallId)
      .filter((toolCallId): toolCallId is string => toolCallId !== undefined),
  );
  const pending = activities.some(
    (activity) =>
      activity.state === 'started' &&
      (activity.toolCallId === undefined || !terminalCallIds.has(activity.toolCallId)),
  );
  const completed = activities.filter((activity) => activity.state === 'completed');
  const visibleActivities = completed.length > 0 ? completed : activities;
  const summaries = limitedSummaries(activityBuckets(visibleActivities), completed.length > 0);
  const suffix = completed.length > 0 && !pending ? ' ✓' : '…';
  return `${summaries.join(' · ')}${suffix}`;
}

export function ToolActivityLine({ activities }: ToolActivityLineProps): ReactElement {
  return (
    <details className="zapp-conversation-activity">
      <summary>
        <span>{activitySummary(activities)}</span>
        <span className="zapp-conversation-activity-details">Details</span>
      </summary>
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
