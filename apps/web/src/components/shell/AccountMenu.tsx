'use client';

import { Avatar, CreditsPill } from '@zapp/ui';
import Link from 'next/link';
import { useState, type ReactElement } from 'react';

import type { AppMembership } from '../../lib/app-session';
import type { MeResponse } from '../../lib/api';
import styles from './shell.module.css';

function configuredCredits(): number {
  const configured = process.env.NEXT_PUBLIC_HOME_CREDITS;
  if (configured === undefined || !/^\d+$/u.test(configured)) return 0;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface AccountMenuProps {
  readonly memberships: readonly AppMembership[];
  readonly onSignOut: () => Promise<void>;
  readonly profile: MeResponse;
}

export function AccountMenu({
  memberships,
  onSignOut,
  profile,
}: AccountMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async (): Promise<void> => {
    setSignOutFailed(false);
    setSigningOut(true);
    try {
      await onSignOut();
    } catch {
      setSignOutFailed(true);
      setSigningOut(false);
    }
  };

  return (
    <div className={styles.accountArea}>
      <CreditsPill credits={configuredCredits()} />
      <div className={styles.accountMenuContainer}>
        <button
          aria-expanded={open}
          aria-label="Open account menu"
          className={styles.accountButton}
          onClick={() => {
            setOpen((value) => !value);
          }}
          type="button"
        >
          <Avatar
            name={profile.user.displayName}
            {...(profile.user.avatarUrl === null ? {} : { src: profile.user.avatarUrl })}
          />
          <span className={styles.accountIdentity}>
            <strong>{profile.user.displayName}</strong>
            <small>Account</small>
          </span>
          <span aria-hidden="true" className={styles.accountChevron}>⌄</span>
        </button>
        {open ? (
          <nav aria-label="Account" className={styles.accountMenu}>
            <p className={styles.accountMenuHeading}>Organizations</p>
            {memberships.map((membership) => (
              <a
                className={styles.accountMenuItem}
                href={`/?organizationId=${encodeURIComponent(membership.organization.id)}`}
                key={membership.organization.id}
              >
                {membership.organization.name}
              </a>
            ))}
            <Link className={styles.accountMenuItem} href="/org/settings">
              Organization settings
            </Link>
            <button
              className={styles.accountMenuItem}
              disabled={signingOut}
              onClick={() => void signOut()}
              type="button"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
            {signOutFailed ? (
              <p className={styles.accountError} role="alert">
                Sign out failed. <button onClick={() => void signOut()} type="button">Retry</button>
              </p>
            ) : null}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
