import * as React from 'react';
import type { ReactElement } from 'react';

export interface ToolActivity {
  readonly affectedPaths?: readonly string[];
  readonly count?: number;
  readonly filesChanged?: number;
  readonly sequence: number;
  readonly state: 'completed' | 'failed' | 'started' | 'unknown';
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
  | 'migration'
  | 'preview'
  | 'release'
  | 'source-control';

type ActivityToolName =
  | 'apply_patch'
  | 'capture_screenshot'
  | 'check_deployment_health'
  | 'commit_changes'
  | 'copy_file'
  | 'create_branch'
  | 'create_checkpoint'
  | 'create_preview'
  | 'create_release_candidate'
  | 'delete_file'
  | 'deploy_release'
  | 'execute_migration'
  | 'file_stats'
  | 'git_diff'
  | 'git_log'
  | 'git_show'
  | 'git_status'
  | 'grep'
  | 'inspect_browser_console'
  | 'inspect_network_requests'
  | 'install_dependency'
  | 'list_files'
  | 'merge_branch'
  | 'read_database_schema'
  | 'read_file'
  | 'read_logs'
  | 'read_project_contract'
  | 'read_test_results'
  | 'rename_file'
  | 'restart_dev_server'
  | 'restore_file'
  | 'revert_commit'
  | 'rollback_release'
  | 'run_browser_tests'
  | 'run_build'
  | 'run_command'
  | 'run_dev_server'
  | 'run_integration_tests'
  | 'run_lint'
  | 'run_preview_smoke_test'
  | 'run_typecheck'
  | 'run_unit_tests'
  | 'search_code'
  | 'set_environment_variable'
  | 'write_file';

// This record deliberately mirrors the 45 public P0 tools without importing a
// service-side registry into the browser bundle. The explicit union keeps this
// browser-side snapshot exhaustive at compile time.
const toolCategories: Readonly<Record<ActivityToolName, ActivityCategory>> = {
  apply_patch: 'file',
  capture_screenshot: 'check',
  check_deployment_health: 'check',
  commit_changes: 'source-control',
  copy_file: 'file',
  create_branch: 'source-control',
  create_checkpoint: 'source-control',
  create_preview: 'preview',
  create_release_candidate: 'release',
  delete_file: 'file',
  deploy_release: 'release',
  execute_migration: 'migration',
  file_stats: 'inspection',
  git_diff: 'inspection',
  git_log: 'inspection',
  git_show: 'inspection',
  git_status: 'inspection',
  grep: 'inspection',
  inspect_browser_console: 'check',
  inspect_network_requests: 'check',
  install_dependency: 'dependency',
  list_files: 'inspection',
  merge_branch: 'source-control',
  read_database_schema: 'inspection',
  read_file: 'inspection',
  read_logs: 'inspection',
  read_project_contract: 'inspection',
  read_test_results: 'inspection',
  rename_file: 'file',
  restart_dev_server: 'preview',
  restore_file: 'source-control',
  revert_commit: 'source-control',
  rollback_release: 'release',
  run_browser_tests: 'check',
  run_build: 'check',
  run_command: 'command',
  run_dev_server: 'preview',
  run_integration_tests: 'check',
  run_lint: 'check',
  run_preview_smoke_test: 'check',
  run_typecheck: 'check',
  run_unit_tests: 'check',
  search_code: 'inspection',
  set_environment_variable: 'configuration',
  write_file: 'file',
};

function categoryForTool(tool: string | undefined): ActivityCategory | undefined {
  return tool !== undefined && Object.hasOwn(toolCategories, tool)
    ? toolCategories[tool as ActivityToolName]
    : undefined;
}

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

function fileCount(activities: readonly ToolActivity[]): number | undefined {
  const paths = new Set<string>();
  const countsWithoutPaths: number[] = [];
  for (const activity of activities) {
    if (activity.affectedPaths !== undefined && activity.affectedPaths.length > 0) {
      for (const path of activity.affectedPaths) paths.add(path);
      continue;
    }
    if (activity.filesChanged !== undefined) {
      countsWithoutPaths.push(activity.filesChanged);
      continue;
    }
    return undefined;
  }
  if (paths.size > 0 && countsWithoutPaths.length > 0) return undefined;
  if (countsWithoutPaths.length > 1) return undefined;
  return paths.size > 0 ? paths.size : countsWithoutPaths[0];
}

function completedSummary(bucket: ActivityBucket): string {
  const callCount = uniqueCalls(bucket.activities);
  switch (bucket.category) {
    case 'file': {
      const affectedFileCount = fileCount(bucket.activities);
      return affectedFileCount === undefined
        ? 'Updated project files'
        : `Updated ${String(affectedFileCount)} project ${affectedFileCount === 1 ? 'file' : 'files'}`;
    }
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
    case 'migration':
      return 'Applied a database migration';
    case 'release':
      return 'Updated the release';
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
    case 'migration':
      return 'Applying a database migration';
    case 'release':
      return 'Updating the release';
    default:
      return bucket.fallbackSummary ?? 'Working';
  }
}

function activityBuckets(activities: readonly ToolActivity[]): readonly ActivityBucket[] {
  const buckets = new Map<string, ToolActivity[]>();
  for (const activity of activities) {
    const category = categoryForTool(activity.tool);
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

function hasPendingActivity(activities: readonly ToolActivity[]): boolean {
  const terminalCallIds = new Set(
    activities
      .filter((activity) => activity.state !== 'started')
      .map((activity) => activity.toolCallId)
      .filter((toolCallId): toolCallId is string => toolCallId !== undefined),
  );
  if (
    activities.some(
      (activity) =>
        activity.state === 'started' &&
        activity.toolCallId !== undefined &&
        !terminalCallIds.has(activity.toolCallId),
    )
  ) {
    return true;
  }

  const anonymousStarted = new Map<string, number>();
  const anonymousTerminal = new Map<string, number>();
  for (const activity of activities) {
    if (activity.toolCallId !== undefined) continue;
    const key = activity.tool ?? 'unknown';
    const target = activity.state === 'started' ? anonymousStarted : anonymousTerminal;
    target.set(key, (target.get(key) ?? 0) + 1);
  }
  return [...anonymousStarted].some(
    ([key, count]) => count > (anonymousTerminal.get(key) ?? 0),
  );
}

function limitedSummaries(summaries: readonly string[]): readonly string[] {
  if (summaries.length <= 3) return summaries;
  return [...summaries.slice(0, 2), `${String(summaries.length - 2)} more activities`];
}

function activitySummary(activities: readonly ToolActivity[]): string {
  const failure = activities.find((activity) => activity.state === 'failed');
  if (failure !== undefined) return `${failure.summary} !`;

  const buckets = activityBuckets(activities);
  const pending = buckets.some((bucket) => hasPendingActivity(bucket.activities));
  const outcomeUnavailable = activities.some((activity) => activity.state === 'unknown');
  const summaries = limitedSummaries(
    buckets.map((bucket) => {
      if (hasPendingActivity(bucket.activities)) return activeSummary(bucket);
      const unknown = bucket.activities.filter((activity) => activity.state === 'unknown');
      const latestUnknown = unknown.at(-1);
      if (latestUnknown !== undefined) return latestUnknown.summary;
      const completed = bucket.activities.filter((activity) => activity.state === 'completed');
      return completed.length > 0
        ? completedSummary({ ...bucket, activities: completed })
        : activeSummary(bucket);
    }),
  );
  const suffix = pending ? '…' : outcomeUnavailable ? '' : ' ✓';
  return `${summaries.join(' · ')}${suffix}`;
}

function activityStateLabel(state: ToolActivity['state']): string {
  return state === 'unknown' ? 'outcome unavailable' : state;
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
            {activity.summary} ({activityStateLabel(activity.state)})
          </li>
        ))}
      </ol>
    </details>
  );
}
