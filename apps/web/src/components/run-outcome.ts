import type { RunEvent } from '@zapp/api-client';

export interface FailedRunOutcome {
  readonly code: string;
  readonly summary: string;
}

function latestTerminalEvent(events: readonly RunEvent[]): RunEvent | undefined {
  return [...events].reverse().find((event) => event.type === 'run.completed');
}

export function runCompletedSuccessfully(events: readonly RunEvent[]): boolean {
  const terminal = latestTerminalEvent(events);
  return terminal !== undefined && terminal.data.payload['status'] !== 'failed';
}

export function failedRunOutcome(events: readonly RunEvent[]): FailedRunOutcome | undefined {
  const terminal = latestTerminalEvent(events);
  if (terminal?.data.payload['status'] !== 'failed') return undefined;
  const rawCode = terminal.data.payload['code'];
  const rawSummary = terminal.data.payload['summary'];
  return {
    code: typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : 'builder_run_failed',
    summary:
      typeof rawSummary === 'string' && rawSummary.trim().length > 0
        ? rawSummary.trim()
        : 'The builder could not complete this run. Send another message to retry safely.',
  };
}
