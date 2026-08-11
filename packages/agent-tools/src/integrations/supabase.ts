import { z } from 'zod';

import type { MigrationPort } from '../mutation.js';
import type { ProjectDataPort } from '../read.js';

const ConnectionRequestSchema = z
  .object({
    organizationId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    environmentId: z.string().trim().min(1),
  })
  .strict();
const ConnectionSchema = z
  .object({
    projectRef: z.string().trim().min(1),
    accessToken: z.string().trim().min(1),
  })
  .strict();
const SchemaResultSchema = z
  .object({
    dialect: z.literal('postgresql'),
    tables: z.array(z.unknown()),
  })
  .strict();

export interface SupabaseToolConnectionPort {
  forEnvironment(
    input: z.infer<typeof ConnectionRequestSchema>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface SupabaseToolSchemaPort {
  readSchema(
    input: z.infer<typeof ConnectionSchema> & { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

export function createSupabaseProjectDataPort(input: {
  readonly base: ProjectDataPort;
  readonly connections: SupabaseToolConnectionPort;
  readonly schema: SupabaseToolSchemaPort;
}): ProjectDataPort {
  return {
    readLogs: (request, context, signal) => input.base.readLogs(request, context, signal),
    readTestResults: (request, context, signal) =>
      input.base.readTestResults(request, context, signal),
    readLatestProjectContract: (context, signal) =>
      input.base.readLatestProjectContract(context, signal),
    async readDatabaseSchema(request, context, signal) {
      const scope = ConnectionRequestSchema.parse({
        organizationId: context.organizationId,
        projectId: context.projectId,
        environmentId: request.environmentId,
      });
      const connection = ConnectionSchema.parse(
        await input.connections.forEnvironment(scope, signal),
      );
      const schema = SchemaResultSchema.parse(
        await input.schema.readSchema({ ...connection, signal }),
      );
      return {
        ok: true,
        dialect: schema.dialect,
        schema: JSON.stringify(schema.tables),
      };
    },
  };
}

/** INT-6 supplies the pipeline. This adapter never receives a SQL client. */
export function createSupabaseMigrationPort(pipeline: MigrationPort): MigrationPort {
  return {
    executeMigration: (input, context, signal) => pipeline.executeMigration(input, context, signal),
  };
}
