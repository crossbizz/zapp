import { createHash, randomBytes } from 'node:crypto';

import { idSchema, newId } from '@zapp/contracts';
import {
  environments,
  integrationConnections,
  projects,
  secretCiphertexts,
  secretMetadata,
  type Database,
  type IntegrationConnection,
  type Transaction,
} from '@zapp/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { IntegrationMutationInput, IntegrationPort } from '../../routes/integrations.js';
import { encryptSecret, type MasterKeyPort, type SecretEnvelope } from '../../secrets/crypto.js';
import { vaultRef } from '../../tenant/db.js';
import { IntegrationConnectionSchema, type IntegrationConnectionView } from '../../tenant/view.js';
import {
  configureNeonRoleSeparation,
  connectionStringForRole,
  ensureNeonPreviewBranch,
  type NeonManagementPort,
  type NeonSqlFactory,
} from './branches.js';

const NeonProjectIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9-]+$/u);
const SqlIdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z_][a-z0-9_]*$/u);
const ConnectionStringSchema = z.string().url().max(10_000);
const NeonConnectionSetSchema = z
  .object({
    appConnectionString: ConnectionStringSchema,
    migrationConnectionString: ConnectionStringSchema,
  })
  .strict();
const ConnectedProjectSchema = z
  .object({
    projectId: NeonProjectIdSchema,
    databaseName: SqlIdentifierSchema,
    previewBranchId: NeonProjectIdSchema,
    productionBranchId: NeonProjectIdSchema,
    preview: NeonConnectionSetSchema,
    production: NeonConnectionSetSchema,
  })
  .strict();
const ManagementConnectInputSchema = z
  .object({
    projectId: NeonProjectIdSchema,
    apiKey: z.string().trim().min(1).max(10_000),
    previewBranchName: z.string().trim().min(1).max(256),
    appRole: SqlIdentifierSchema,
    databaseName: SqlIdentifierSchema,
  })
  .strict();
const NeonConnectInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    actorId: idSchema('user'),
    operationKey: z.string().trim().min(1).max(200),
    neonProjectId: NeonProjectIdSchema,
    databaseName: SqlIdentifierSchema,
    apiKey: z.string().trim().min(1).max(10_000),
  })
  .strict();
const StoredConfigurationSchema = z
  .object({
    projectId: NeonProjectIdSchema,
    databaseName: SqlIdentifierSchema,
    previewBranchId: NeonProjectIdSchema,
    productionBranchId: NeonProjectIdSchema,
  })
  .strict();

export interface NeonProjectManagementPort {
  connectExisting(
    input: z.input<typeof ManagementConnectInputSchema>,
  ): Promise<z.input<typeof ConnectedProjectSchema>>;
}

export function createNeonProjectManagementPort(input: {
  readonly management: NeonManagementPort;
  readonly sql: NeonSqlFactory;
}): NeonProjectManagementPort {
  async function separatedConnections(
    migrationConnectionString: string,
    appRole: string,
  ): Promise<z.infer<typeof NeonConnectionSetSchema>> {
    const appPassword = randomBytes(32).toString('base64url');
    const sql = await input.sql.open(migrationConnectionString);
    try {
      await configureNeonRoleSeparation({ sql, appRole, appPassword });
    } finally {
      await sql.close();
    }
    return NeonConnectionSetSchema.parse({
      migrationConnectionString,
      appConnectionString: connectionStringForRole({
        migrationConnectionString,
        appRole,
        appPassword,
      }),
    });
  }

  return {
    async connectExisting(rawInput) {
      const request = ManagementConnectInputSchema.parse(rawInput);
      const project = await input.management.getProject({
        projectId: request.projectId,
        apiKey: request.apiKey,
      });
      if (project.projectId !== request.projectId) {
        throw new Error('neon_connected_a_different_project');
      }
      const branches = await input.management.listBranches({
        projectId: request.projectId,
        apiKey: request.apiKey,
      });
      const productionBranch = branches.find((branch) => branch.isDefault);
      if (productionBranch === undefined) throw new Error('neon_project_has_no_default_branch');
      const productionMigration = await input.management.branchConnection({
        projectId: request.projectId,
        apiKey: request.apiKey,
        branchId: productionBranch.id,
        databaseName: request.databaseName,
      });
      const production = await separatedConnections(productionMigration.uri, request.appRole);

      const previewBranch = await ensureNeonPreviewBranch({
        management: input.management,
        projectId: request.projectId,
        apiKey: request.apiKey,
        name: request.previewBranchName,
        parentBranchId: productionBranch.id,
      });
      const previewMigration = await input.management.branchConnection({
        projectId: request.projectId,
        apiKey: request.apiKey,
        branchId: previewBranch.id,
        databaseName: request.databaseName,
      });
      const preview = await separatedConnections(previewMigration.uri, request.appRole);

      return ConnectedProjectSchema.parse({
        projectId: request.projectId,
        databaseName: request.databaseName,
        productionBranchId: productionBranch.id,
        previewBranchId: previewBranch.id,
        production,
        preview,
      });
    },
  };
}

interface NeonIntegrationOptions {
  readonly database: Database;
  readonly masterKey: MasterKeyPort;
  readonly management: NeonProjectManagementPort;
  readonly now?: () => Date;
}

function view(row: IntegrationConnection): IntegrationConnectionView {
  return IntegrationConnectionSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    provider: row.provider,
    status: row.status,
    credentialRef: row.credentialRef,
    configuration: row.configurationJson,
  });
}

