import type { ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

import { createControlPlaneUsageLedgerClient } from '../cost/client.js';
import { createControlPlanePreviewEventClient } from '../events/client.js';
import {
  createControlPlaneSecretDecryptClient,
  createScopedSecretInjector,
} from '../secrets/injector.js';

const ControlApiOptionsSchema = z
  .object({ baseUrl: z.string().url() })
  .strict();

export interface SandboxControlApiClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
}

/** All sandbox -> control-plane calls retain route-specific service audiences. */
export function createSandboxControlApiClients(options: SandboxControlApiClientOptions) {
  const { baseUrl } = ControlApiOptionsSchema.parse({ baseUrl: options.baseUrl });
  const shared = { baseUrl, serviceTokens: options.serviceTokens };
  return {
    secrets: createScopedSecretInjector(createControlPlaneSecretDecryptClient(shared)),
    events: createControlPlanePreviewEventClient(shared),
    usage: createControlPlaneUsageLedgerClient(shared),
  };
}
