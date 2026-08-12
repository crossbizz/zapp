'use client';

import posthog from 'posthog-js';

import type { FeatureFlagsResponse } from './api';

export interface HomeFeatureFlags {
  readonly mobileApp: boolean;
  readonly voiceInput: boolean;
}

export function homeFeatureFlags(response: FeatureFlagsResponse): HomeFeatureFlags {
  return {
    mobileApp: response.flags['mobile-app-tab'],
    voiceInput: response.flags['voice-input'],
  };
}

/**
 * The public API is authoritative. Its evaluated values bootstrap the browser
 * SDK so the initial UI cannot flash from catalog defaults to provider state.
 */
export function bootstrapHomeFeatureFlags(
  organizationId: string,
  response: FeatureFlagsResponse,
): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key === undefined || key.length === 0) return;
  if (!posthog.__loaded) {
    const configuredHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    posthog.init(key, {
      api_host:
        configuredHost === undefined || configuredHost.length === 0
          ? 'https://us.i.posthog.com'
          : configuredHost,
      bootstrap: { featureFlags: response.flags },
      capture_pageleave: false,
      capture_pageview: false,
      person_profiles: 'identified_only',
    });
  }
  posthog.group('organization', organizationId);
}
