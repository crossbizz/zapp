'use client';

import { Drawer } from '@zapp/ui';
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

import type { ReadyAppSession } from '../../hooks/useAppSession';
import { Sidebar } from './Sidebar';
import styles from './shell.module.css';

export interface AppShellProps {
  readonly activePath: string;
  readonly children: ReactNode;
  readonly compactible?: boolean;
  readonly invalidOrganization?: boolean;
  readonly immersive?: boolean;
  readonly onSignOut: () => Promise<void>;
  readonly onSwitchOrganization: (organizationId: string) => void;
  readonly recentProjects?: readonly { readonly id: string; readonly name: string }[];
  readonly session: ReadyAppSession;
}

export function AppShell({
  activePath,
  children,
  compactible = true,
  invalidOrganization = false,
  immersive = false,
  onSignOut,
  onSwitchOrganization,
  recentProjects = [],
  session,
}: AppShellProps): ReactElement {
  const sidebar = (
    <Sidebar
      activePath={activePath}
      membership={session.membership}
      memberships={session.memberships}
      onSignOut={onSignOut}
      onSwitchOrganization={onSwitchOrganization}
      profile={session.profile}
      recentProjects={recentProjects}
    />
  );
  const shellClassName = [styles.shell, immersive ? styles.immersive : undefined]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div className={shellClassName}>
      {immersive ? null : (
        <aside aria-label="Workspace" className={styles.desktopSidebar}>
          {sidebar}
        </aside>
      )}
      {compactible && !immersive ? (
        <header className={styles.mobileHeader}>
          <Link aria-label="zapp.build dashboard" className={styles.mobileBrand} href="/dashboard">
            <span aria-hidden="true" className={styles.brandMark}>
              z
            </span>
            <strong>zapp.build</strong>
          </Link>
          <Drawer
            className={styles.mobileDrawer ?? ''}
            title="Workspace navigation"
            trigger={
              <button
                aria-label="Open navigation"
                className={styles.mobileMenuButton}
                type="button"
              >
                <span aria-hidden="true">☰</span>
              </button>
            }
          >
            {sidebar}
          </Drawer>
        </header>
      ) : null}
      <main className={styles.main}>
        {invalidOrganization ? (
          <p className={styles.contextWarning} role="alert">
            Invalid organization selection.
          </p>
        ) : null}
        {children}
      </main>
    </div>
  );
}
