import { z } from 'zod';

const EnabledWebFaroEnvironmentSchema = z
  .object({
    NEXT_PUBLIC_FARO_URL: z.string().url(),
    NEXT_PUBLIC_ZAPP_ENV: z.enum(['development', 'test', 'staging', 'production']),
    NEXT_PUBLIC_ZAPP_RELEASE: z.string().trim().min(1).max(200),
    NEXT_PUBLIC_FARO_BUNDLE_ID: z.string().trim().min(1).max(200),
  })
  .strict();

export interface WebFaroConfig {
  readonly url: string;
  readonly app: {
    readonly name: 'zapp-web';
    readonly namespace: 'zapp';
    readonly version: string;
    readonly environment: 'development' | 'test' | 'staging' | 'production';
  };
  readonly bundleId: string;
}

export function buildWebFaroConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WebFaroConfig | null {
  const collectorUrl = environment['NEXT_PUBLIC_FARO_URL'];
  if (collectorUrl === undefined || collectorUrl === '') return null;
  const parsed = EnabledWebFaroEnvironmentSchema.parse({
    NEXT_PUBLIC_FARO_URL: collectorUrl,
    NEXT_PUBLIC_ZAPP_ENV: environment['NEXT_PUBLIC_ZAPP_ENV'],
    NEXT_PUBLIC_ZAPP_RELEASE: environment['NEXT_PUBLIC_ZAPP_RELEASE'],
    NEXT_PUBLIC_FARO_BUNDLE_ID: environment['NEXT_PUBLIC_FARO_BUNDLE_ID'],
  });
  return {
    url: parsed.NEXT_PUBLIC_FARO_URL,
    app: {
      name: 'zapp-web',
      namespace: 'zapp',
      version: parsed.NEXT_PUBLIC_ZAPP_RELEASE,
      environment: parsed.NEXT_PUBLIC_ZAPP_ENV,
    },
    bundleId: parsed.NEXT_PUBLIC_FARO_BUNDLE_ID,
  };
}

export function installWebFaroBundleId(
  config: WebFaroConfig,
  target: Record<string, unknown> = globalThis,
): void {
  target[`__faroBundleId_${config.app.name}`] = config.bundleId;
}