async function insertSecret(
  tx: Transaction,
  input: {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string | null;
    readonly name: string;
    readonly createdBy: string;
    readonly envelope: SecretEnvelope;
    readonly now: Date;
  },
): Promise<void> {
  await tx.insert(secretMetadata).values({
    id: input.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: input.name,
    encryptedValueRef: vaultRef(input.id),
    createdBy: input.createdBy,
    rotatedAt: null,
    keyVersion: input.envelope.keyVersion,
    createdAt: input.now,
  });
  await tx.insert(secretCiphertexts).values({
    secretId: input.id,
    ciphertext: input.envelope.ciphertext,
    iv: input.envelope.iv,
    authTag: input.envelope.authTag,
    wrappedDek: input.envelope.wrappedDek,
  });
}

function assertReplayProject(
  connection: IntegrationConnectionView,
  neonProjectId: string,
  databaseName: string,
): void {
  const configuration = StoredConfigurationSchema.parse(connection.configuration);
  if (configuration.projectId !== neonProjectId || configuration.databaseName !== databaseName) {
    throw new Error('Neon project already has a different connection');
  }
}

export function createNeonIntegrationPort(options: NeonIntegrationOptions): IntegrationPort {
  return {
    async connect(request: IntegrationMutationInput) {
      if (request.provider !== 'neon') {
        throw new Error('Neon integration received a different provider');
      }
      const configuration = z
        .object({ projectId: NeonProjectIdSchema, databaseName: SqlIdentifierSchema })
        .strict()
        .parse(request.configuration);
      const input = NeonConnectInputSchema.parse({
        organizationId: request.organizationId,
        projectId: request.projectId,
        actorId: request.actorId,
        operationKey: request.operationKey,
        neonProjectId: configuration.projectId,
        databaseName: configuration.databaseName,
        apiKey: request.credential,
      });

      return await options.database.transaction(async (tx) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.organizationId, input.organizationId),
            ),
          )
          .limit(1)
          .for('update');
        if (project === undefined) throw new Error('Neon project does not exist');
        const [existing] = await tx
          .select()
          .from(integrationConnections)
          .where(
            and(
              eq(integrationConnections.organizationId, input.organizationId),
              eq(integrationConnections.projectId, input.projectId),
              eq(integrationConnections.provider, 'neon'),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          const result = view(existing);
          assertReplayProject(result, input.neonProjectId, input.databaseName);
          await request.audit(tx, result);
          return result;
        }

        const appRole = `zapp_app_${createHash('sha256').update(input.projectId).digest('hex').slice(0, 16)}`;
        const connected = ConnectedProjectSchema.parse(
          await options.management.connectExisting({
            projectId: input.neonProjectId,
            apiKey: input.apiKey,
            previewBranchName: `preview/zapp-${input.projectId}`,
            appRole,
            databaseName: input.databaseName,
          }),
        );
        if (
          connected.projectId !== input.neonProjectId ||
          connected.databaseName !== input.databaseName
        ) {
          throw new Error('Neon connected a different project or database');
        }
        const [credential, previewApp, previewMigration, productionApp, productionMigration] =
          await Promise.all([
            encryptSecret(input.apiKey, options.masterKey),
            encryptSecret(connected.preview.appConnectionString, options.masterKey),
            encryptSecret(connected.preview.migrationConnectionString, options.masterKey),
            encryptSecret(connected.production.appConnectionString, options.masterKey),
            encryptSecret(connected.production.migrationConnectionString, options.masterKey),
          ]);
        const now = options.now?.() ?? new Date();

        const scopedEnvironments = await tx
          .select({ id: environments.id, type: environments.type })
          .from(environments)
          .where(
            and(
              eq(environments.organizationId, input.organizationId),
              eq(environments.projectId, input.projectId),
            ),
          );
        const previewEnvironment = scopedEnvironments.find(
          (environment) => environment.type === 'preview',
        );
        const productionEnvironment = scopedEnvironments.find(
          (environment) => environment.type === 'production',
        );
        if (previewEnvironment === undefined || productionEnvironment === undefined) {
          throw new Error('Neon requires preview and production environments');
        }

        const credentialId = newId('sec');
        const connectionId = newId('intc');
        await insertSecret(tx, {
          id: credentialId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: null,
          name: 'NEON_API_KEY',
          createdBy: input.actorId,
          envelope: credential,
          now,
        });
        const [connection] = await tx
          .insert(integrationConnections)
          .values({
            id: connectionId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            provider: 'neon',
            status: 'connected',
            credentialRef: vaultRef(credentialId),
            configurationJson: {
              projectId: connected.projectId,
              databaseName: connected.databaseName,
              previewBranchId: connected.previewBranchId,
              productionBranchId: connected.productionBranchId,
            },
          })
          .returning();
        if (connection === undefined) throw new Error('Neon connection insert returned no row');

        for (const secret of [
          {
            environmentId: previewEnvironment.id,
            name: 'NEON_DATABASE_URL',
            envelope: previewApp,
          },
          {
            environmentId: previewEnvironment.id,
            name: 'NEON_MIGRATION_DATABASE_URL',
            envelope: previewMigration,
          },
          {
            environmentId: productionEnvironment.id,
            name: 'NEON_DATABASE_URL',
            envelope: productionApp,
          },
          {
            environmentId: productionEnvironment.id,
            name: 'NEON_MIGRATION_DATABASE_URL',
            envelope: productionMigration,
          },
        ] as const) {
          await insertSecret(tx, {
            id: newId('sec'),
            organizationId: input.organizationId,
            projectId: input.projectId,
            environmentId: secret.environmentId,
            name: secret.name,
            createdBy: input.actorId,
            envelope: secret.envelope,
            now,
          });
        }
        await tx
          .update(environments)
          .set({ databaseConnectionId: connectionId })
          .where(
            and(
              eq(environments.organizationId, input.organizationId),
              eq(environments.projectId, input.projectId),
            ),
          );

        const result = view(connection);
        await request.audit(tx, result);
        return result;
      });
    },
  };
}
