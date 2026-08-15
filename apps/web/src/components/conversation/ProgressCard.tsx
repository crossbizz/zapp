import { useEffect, useState, type ReactElement } from 'react';

export interface ProgressCardProps {
  readonly completedAt?: string;
  readonly name: string;
  readonly startedAt?: string;
  readonly state: 'complete' | 'pending' | 'running';
}

function elapsedSeconds(
  startedAt: string | undefined,
  completedAt: string | undefined,
  now: number | undefined,
): number {
  if (startedAt === undefined) return 0;
  const start = Date.parse(startedAt);
  const end = completedAt === undefined ? (now ?? start) : Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1_000));
}

export function ProgressCard({
  completedAt,
  name,
  startedAt,
  state,
}: ProgressCardProps): ReactElement {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (state !== 'running' || startedAt === undefined) return;
    const update = (): void => {
      setNow(Date.now());
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [startedAt, state]);
  const elapsed = elapsedSeconds(startedAt, completedAt, now);
  const stateLabel = state === 'complete' ? 'Complete' : state === 'running' ? 'In progress' : 'Pending';
  return (
    <article
      aria-label={`${name} progress`}
      className="zapp-conversation-progress"
      data-state={state}
      role="status"
    >
      <span aria-hidden="true" className="zapp-conversation-progress-indicator" />
      <strong>{name}</strong>
      <span>{stateLabel}</span>
      {state === 'running' ? <small>{String(elapsed)}s elapsed</small> : null}
    </article>
  );
}
