import { clsx } from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Info,
  Settings,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';

export type Status = 'success' | 'warning' | 'danger' | 'info';

const statusIcons = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
} as const;

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  readonly status: Status;
}

export function StatusPill({ children, className, status, ...props }: StatusPillProps): ReactNode {
  const Icon = statusIcons[status];
  return (
    <span className={clsx('zapp-status-pill', `zapp-status-pill--${status}`, className)} {...props}>
      <Icon aria-hidden="true" data-status-icon={status} size={14} />
      <span>{children}</span>
    </span>
  );
}

export interface EnvBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly environment: 'preview' | 'production';
}

export function EnvBadge({ className, environment, ...props }: EnvBadgeProps): ReactNode {
  const label = environment === 'preview' ? 'Preview' : 'Production';
  return (
    <span
      className={clsx('zapp-env-badge', `zapp-env-badge--${environment}`, className)}
      {...props}
    >
      {label}
    </span>
  );
}

export interface SupportLevelBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly level: 'compatible' | 'verified' | 'managed';
}

const supportLabels = {
  compatible: 'Compatible',
  verified: 'Verified',
  managed: 'Managed',
} as const;

export function SupportLevelBadge({
  className,
  level,
  ...props
}: SupportLevelBadgeProps): ReactNode {
  return (
    <span
      className={clsx('zapp-support-badge', `zapp-support-badge--${level}`, className)}
      {...props}
    >
      {level === 'compatible' ? (
        <CircleDot aria-hidden="true" data-icon="compatible" size={14} />
      ) : (
        <ShieldCheck aria-hidden="true" data-icon="shield-check" size={14} />
      )}
      {level === 'managed' ? <Settings aria-hidden="true" data-icon="settings" size={12} /> : null}
      <span>{supportLabels[level]}</span>
    </span>
  );
}
