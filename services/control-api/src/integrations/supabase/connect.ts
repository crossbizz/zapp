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
import type { SupabaseManagementPort } from './provision.js';

export type { SupabaseManagementPort } from './provision.js';

const SupabaseConnectInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    actorId: idSchema('user'),
    operationKey: z.string().trim().min(1).max(200),
    projectRef: z.string().trim().min(1).max(200),
    accessToken: z.string().trim().min(1).max(10_000),
  })
  .strict();

interface SupabaseIntegrationOptions {
  readonly database: Database;
  readonly masterKey: MasterKeyPort;
  readonly management: SupabaseManagementPort;
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

export function createSupabaseIntegrationPort(
  options: SupabaseIntegrationOptions,
): IntegrationPort {
  return {
    async connect(request: IntegrationMutationInput) {
      if (request.provider !== 'supabase') {
        throw new Error('Supabase integration received a different provider');
      }
      const configuration = z
        .object({ projectRef: z.string().trim().min(1).max(200) })
        .strict()
        .parse(request.configuration);
      const input = SupabaseConnectInputSchema.parse({
        organizationId: request.organizationId,
        projectId: request.projectId,
        actorId: request.actorId,
        operationKey: request.operationKey,
        projectRef: configuration.projectRef,
        accessToken: request.credential,
      });
      const connected = await options.management.connectExisting({
        projectRef: input.projectRef,
        accessToken: input.accessToken,
      });
      if (connected.projectRef !== input.projectRef) {
        throw new Error('Supabase connected a different project');
      }

      const [credentialEnvelope, previewUrl, productionUrl, previewAnon, productionAnon] =
        await Promise.all([
          encryptSecret(input.accessToken, options.masterKey),
          encryptSecret(connected.url, options.masterKey),
          encryptSecret(connected.url, options.masterKey),
          encryptSecret(connected.anonKey, options.masterKey),
          encryptSecret(connected.anonKey, options.masterKey),
        ]);
      const now = options.now?.() ?? new Date();

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
        if (project === undefined) throw new Error('Supabase project does not exist');

        const [existing] = await tx
          .select()
          .from(integrationConnections)
          .where(
            and(
              eq(integrationConnections.organizationId, input.organizationId),
              eq(integrationConnections.projectId, input.projectId),
              eq(integrationConnections.provider, 'supabase'),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          const replay = view(existing);
          const replayConfiguration = z
            .object({ projectRef: z.string().trim().min(1).max(200) })
            .strict()
            .parse(replay.configuration);
          if (replayConfiguration.projectRef !== input.projectRef) {
            throw new Error('Supabase project already has a different connection');
          }
          await request.audit(tx, replay);
          return replay;
        }

        const scopedEnvironments = await tx
          .select({ id: environments.id, type: environments.type })
          .from(environments)
          .where(
            and(
              eq(environments.organizationId, input.organizationId),
              eq(environments.projectId, input.projectId),
            ),
          );
        const preview = scopedEnvironments.find((environment) => environment.type === 'preview');
        const production = scopedEnvironments.find(
          (environment) => environment.type === 'production',
        );
        if (preview === undefined || production === undefined) {
          throw new Error('Supabase requires preview and production environments');
        }

        const credentialId = newId('sec');
        const connectionId = newId('intc');
        await insertSecret(tx, {
          id: credentialId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: null,
          name: 'SUPABASE_ACCESS_TOKEN',
          createdBy: input.actorId,
          envelope: credentialEnvelope,
          now,
        });
        const [connection] = await tx
          .insert(integrationConnections)
          .values({
            id: connectionId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            provider: 'supabase',
            status: 'connected',
            credentialRef: vaultRef(credentialId),
            configurationJson: { projectRef: input.projectRef },
          })
          .returning();
        if (connection === undefined) throw new Error('Supabase connection insert returned no row');

        for (const secret of [
          { environmentId: preview.id, name: 'SUPABASE_URL', envelope: previewUrl },
          { environmentId: preview.id, name: 'SUPABASE_ANON_KEY', envelope: previewAnon },
          { environmentId: production.id, name: 'SUPABASE_URL', envelope: productionUrl },
          { environmentId: production.id, name: 'SUPABASE_ANON_KEY', envelope: productionAnon },
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
