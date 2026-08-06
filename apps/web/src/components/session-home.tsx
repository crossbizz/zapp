'use client';

import { ZappApiError } from '@zapp/api-client';
import { useEffect, useState, type ReactElement } from 'react';

import { Hero } from './home/Hero';
import { createControlPlaneClient, type MeResponse } from '../lib/api';
import { organizationStorageKey, resolveOrganization } from '../lib/session';

export function SessionHome(): ReactElement {
  const [profile, setProfile] = useState<MeResponse>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [organizationName, setOrganizationName] = useState<string>();
  const [allowedModels, setAllowedModels] = useState<readonly string[]>([]);
  const [invalidOrganization, setInvalidOrganization] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let current = true;

    const load = async (): Promise<void> => {
      setLoadFailed(false);
      setProfile(undefined);
      setOrganizationId(undefined);
      setOrganizationName(undefined);
      setAllowedModels([]);
      setInvalidOrganization(false);
      try {
        const me = await createControlPlaneClient().getMe();
        if (!current) return;
        const override = new URLSearchParams(window.location.search).get('organizationId');
        const key = organizationStorageKey(me.user.id);
        const selected = resolveOrganization(me.memberships, override, localStorage.getItem(key));
        setProfile(me);
        setInvalidOrganization(selected.invalidOverride);
        if (selected.membership === undefined) return;

        localStorage.setItem(key, selected.membership.organization.id);
        setOrganizationId(selected.membership.organization.id);
        setOrganizationName(selected.membership.organization.name);
        setAllowedModels(selected.membership.allowedModels);
        const organizationClient = createControlPlaneClient(selected.membership.organization.id);
        await organizationClient.getMe();
      } catch (error) {
        if (error instanceof ZappApiError && error.status === 401) {
          window.location.replace('/login');
          return;
        }
        if (current) setLoadFailed(true);
      }
    };

    void load();
    return () => {
      current = false;
    };
  }, [loadAttempt]);

  if (loadFailed) {
    return (
      <main>
        <p role="alert">We could not load your session. Please try again.</p>
        <button
          type="button"
          onClick={() => {
            setLoadAttempt((value) => value + 1);
          }}
        >
          Try again
        </button>
      </main>
    );
  }

  if (profile === undefined) return <main>Loading session…</main>;

  if (organizationId === undefined || organizationName === undefined) {
    return (
      <main>
        <h1>{profile.user.displayName}</h1>
        {invalidOrganization ? <p>Invalid organization selection.</p> : null}
        <p>No active organization.</p>
      </main>
    );
  }

  return (
    <main>
      <Hero
        allowedModels={allowedModels}
        invalidOrganization={invalidOrganization}
        organizationId={organizationId}
        organizationName={organizationName}
        profile={profile}
      />
    </main>
  );
}
