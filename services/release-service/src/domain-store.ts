import { idSchema } from '@zapp/contracts';
import { environmentDomains, environments, type Database } from '@zapp/db';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  createDomainService,
  DomainRequestSchema,
  DomainResultSchema,
  type DomainDependencies,
  type DomainRequest,
  type DomainResult,
} from './domains/service.js';

export { DomainResultSchema } from './domains/service.js';

export const DomainListInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env').optional(),
  })
  .strict();

export interface DomainPort {
  configure(input: DomainRequest): Promise<DomainResult>;
  poll(input: DomainRequest): Promise<DomainResult>;
  list(input: z.infer<typeof DomainListInputSchema>): Promise<DomainResult[]>;
}

function rowView(row: typeof environmentDomains.$inferSelect) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    hostname: row.hostname,
    operationKey: row.operationKey,
    fingerprint: row.fingerprint,
    providerId: row.providerId,
    providerDomainReference: row.providerDomainReference,
    status: row.status,
    dnsInstructions: row.dnsInstructionsJson,
    routing: row.routingJson,
    detail: row.detail,
    verificationAttempt: row.verificationAttempt,
  };
}

export function createPostgresDomainPort(
  database: Database,
  external: Pick<DomainDependencies, 'dns' | 'provider'>,
): DomainPort {
  const context: DomainDependencies['context'] = {
    async resolve(input) {
      const [environment] = await database
        .select({ providerId: environments.deploymentProvider })
        .from(environments)
        .where(
          and(
            eq(environments.organizationId, input.organizationId),
            eq(environments.projectId, input.projectId),
            eq(environments.id, input.environmentId),
          ),
        )
        .limit(1);
      if (environment?.providerId === null || environment === undefined) {
        throw new Error('domain_environment_not_found');
      }
      return { providerId: environment.providerId };
    },
  };
  const store: DomainDependencies['store'] = {
    async get(input) {
      const [row] = await database
        .select()
        .from(environmentDomains)
        .where(
          and(
            eq(environmentDomains.organizationId, input.organizationId),
            eq(environmentDomains.projectId, input.projectId),
            eq(environmentDomains.environmentId, input.environmentId),
            eq(environmentDomains.hostname, input.hostname),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : rowView(row);
    },
    async claim(input) {
      await database
        .insert(environmentDomains)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          hostname: input.hostname,
          operationKey: input.operationKey,
          fingerprint: input.fingerprint,
          providerId: input.providerId,
          providerDomainReference: input.providerDomainReference,
          status: input.status,
          dnsInstructionsJson: input.dnsInstructions,
          routingJson: input.routing,
          detail: input.detail,
          verificationAttempt: input.verificationAttempt,
        })
        .onConflictDoNothing();
      const value = await store.get(input);
      if (value === undefined) throw new Error('domain_operation_conflict');
      return value;
    },
    async update(input) {
      const [row] = await database
        .update(environmentDomains)
        .set({
          providerDomainReference: input.providerDomainReference,
          status: input.status,
          dnsInstructionsJson: input.dnsInstructions,
          routingJson: input.routing,
          detail: input.detail,
          verificationAttempt: input.verificationAttempt,
        })
        .where(
          and(
            eq(environmentDomains.organizationId, input.organizationId),
            eq(environmentDomains.projectId, input.projectId),
            eq(environmentDomains.environmentId, input.environmentId),
            eq(environmentDomains.hostname, input.hostname),
            eq(environmentDomains.status, input.expectedStatus),
            eq(environmentDomains.verificationAttempt, input.expectedVerificationAttempt),
          ),
        )
        .returning();
      if (row === undefined) throw new Error('domain_state_conflict');
      return rowView(row);
    },
  };
  const service = createDomainService({ ...external, context, store });
  return {
    configure: (input) => service.configure(DomainRequestSchema.parse(input)),
    poll: (input) => service.poll(DomainRequestSchema.parse(input)),
    async list(rawInput) {
      const input = DomainListInputSchema.parse(rawInput);
      const rows = await database
        .select()
        .from(environmentDomains)
        .where(
          and(
            eq(environmentDomains.organizationId, input.organizationId),
            eq(environmentDomains.projectId, input.projectId),
            input.environmentId === undefined
              ? undefined
              : eq(environmentDomains.environmentId, input.environmentId),
          ),
        )
        .orderBy(asc(environmentDomains.hostname))
        .limit(100);
      return rows.map((row) =>
        DomainResultSchema.parse({
          hostname: row.hostname,
          environmentId: row.environmentId,
          status: row.status,
          dnsInstructions: row.dnsInstructionsJson,
          routing: row.routingJson,
          ssl: { managed: true, status: row.status === 'active' ? 'active' : row.status === 'failed' ? 'failed' : 'pending' },
          ...(row.detail === null ? {} : { detail: row.detail }),
        }),
      );
    },
  };
}
