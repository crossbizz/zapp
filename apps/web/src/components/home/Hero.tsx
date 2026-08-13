'use client';

import { Avatar, CreditsPill, Tabs, Tooltip } from '@zapp/ui';
import Link from 'next/link';
import { useState, type KeyboardEvent, type ReactElement } from 'react';

import {
  createControlPlaneClient,
  type CreateRunInput,
  type MeResponse,
} from '../../lib/api';
import type { HomeFeatureFlags } from '../../lib/feature-flags';
import { activeMemberships } from '../../lib/session';
import { PromptComposer } from './PromptComposer';
import { SuggestionChips } from './SuggestionChips';
import styles from './home.module.css';

interface HomeCopy {
  readonly heading: string;
  readonly homeLabel: string;
}

const HOME_COPY = {
  heading: "Start with one prompt. We'll take it to production.",
  homeLabel: 'Home',
} as const satisfies HomeCopy;

type AppType = NonNullable<CreateRunInput['appType']>;

function configuredCredits(): number {
  const configured = process.env.NEXT_PUBLIC_HOME_CREDITS;
  if (configured === undefined || !/^\d+$/u.test(configured)) return 0;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface HeroProps {
  readonly allowedModels: readonly string[];
  readonly flags: HomeFeatureFlags;
  readonly invalidOrganization: boolean;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly profile: MeResponse;
}

export function Hero({
  allowedModels,
  flags,
  invalidOrganization,
  organizationId,
  organizationName,
  profile,
}: HeroProps): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [appType, setAppType] = useState<AppType>('web');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const composer = (
    <PromptComposer
      allowedModels={allowedModels}
      appType={appType}
      organizationId={organizationId}
      onPromptChange={setPrompt}
      prompt={prompt}
      voiceInputEnabled={flags.voiceInput}
    />
  );
  const mobileLabel = (
    <span>
      Mobile App
      {flags.mobileApp ? null : <span className="zapp-sr-only"> Coming after P0</span>}
    </span>
  );
  const memberships = activeMemberships(profile.memberships);

  const signOut = async (): Promise<void> => {
    setSignOutFailed(false);
    try {
      await createControlPlaneClient(organizationId).logout();
      window.location.assign('/login');
    } catch {
      setSignOutFailed(true);
    }
  };

  return (
    <div className={styles.home}>
      <header className={styles.topBar}>
        <Link className={styles.homePill} href="/">
          <span aria-hidden="true">▦</span>
          {HOME_COPY.homeLabel}
        </Link>
        <p className={styles.organizationContext}>
          Selected organization: {organizationName}
        </p>
        <div className={styles.accountControls}>
          <CreditsPill credits={configuredCredits()} />
          <div className={styles.accountMenuContainer}>
            <button
              aria-expanded={accountMenuOpen}
              aria-label="Open account menu"
              className={styles.avatarButton}
              onClick={() => {
                setAccountMenuOpen((open) => !open);
              }}
              type="button"
            >
              <Avatar
                name={profile.user.displayName}
                {...(profile.user.avatarUrl === null ? {} : { src: profile.user.avatarUrl })}
              />
              <span>{profile.user.displayName}</span>
            </button>
            {accountMenuOpen ? (
              <nav className={styles.accountMenu} aria-label="Account">
                <p className={styles.menuHeading}>Organizations</p>
                {memberships.map((membership) => (
                  <a
                    className={styles.menuItem}
                    href={`/?organizationId=${encodeURIComponent(membership.organization.id)}`}
                    key={membership.organization.id}
                  >
                    {membership.organization.name}
                  </a>
                ))}
                <Link className={styles.menuItem} href="/org/settings">
                  Organization settings
                </Link>
                <button
                  className={styles.menuItem}
                  onClick={() => void signOut()}
                  type="button"
                >
                  Sign out
                </button>
              </nav>
            ) : null}
          </div>
        </div>
      </header>

      {invalidOrganization ? (
        <p className={styles.contextWarning} role="alert">Invalid organization selection.</p>
      ) : null}
      {signOutFailed ? (
        <p className={styles.contextWarning} role="alert">
          Sign out failed. <button onClick={() => void signOut()} type="button">Retry</button>
        </p>
      ) : null}

      <div className={styles.heroContent}>
        <h1 className={styles.heading}>{HOME_COPY.heading}</h1>
        <div
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            const target = event.target;
            if (
              event.key === 'Tab'
              && !event.shiftKey
              && target instanceof HTMLElement
              && target.getAttribute('role') === 'tab'
              && target.getAttribute('aria-selected') === 'true'
            ) {
              event.preventDefault();
              document.querySelector<HTMLTextAreaElement>('#home-prompt')?.focus();
            }
          }}
        >
          {flags.mobileApp ? null : (
            <div className={styles.productHelp}>
              <Tooltip content="Mobile App is coming after P0.">
                <button
                  aria-label="Why Mobile App is unavailable"
                  className={styles.productHelpButton}
                  type="button"
                >
                  ?
                </button>
              </Tooltip>
            </div>
          )}
          <Tabs
            defaultValue="web"
            items={[
              { content: null, label: 'Web App', value: 'web' },
              {
                content: null,
                disabled: !flags.mobileApp,
                label: mobileLabel,
                value: 'mobile',
              },
            ]}
            label="Product type"
            onValueChange={(value) => {
              if (value === 'web' || (value === 'mobile' && flags.mobileApp)) {
                setAppType(value);
              }
            }}
            value={appType}
          />
          {composer}
        </div>
        <SuggestionChips onSelect={setPrompt} />
      </div>

      <aside className={styles.support} aria-label="Support">
        <button
          aria-expanded={supportOpen}
          aria-label="Support"
          className={styles.supportButton}
          onClick={() => {
            setSupportOpen((open) => !open);
          }}
          type="button"
        >
          ?
        </button>
        {supportOpen ? (
          <div className={styles.supportMenu}>
            <a href="https://docs.zapp.build">Read the docs</a>
            <a href="mailto:support@zapp.build">Contact support</a>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
