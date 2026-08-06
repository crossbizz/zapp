import { clsx } from 'clsx';
import { AlertTriangle, Check, Circle, CircleDot, Inbox } from 'lucide-react';
import { type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { Button } from './primitives';

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly label: string;
  readonly value: number;
}

export function ProgressBar({
  className,
  label,
  style,
  value,
  ...props
}: ProgressBarProps): ReactNode {
  const normalized = Math.min(100, Math.max(0, value));
  const progressStyle = {
    ...style,
    '--zapp-progress-value': `${String(normalized)}%`,
  } as CSSProperties;

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={normalized}
      className={clsx('zapp-progress', className)}
      role="progressbar"
      style={progressStyle}
      {...props}
    >
      <span className="zapp-progress__bar" />
    </div>
  );
}

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly label: string;
}

export function Spinner({ className, label, ...props }: SpinnerProps): ReactNode {
  return (
    <span aria-label={label} className={clsx('zapp-spinner', className)} role="status" {...props}>
      <span className="zapp-spinner__shape" aria-hidden="true" />
      <span className="zapp-sr-only">{label}</span>
    </span>
  );
}

export interface TimelineProps extends HTMLAttributes<HTMLOListElement> {
  readonly label: string;
}

export function Timeline({ className, label, ...props }: TimelineProps): ReactNode {
  return <ol aria-label={label} className={clsx('zapp-timeline', className)} {...props} />;
}

export type TimelineStageStatus = 'pending' | 'active' | 'complete' | 'failed';

const timelineStageStatusLabels = {
  active: 'Active',
  complete: 'Complete',
  failed: 'Failed',
  pending: 'Pending',
} as const satisfies Record<TimelineStageStatus, string>;

export interface TimelineStageProps extends Omit<HTMLAttributes<HTMLLIElement>, 'title'> {
  readonly description?: string;
  readonly status: TimelineStageStatus;
  readonly title: ReactNode;
}

export function TimelineStage({
  className,
  description,
  status,
  title,
  ...props
}: TimelineStageProps): ReactNode {
  const Icon =
    status === 'complete'
      ? Check
      : status === 'failed'
        ? AlertTriangle
        : status === 'active'
          ? CircleDot
          : Circle;
  return (
    <li
      className={clsx('zapp-timeline-stage', `zapp-timeline-stage--${status}`, className)}
      {...props}
    >
      <span className="zapp-sr-only">{`Status: ${timelineStageStatusLabels[status]}`}</span>
      <Icon aria-hidden="true" data-status-icon={status} size={18} />
      <span className="zapp-timeline-stage__body">
        <span className="zapp-timeline-stage__title">{title}</span>
        {description === undefined ? null : (
          <span className="zapp-timeline-stage__description">{description}</span>
        )}
      </span>
    </li>
  );
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  readonly description?: ReactNode;
  readonly title: ReactNode;
}

export function EmptyState({
  children,
  className,
  description,
  title,
  ...props
}: EmptyStateProps): ReactNode {
  return (
    <div className={clsx('zapp-state', 'zapp-empty-state', className)} {...props}>
      <Inbox className="zapp-state__icon" aria-hidden="true" size={28} />
      <h2 className="zapp-state__title">{title}</h2>
      {description === undefined ? null : <p className="zapp-state__description">{description}</p>}
      {children}
    </div>
  );
}

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  readonly description?: ReactNode;
  readonly onAskAgent: () => void;
  readonly onFixAutomatically: () => void;
  readonly onInspectDetails: () => void;
  readonly onRetry: () => void;
  readonly title: ReactNode;
}

export function ErrorState({
  className,
  description,
  onAskAgent,
  onFixAutomatically,
  onInspectDetails,
  onRetry,
  title,
  ...props
}: ErrorStateProps): ReactNode {
  return (
    <div className={clsx('zapp-state', 'zapp-error-state', className)} role="alert" {...props}>
      <AlertTriangle className="zapp-state__icon" aria-hidden="true" size={28} />
      <h2 className="zapp-state__title">{title}</h2>
      {description === undefined ? null : <p className="zapp-state__description">{description}</p>}
      <div className="zapp-error-state__actions">
        <Button onClick={onFixAutomatically}>Fix automatically</Button>
        <Button variant="secondary" onClick={onInspectDetails}>
          Inspect details
        </Button>
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
        <Button variant="ghost" onClick={onAskAgent}>
          Ask the agent
        </Button>
      </div>
    </div>
  );
}
