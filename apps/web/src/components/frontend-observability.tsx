'use client';

import { getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';

import { buildWebFaroConfig, installWebFaroBundleId } from '../observability/faro-config';

let initialized = false;

export function FrontendObservability(): null {
  const config = buildWebFaroConfig({
    NEXT_PUBLIC_FARO_URL: process.env['NEXT_PUBLIC_FARO_URL'],
    NEXT_PUBLIC_ZAPP_ENV: process.env['NEXT_PUBLIC_ZAPP_ENV'],
    NEXT_PUBLIC_ZAPP_RELEASE: process.env['NEXT_PUBLIC_ZAPP_RELEASE'],
    NEXT_PUBLIC_FARO_BUNDLE_ID: process.env['NEXT_PUBLIC_FARO_BUNDLE_ID'],
  });
  if (config !== null && !initialized) {
    installWebFaroBundleId(config);
    initializeFaro({
      ...config,
      instrumentations: [...getWebInstrumentations(), new TracingInstrumentation()],
    });
    initialized = true;
  }
  return null;
}
