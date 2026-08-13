import {
  faro,
  getWebInstrumentations,
  initializeFaro,
} from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import { z } from "zod";

const EnabledDesktopFaroEnvironmentSchema = z
  .object({
    VITE_FARO_URL: z.string().url(),
    VITE_ZAPP_ENV: z.enum(["development", "test", "staging", "production"]),
    VITE_ZAPP_RELEASE: z.string().trim().min(1).max(200),
    VITE_FARO_BUNDLE_ID: z.string().trim().min(1).max(200),
  })
  .strict();

export interface DesktopFaroConfig {
  readonly url: string;
  readonly app: {
    readonly name: "zapp-desktop";
    readonly namespace: "zapp";
    readonly version: string;
    readonly environment: "development" | "test" | "staging" | "production";
  };
  readonly bundleId: string;
}

export function buildDesktopFaroConfig(
  environment: Readonly<Record<string, string | undefined>>,
  telemetryConsent: boolean,
): DesktopFaroConfig | null {
  if (!telemetryConsent || environment["VITE_FARO_URL"] === undefined)
    return null;
  const parsed = EnabledDesktopFaroEnvironmentSchema.parse({
    VITE_FARO_URL: environment["VITE_FARO_URL"],
    VITE_ZAPP_ENV: environment["VITE_ZAPP_ENV"],
    VITE_ZAPP_RELEASE: environment["VITE_ZAPP_RELEASE"],
    VITE_FARO_BUNDLE_ID: environment["VITE_FARO_BUNDLE_ID"],
  });
  return {
    url: parsed.VITE_FARO_URL,
    app: {
      name: "zapp-desktop",
      namespace: "zapp",
      version: parsed.VITE_ZAPP_RELEASE,
      environment: parsed.VITE_ZAPP_ENV,
    },
    bundleId: parsed.VITE_FARO_BUNDLE_ID,
  };
}

export function installDesktopFaroBundleId(
  config: DesktopFaroConfig,
  target: Record<string, unknown> = globalThis as Record<string, unknown>,
): void {
  target[`__faroBundleId_${config.app.name}`] = config.bundleId;
}

export function initializeDesktopFaro(
  environment: Readonly<Record<string, string | undefined>>,
  telemetryConsent: boolean,
): void {
  const config = buildDesktopFaroConfig(environment, telemetryConsent);
  if (config === null || faro.api) return;
  installDesktopFaroBundleId(config);
  initializeFaro({
    ...config,
    instrumentations: [
      ...getWebInstrumentations(),
      new TracingInstrumentation(),
    ],
  });
}
