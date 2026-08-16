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

const sessionRequestTimeoutMs = 4_000;
const sessionLoadAttempts = 2;

class SessionRequestTimeoutError extends Error {
  constructor() {
    super('Session request timed out.');
    this.name = 'SessionRequestTimeoutError';
  }
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

async function withSessionDeadline<T>(
  parentSignal: AbortSignal,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const requestController = new AbortController();
  const abortRequest = (): void => {
    requestController.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) abortRequest();
  else parentSignal.addEventListener('abort', abortRequest, { once: true });
  const timeout = window.setTimeout(() => {
    requestController.abort(new SessionRequestTimeoutError());
  }, sessionRequestTimeoutMs);

  try {
    return await request(requestController.signal);
  } catch (error) {
    if (
      requestController.signal.reason instanceof SessionRequestTimeoutError &&
      !parentSignal.aborted
    ) {
      throw requestController.signal.reason;
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abortRequest);
  }
}

function isRetryableSessionError(error: unknown): boolean {
  return error instanceof SessionRequestTimeoutError || error instanceof TypeError;
}

export function useAppSession(): AppSessionController {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<AppSessionSnapshot>({ status: 'loading' });

  useEffect(() => {
    const abortController = new AbortController();
    setSnapshot({ status: 'loading' });

    const loadOnce = async (): Promise<AppSessionSnapshot> => {
      const profile = await withSessionDeadline(abortController.signal, async (signal) =>
        await createControlPlaneClient().getMe(signal),
      );
      const storageKey = appSessionStorageKey(profile.user.id);
      const selected = resolveAppMembership(
        profile.memberships,
        organizationOverride(),
        localStorage.getItem(storageKey),
      );

      if (selected.membership === undefined) {
        return {
          invalidOrganization: selected.invalidOverride,
          profile,
          status: 'empty',
        };
      }

      const membership = selected.membership;
      localStorage.setItem(storageKey, membership.organization.id);
      await withSessionDeadline(abortController.signal, async (signal) =>
        await createControlPlaneClient(membership.organization.id).getMe(signal),
      );
      return {
        invalidOrganization: selected.invalidOverride,
        membership,
        memberships: activeAppMemberships(profile.memberships),
        profile,
        status: 'ready',
      };
    };

    const load = async (): Promise<void> => {
      try {
        let lastError: unknown;
        for (let loadAttempt = 0; loadAttempt < sessionLoadAttempts; loadAttempt += 1) {
          try {
            const nextSnapshot = await loadOnce();
            if (!abortController.signal.aborted) setSnapshot(nextSnapshot);
            return;
          } catch (error) {
            lastError = error;
            if (
              abortController.signal.aborted ||
              !isRetryableSessionError(error) ||
              loadAttempt === sessionLoadAttempts - 1
            ) {
              throw error;
            }
          }
        }
        throw lastError;
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
