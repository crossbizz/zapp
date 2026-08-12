import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { tenantOf } from '../plugins/tenant.js';
import type { CreditBalanceGate } from '../usage/limits.js';
import { UsageCategorySchema, type UsageLedgerRepository } from '../usage/ledger.js';

const UsageWindowQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(({ from, to }) => Date.parse(from) < Date.parse(to), {
    message: 'from must be before to',
    path: ['to'],
  });

const DecimalSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/u);
const UsageSummaryResponseSchema = z
  .object({
    window: UsageWindowQuerySchema,
    credits: z
      .object({
        available: DecimalSchema,
        wallet: DecimalSchema,
        reserved: DecimalSchema,
        source: z.enum(['wallet', 'cache', 'grace']),
      })
      .strict(),
    usage: z
      .object({
        byCategory: z.array(
          z.object({ category: UsageCategorySchema, credits: DecimalSchema }).strict(),
        ),
        byProject: z.array(
          z.object({ projectId: idSchema('proj').nullable(), credits: DecimalSchema }).strict(),
        ),
        byRun: z.array(
          z.object({ runId: idSchema('run').nullable(), credits: DecimalSchema }).strict(),
        ),
      })
      .strict(),
  })
  .strict();

export interface PublicUsageRoutesDependencies {
  readonly ledger: UsageLedgerRepository;
  readonly credits: CreditBalanceGate;
}

/** WEB-16's versioned, tenant-scoped usage read model. */
export function registerPublicUsageRoutes(
  app: AppInstance,
  dependencies: PublicUsageRoutesDependencies,
): void {
  app.get(
    '/v1/usage/summary',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        querystring: UsageWindowQuerySchema,
        response: { 200: UsageSummaryResponseSchema },
      },
    },
    async (request) => {
      const organizationId = tenantOf(request).organizationId;
      const window = UsageWindowQuerySchema.parse(request.query);
      const [usage, credits] = await Promise.all([
        dependencies.ledger.getUsageSummary(organizationId, window),
        dependencies.credits.availableCredits(organizationId),
      ]);
      return UsageSummaryResponseSchema.parse({
        window,
        credits: {
          available: credits.availableCredits,
          wallet: credits.walletBalance,
          reserved: credits.reservedCredits,
          source: credits.source,
        },
        usage,
      });
    },
  );
}
