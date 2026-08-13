'use client';

import { ZappApiError } from '@zapp/api-client';
import { useCallback, useEffect, useState } from 'react';

import { createControlPlaneClient, type MeResponse } from '../lib/api';
import {
  activeAppMemberships,
  appSessionStorageKey,
  resolveAppMembership,
  type AppMembership,
} from '../lib/app-session';

interface LoadingSession {
  readonly status: 'loading';
}

interface ErrorSession {
  readonly status: 'error';
}

export interface EmptyAppSession {
  readonly invalidOrganization: boolean;
  readonly profile: MeResponse;
  readonly status: 'empty';
}

export interface ReadyAppSession {
  readonly invalidOrganization: boolean;
  readonly membership: AppMembership;
  readonly memberships: readonly AppMembership[];
  readonly profile: MeResponse;
  readonly status: 'ready';
}

export type AppSessionSnapshot =
  | EmptyAppSession
  | ErrorSession
  | LoadingSession
  | ReadyAppSession;

export interface AppSessionController {
  readonly membership: AppMembership | undefined;
  readonly organizationId: string | undefined;
  readonly profile: MeResponse | undefined;
  readonly retry: () => void;
  readonly signOut: (organizationId: string) => Promise<void>;
  readonly snapshot: AppSessionSnapshot;
  readonly state: AppSessionSnapshot['status'];
  readonly switchOrganization: (organizationId: string) => void;
}

function organizationOverride(): string | null {
  return new URLSearchParams(window.location.search).get('organizationId');
}

export function useAppSession(): AppSessionController {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<AppSessionSnapshot>({ status: 'loading' });

  useEffect(() => {
    const abortController = new AbortController();
    setSnapshot({ status: 'loading' });

    const load = async (): Promise<void> => {
      try {
        const profile = await createControlPlaneClient().getMe(abortController.signal);
        const storageKey = appSessionStorageKey(profile.user.id);
        const selected = resolveAppMembership(
          profile.memberships,
          organizationOverride(),
          localStorage.getItem(storageKey),
        );

        if (selected.membership === undefined) {
          setSnapshot({
            invalidOrganization: selected.invalidOverride,
            profile,
            status: 'empty',
          });
          return;
        }

        localStorage.setItem(storageKey, selected.membership.organization.id);
        await createControlPlaneClient(selected.membership.organization.id).getMe(
          abortController.signal,
        );
        setSnapshot({
          invalidOrganization: selected.invalidOverride,
          membership: selected.membership,
          memberships: activeAppMemberships(profile.memberships),
          profile,
          status: 'ready',
        });
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (error instanceof ZappApiError && error.status === 401) {
          window.location.replace('/login');
          return;
        }
        setSnapshot({ status: 'error' });
      }
    };

    void load();
    return () => {
      abortController.abort();
    };
  }, [attempt]);

  const retry = useCallback((): void => {
    setAttempt((value) => value + 1);
  }, []);

  const switchOrganization = useCallback((organizationId: string): void => {
    const url = new URL(window.location.href);
    url.searchParams.set('organizationId', organizationId);
    window.location.assign(`${url.pathname}${url.search}${url.hash}`);
  }, []);

  const signOut = useCallback(async (organizationId: string): Promise<void> => {
    await createControlPlaneClient(organizationId).logout();
    window.location.assign('/login');
  }, []);

  return {
    membership: snapshot.status === 'ready' ? snapshot.membership : undefined,
    organizationId: snapshot.status === 'ready'
      ? snapshot.membership.organization.id
      : undefined,
    profile: snapshot.status === 'ready' || snapshot.status === 'empty'
      ? snapshot.profile
      : undefined,
    retry,
    signOut,
    snapshot,
    state: snapshot.status,
    switchOrganization,
  };
}
