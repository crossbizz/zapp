import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { UsageEntrySchema, type UsageLedgerRepository } from '../usage/ledger.js';
import { FlexpriceUsageEventSchema } from '../usage/outbox.js';

const UsageResponseSchema = z
  .object({ ledgerRowId: z.string().min(1), event: FlexpriceUsageEventSchema })
  .strict();

/** Service-only emitter for usage that does not cross ADR-0025's model boundary. */
export function registerInternalUsageRoutes(app: AppInstance, ledger: UsageLedgerRepository): void {
  app.post(
    '/internal/usage',
    {
      onRequest: app.requireService({
        audience: 'control-api:usage.ingest',
        callers: [
          'orchestrator-worker',
          'sandbox-service',
          'verification-service',
          'release-service',
          'git-service',
          'control-api',
        ],
        singleUse: false,
      }),
      schema: { body: UsageEntrySchema, response: { 200: UsageResponseSchema } },
    },
    async (request) => {
      const recorded = await ledger.recordUsage(request.body);
      return { ledgerRowId: recorded.ledgerRowId, event: recorded.event };
    },
  );
}
