import Link from 'next/link';
import type { ReactElement } from 'react';

import type { AppMembership } from '../../lib/app-session';
import type { MeResponse } from '../../lib/api';
import { AccountMenu } from './AccountMenu';
import {
  recentProjectDestination,
  shellDestinations,
  type ShellDestination,
} from './shell-navigation';
import styles from './shell.module.css';

function Brand(): ReactElement {
  return (
    <Link aria-label="zapp.build dashboard" className={styles.brand} href="/dashboard">
      <span aria-hidden="true" className={styles.brandMark}>z</span>
      <span className={styles.brandName}>zapp.build</span>
    </Link>
  );
}

function DestinationIcon({ icon }: Pick<ShellDestination, 'icon'>): ReactElement {
  const paths = {
    billing: <path d="M3 6.5h14v10H3zM3 9h14M6 13h3" />,
    dashboard: <path d="M3 3h6v6H3zM11 3h6v4h-6zM3 11h6v6H3zM11 9h6v8h-6z" />,
    projects: <path d="M3 5.5h5l1.5 2H17v9H3z" />,
    templates: <path d="M4 3h12v14H4zM7 7h6M7 10h6M7 13h4" />,
    usage: <path d="M4 16V9M10 16V4M16 16v-5" />,
  } as const;
  return (
    <svg aria-hidden="true" className={styles.destinationIcon} fill="none" viewBox="0 0 20 20">
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
        {paths[icon]}
      </g>
    </svg>
  );
}

export interface SidebarProps {
  readonly activePath: string;
  readonly membership: AppMembership;
  readonly memberships: readonly AppMembership[];
  readonly onSignOut: () => Promise<void>;
  readonly onSwitchOrganization: (organizationId: string) => void;
  readonly profile: MeResponse;
  readonly recentProjects?: readonly { readonly id: string; readonly name: string }[];
}

export function Sidebar({
  activePath,
  membership,
  memberships,
  onSignOut,
  onSwitchOrganization,
  profile,
  recentProjects = [],
}: SidebarProps): ReactElement {
  return (
    <div className={styles.sidebarInner}>
      <div className={styles.sidebarHeader}>
        <Brand />
        <label className={styles.organizationPicker}>
          <span className="zapp-sr-only">Organization</span>
          <span aria-hidden="true" className={styles.organizationAvatar}>
            {membership.organization.name.slice(0, 1).toUpperCase()}
          </span>
          <select
            aria-label="Organization"
            onChange={(event) => {
              onSwitchOrganization(event.target.value);
            }}
            value={membership.organization.id}
          >
            {memberships.map((item) => (
              <option key={item.organization.id} value={item.organization.id}>
                {item.organization.name}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.selectedOrganization}>
          Selected organization: {membership.organization.name}
        </p>
      </div>

      <nav aria-label="Primary" className={styles.primaryNavigation}>
        {shellDestinations(membership.role).map((destination) => {
          const active =
            activePath === destination.href || activePath.startsWith(`${destination.href}/`);
          return (
            <Link
              aria-current={active ? 'page' : undefined}
              aria-label={destination.label}
              className={`${styles.destination ?? ''} ${active ? styles.destinationActive ?? '' : ''}`}
              href={destination.href}
              key={destination.href}
            >
              <DestinationIcon icon={destination.icon} />
              <span className={styles.destinationLabel}>{destination.label}</span>
            </Link>
          );
        })}
      </nav>

      {recentProjects.length === 0 ? null : (
        <section aria-label="Recent projects" className={styles.recentProjects}>
          <h2>Recent</h2>
          {recentProjects.slice(0, 4).map((project) => {
            const destination = recentProjectDestination(project);
            return (
              <Link href={destination.href} key={destination.href}>
                {destination.label}
              </Link>
            );
          })}
        </section>
      )}

      <div className={styles.sidebarFooter}>
        <AccountMenu memberships={memberships} onSignOut={onSignOut} profile={profile} />
      </div>
    </div>
  );
}
