'use client';

import posthog from 'posthog-js';

export interface HomeFeatureFlags {
  readonly mobileApp: boolean;
  readonly voiceInput: boolean;
}

interface FeatureFlagClient {
  group?(type: string, key: string): void;
  isFeatureEnabled(flag: string): boolean | undefined;
  onFeatureFlags?(callback: () => void): (() => void) | undefined;
}

interface PostHogWindow extends Window {
  readonly posthog?: FeatureFlagClient;
}

const defaultFlags: HomeFeatureFlags = { mobileApp: false, voiceInput: false };
let initialized = false;

function configuredClient(): FeatureFlagClient | undefined {
  const injected = (window as PostHogWindow).posthog;
  if (injected !== undefined) return injected;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key === undefined || key.length === 0) return undefined;

  if (!initialized) {
    const configuredHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    posthog.init(key, {
      api_host: configuredHost === undefined || configuredHost.length === 0
        ? 'https://us.i.posthog.com'
        : configuredHost,
      capture_pageleave: false,
      capture_pageview: false,
      person_profiles: 'identified_only',
    });
    initialized = true;
  }
  return posthog;
}

function readFlags(client: FeatureFlagClient): HomeFeatureFlags {
  return {
    mobileApp: client.isFeatureEnabled('mobile-app-tab') === true,
    voiceInput: client.isFeatureEnabled('voice-input') === true,
  };
}

export function subscribeToHomeFeatureFlags(
  organizationId: string,
  onChange: (flags: HomeFeatureFlags) => void,
): () => void {
  const client = configuredClient();
  if (client === undefined) {
    onChange(defaultFlags);
    return () => undefined;
  }

  client.group?.('organization', organizationId);
  const refresh = (): void => {
    onChange(readFlags(client));
  };
  refresh();
  const unsubscribe = client.onFeatureFlags?.(refresh);
  return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
}
