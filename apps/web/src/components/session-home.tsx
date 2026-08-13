'use client';

import { ZappApiError } from '@zapp/api-client';
import { useEffect, useState, type ReactElement } from 'react';

import { Hero } from './home/Hero';
import { createControlPlaneClient, type MeResponse } from '../lib/api';
import { captureSignup } from '../lib/activation';
import {
  bootstrapHomeFeatureFlags,
  homeFeatureFlags,
  type HomeFeatureFlags,
} from '../lib/feature-flags';
import { organizationStorageKey, resolveOrganization } from '../lib/session';

export function SessionHome(): ReactElement {
  const [profile, setProfile] = useState<MeResponse>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [organizationName, setOrganizationName] = useState<string>();
  const [allowedModels, setAllowedModels] = useState<readonly string[]>([]);
  const [featureFlags, setFeatureFlags] = useState<HomeFeatureFlags>();
  const [invalidOrganization, setInvalidOrganization] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const isCurrent = (): boolean => current;

    const load = async (): Promise<void> => {
      setLoadFailed(false);
      setProfile(undefined);
      setOrganizationId(undefined);
      setOrganizationName(undefined);
      setAllowedModels([]);
      setFeatureFlags(undefined);
      setInvalidOrganization(false);
      try {
        const me = await createControlPlaneClient().getMe();
        if (!isCurrent()) return;
        const override = new URLSearchParams(window.location.search).get('organizationId');
        const key = organizationStorageKey(me.user.id);
        const selected = resolveOrganization(me.memberships, override, localStorage.getItem(key));
        if (selected.membership === undefined) {
          setProfile(me);
          setInvalidOrganization(selected.invalidOverride);
          return;
        }

        localStorage.setItem(key, selected.membership.organization.id);
        const organizationClient = createControlPlaneClient(selected.membership.organization.id);
        const [, flags] = await Promise.all([
          organizationClient.getMe(),
          organizationClient.getFeatureFlags(),
        ]);
        if (!isCurrent()) return;
        bootstrapHomeFeatureFlags(selected.membership.organization.id, flags);
        captureSignup({
          organizationId: selected.membership.organization.id,
          userId: me.user.id,
        });
        setProfile(me);
        setInvalidOrganization(selected.invalidOverride);
        setOrganizationId(selected.membership.organization.id);
        setOrganizationName(selected.membership.organization.name);
        setAllowedModels(selected.membership.allowedModels);
        setFeatureFlags(homeFeatureFlags(flags));
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

  if (
    organizationId === undefined ||
    organizationName === undefined ||
    featureFlags === undefined
  ) {
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
        flags={featureFlags}
        invalidOrganization={invalidOrganization}
        organizationId={organizationId}
        organizationName={organizationName}
        profile={profile}
      />
    </main>
  );
}
