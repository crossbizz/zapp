import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

import { UsageLedgerRowSchema } from './recorder.js';

const UsageResponseSchema = z
  .object({ ledgerRowId: z.string().min(1), event: z.unknown() })
  .strict();

export interface ControlPlaneUsageLedgerClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createControlPlaneUsageLedgerClient(options: ControlPlaneUsageLedgerClientOptions) {
  const baseUrl = z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'Control API URL must use HTTP or HTTPS')
    .parse(options.baseUrl);
  const signer = createServiceTokenSigner(options.serviceTokens);
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async appendIfAbsent(rawRow: unknown): Promise<void> {
      const row = UsageLedgerRowSchema.parse(rawRow);
      const { token } = await signer.signServiceToken({
        service: 'sandbox-service',
        aud: 'control-api:usage.ingest',
      });
      let response: Response;
      try {
        response = await request(new URL('/internal/usage', baseUrl).toString(), {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'x-zapp-service-token': token,
          },
          body: JSON.stringify({
            operationKey: row.id,
            organizationId: row.organizationId,
            projectId: row.projectId,
            runId: row.runId,
            taskId: row.taskId,
            category: row.category,
            provider: row.provider,
            quantity: row.quantity,
            unit: row.unit,
            costUsd: row.costUsd,
            creditsCharged: row.creditsCharged,
            occurredAt: row.occurredAt,
            metadata: {},
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new Error('The usage ledger service could not be reached.', { cause: error });
      }
      if (response.status !== 200) {
        throw new Error(`The usage ledger service refused the request (${String(response.status)}).`);
      }
      UsageResponseSchema.parse(await response.json());
    },
  };
}
