import type { AppMembership } from '../../lib/app-session';

export interface ShellDestination {
  readonly href: string;
  readonly icon: 'dashboard' | 'projects' | 'templates' | 'usage' | 'billing';
  readonly label: string;
  readonly ownerOnly?: boolean;
}

export interface RecentProjectDestination {
  readonly href: string;
  readonly label: string;
}

const destinations = [
  { href: '/dashboard', icon: 'dashboard', label: 'Dashboard' },
  { href: '/projects', icon: 'projects', label: 'Projects' },
  { href: '/templates', icon: 'templates', label: 'Templates' },
  { href: '/org/usage', icon: 'usage', label: 'Usage' },
  { href: '/org/billing', icon: 'billing', label: 'Billing', ownerOnly: true },
] as const satisfies readonly ShellDestination[];

export function shellDestinations(
  role: AppMembership['role'],
): readonly ShellDestination[] {
  return destinations.filter(
    (destination) => !('ownerOnly' in destination) || role === 'owner',
  );
}

export function recentProjectDestination(project: {
  readonly id: string;
  readonly name: string;
}): RecentProjectDestination {
  return { href: `/projects/${encodeURIComponent(project.id)}`, label: project.name };
}
