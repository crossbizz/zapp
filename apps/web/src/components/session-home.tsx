'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { captureSignup } from '../lib/activation';
import { createControlPlaneClient } from '../lib/api';
import {
  bootstrapHomeFeatureFlags,
  homeFeatureFlags,
  type HomeFeatureFlags,
} from '../lib/feature-flags';
import { useAppSession } from '../hooks/useAppSession';
import { Hero } from './home/Hero';
import { AppShell } from './shell/AppShell';

export function SessionHome(): ReactElement {
  const session = useAppSession();
  const [featureFlags, setFeatureFlags] = useState<HomeFeatureFlags>();
  const [featureLoadFailed, setFeatureLoadFailed] = useState(false);
  const [featureAttempt, setFeatureAttempt] = useState(0);

  useEffect(() => {
    if (session.snapshot.status !== 'ready') {
      setFeatureFlags(undefined);
      setFeatureLoadFailed(false);
      return;
    }

    const abortController = new AbortController();
    const organizationId = session.snapshot.membership.organization.id;
    const userId = session.snapshot.profile.user.id;
    setFeatureFlags(undefined);
    setFeatureLoadFailed(false);

    const load = async (): Promise<void> => {
      try {
        const flags = await createControlPlaneClient(organizationId).getFeatureFlags(
          abortController.signal,
        );
        bootstrapHomeFeatureFlags(organizationId, flags);
        captureSignup({ organizationId, userId });
        setFeatureFlags(homeFeatureFlags(flags));
      } catch {
        if (!abortController.signal.aborted) setFeatureLoadFailed(true);
      }
    };

    void load();
    return () => {
      abortController.abort();
    };
  }, [featureAttempt, session.snapshot]);

  if (session.snapshot.status === 'error') {
    return (
      <main>
        <p role="alert">We could not load your session. Please try again.</p>
        <button onClick={session.retry} type="button">Try again</button>
      </main>
    );
  }

  if (session.snapshot.status === 'loading') return <main>Loading session…</main>;

  if (session.snapshot.status === 'empty') {
    return (
      <main>
        <h1>{session.snapshot.profile.user.displayName}</h1>
        {session.snapshot.invalidOrganization ? <p>Invalid organization selection.</p> : null}
        <p>No active organization.</p>
      </main>
    );
  }

  const readySession = session.snapshot;
  const organizationId = readySession.membership.organization.id;
  const shell = (children: ReactElement): ReactElement => (
    <AppShell
      activePath="/"
      invalidOrganization={readySession.invalidOrganization}
      onSignOut={() => session.signOut(organizationId)}
      onSwitchOrganization={session.switchOrganization}
      session={readySession}
    >
      {children}
    </AppShell>
  );

  if (featureLoadFailed) {
    return shell(
      <section>
        <p role="alert">We could not load your session. Please try again.</p>
        <button
          onClick={() => {
            setFeatureAttempt((value) => value + 1);
          }}
          type="button"
        >
          Try again
        </button>
      </section>,
    );
  }

  if (featureFlags === undefined) return shell(<p>Loading workspace…</p>);

  return shell(
    <Hero
      allowedModels={readySession.membership.allowedModels}
      flags={featureFlags}
      organizationId={organizationId}
    />,
  );
}
