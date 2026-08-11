import { idSchema, newId } from '@zapp/contracts';
import {
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

import type { AuditHook } from '../../plugins/audit.js';
import type { IntegrationMutationInput, IntegrationPort } from '../../routes/integrations.js';
import { encryptSecret, type MasterKeyPort, type SecretEnvelope } from '../../secrets/crypto.js';
import type { SecretRead, SecretVault } from '../../secrets/vault.js';
import { vaultRef, type TenantDbFactory } from '../../tenant/db.js';
import { IntegrationConnectionSchema, type IntegrationConnectionView } from '../../tenant/view.js';

export const GENERATED_APP_STRIPE_SECRET_NAME = 'GENERATED_APP_STRIPE_RESTRICTED_KEY';
export const PLATFORM_BILLING_STRIPE_SECRET_NAME = 'PLATFORM_BILLING_STRIPE_SECRET_KEY';

const StripeScopeSchema = z.enum(['generated_app', 'platform_billing']);
export type StripeCredentialScope = z.infer<typeof StripeScopeSchema>;

const StripeModeSchema = z.enum(['test', 'live']);
const StoredStripeConfigurationSchema = z
  .object({
    accountId: z.string().trim().min(1).max(200),
    mode: StripeModeSchema,
  })
  .strict();
const StripeConnectInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    actorId: idSchema('user'),
    operationKey: z.string().trim().min(1).max(200),
    accountId: z.string().trim().min(1).max(200),
    mode: StripeModeSchema,
    apiKey: z
      .string()
      .trim()
      .max(10_000)
      .regex(/^rk_(?:test|live)_[A-Za-z0-9]+$/u),
  })
  .strict();
const StripeAccountSchema = z.object({ id: z.string().trim().min(1).max(200) }).passthrough();

export interface StripeAccountPort {
  retrieve(input: {
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly id: string }>;
}

export function createStripeAccountClient(
  options: {
    readonly fetcher?: typeof fetch;
    readonly baseUrl?: string;
  } = {},
): StripeAccountPort {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl ?? 'https://api.stripe.com';
  return {
    async retrieve(input) {
      const response = await fetcher(`${baseUrl}/v1/account`, {
        method: 'GET',
        headers: { authorization: `Bearer ${input.apiKey}` },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!response.ok) throw new Error('Stripe account lookup failed');
      return StripeAccountSchema.parse(await response.json());
    },
  };
}

interface GeneratedAppStripeIntegrationOptions {
  readonly database: Database;
  readonly masterKey: MasterKeyPort;
  readonly accounts: StripeAccountPort;
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

function assertReplay(
  connection: IntegrationConnectionView,
  expected: z.infer<typeof StoredStripeConfigurationSchema>,
): void {
  const existing = StoredStripeConfigurationSchema.parse(connection.configuration);
  if (existing.accountId !== expected.accountId || existing.mode !== expected.mode) {
    throw new Error('Stripe project already has a different generated-app connection');
  }
}

async function insertSecret(
  tx: Transaction,
  input: {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly createdBy: string;
    readonly envelope: SecretEnvelope;
    readonly now: Date;
  },
): Promise<void> {
  await tx.insert(secretMetadata).values({
    id: input.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: null,
    name: GENERATED_APP_STRIPE_SECRET_NAME,
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

export function createGeneratedAppStripeIntegrationPort(
  options: GeneratedAppStripeIntegrationOptions,
): IntegrationPort {
  return {
    async connect(request: IntegrationMutationInput) {
      if (request.provider !== 'stripe') {
        throw new Error('Generated-app Stripe integration received a different provider');
      }
      const configuration = StoredStripeConfigurationSchema.parse(request.configuration);
      const input = StripeConnectInputSchema.parse({
        organizationId: request.organizationId,
        projectId: request.projectId,
        actorId: request.actorId,
        operationKey: request.operationKey,
        accountId: configuration.accountId,
        mode: configuration.mode,
        apiKey: request.credential,
      });
      if (!input.apiKey.startsWith(`rk_${input.mode}_`)) {
        throw new Error('Stripe restricted key mode does not match the requested mode');
      }

      const replay = await options.database.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(integrationConnections)
          .where(
            and(
              eq(integrationConnections.organizationId, input.organizationId),
              eq(integrationConnections.projectId, input.projectId),
              eq(integrationConnections.provider, 'stripe'),
            ),
          )
          .limit(1);
        if (existing === undefined) return undefined;
        const result = view(existing);
        assertReplay(result, configuration);
        await request.audit(tx, result);
        return result;
      });
      if (replay !== undefined) return replay;

      const account = StripeAccountSchema.parse(
        await options.accounts.retrieve({ apiKey: input.apiKey }),
      );
      if (account.id !== input.accountId) {
        throw new Error('Stripe key does not match the requested account');
      }
      const envelope = await encryptSecret(input.apiKey, options.masterKey);
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
        if (project === undefined) throw new Error('Stripe project does not exist');

        const [existing] = await tx
          .select()
          .from(integrationConnections)
          .where(
            and(
              eq(integrationConnections.organizationId, input.organizationId),
              eq(integrationConnections.projectId, input.projectId),
              eq(integrationConnections.provider, 'stripe'),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          const result = view(existing);
          assertReplay(result, configuration);
          await request.audit(tx, result);
          return result;
        }

        const credentialId = newId('sec');
        await insertSecret(tx, {
          id: credentialId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          createdBy: input.actorId,
          envelope,
          now,
        });
        const [connection] = await tx
          .insert(integrationConnections)
          .values({
            id: newId('intc'),
            organizationId: input.organizationId,
            projectId: input.projectId,
            provider: 'stripe',
            status: 'connected',
            credentialRef: vaultRef(credentialId),
            configurationJson: configuration,
          })
          .returning();
        if (connection === undefined) throw new Error('Stripe connection insert returned no row');
        const result = view(connection);
        await request.audit(tx, result);
        return result;
      });
    },
  };
}

export interface StripeCredentialReader {
  read(input: {
    readonly organizationId: string;
    readonly projectId: string | null;
    readonly secretId: string;
    readonly audit: AuditHook<SecretRead>;
  }): Promise<string | undefined>;
}

export function createStripeCredentialReader(input: {
  readonly vault: SecretVault;
  readonly tenantDb: TenantDbFactory;
  readonly scope: StripeCredentialScope;
}): StripeCredentialReader {
  const scope = StripeScopeSchema.parse(input.scope);
  const name =
    scope === 'generated_app'
      ? GENERATED_APP_STRIPE_SECRET_NAME
      : PLATFORM_BILLING_STRIPE_SECRET_NAME;
  return {
    async read(request) {
      const metadata = await input
        .tenantDb(request.organizationId)
        .secrets.getById(request.secretId);
      if (metadata?.name !== name || metadata.projectId !== request.projectId) return undefined;
      const decrypted = await input.vault.decrypt({
        organizationId: request.organizationId,
        secretId: request.secretId,
        audit: request.audit,
      });
      return decrypted?.name === name && decrypted.projectId === request.projectId
        ? decrypted.value
        : undefined;
    },
  };
}
