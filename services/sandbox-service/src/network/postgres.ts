import { createHash } from 'node:crypto';

import { AuditRecordSchema } from '@zapp/contracts';
import { auditEvents, type Database } from '@zapp/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  NetworkPolicyRecordSchema,
  type NetworkPolicyRecorder,
} from './profiles.js';

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function deterministicAuditId(operationKey: string, namespace: string): string {
  let value = BigInt(`0x${createHash('sha256').update(`${namespace}:${operationKey}`).digest('hex')}`);
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD[Number(value & 31n)] ?? '0'}${encoded}`;
    value >>= 5n;
  }
  return `aud_${encoded}`;
}

/** Append exactly one audit row for a stable operation and fail on identity conflict. */
export async function appendIdempotentSandboxAudit(
  database: Database,
  operationKeyValue: string,
  namespace: string,
  recordValue: unknown,
): Promise<void> {
  const operationKey = OperationKeySchema.parse(operationKeyValue);
  const record = AuditRecordSchema.parse(recordValue);
  const id = deterministicAuditId(operationKey, z.string().min(1).parse(namespace));
  const candidate = {
    id,
    organizationId: record.organizationId,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    metadataJson: record.metadata,
    occurredAt: record.occurredAt,
  };
  const inserted = await database
    .insert(auditEvents)
    .values(candidate)
    .onConflictDoNothing({ target: auditEvents.id })
    .returning();
  if (inserted.length === 1) return;
  const [existing] = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.id, id))
    .limit(1);
  if (
    existing === undefined ||
    existing.organizationId !== candidate.organizationId ||
    existing.action !== candidate.action ||
    existing.targetType !== candidate.targetType ||
    existing.targetId !== candidate.targetId ||
    JSON.stringify(existing.metadataJson) !== JSON.stringify(candidate.metadataJson)
  ) {
    throw new Error('Sandbox audit operation key has a conflicting identity.');
  }
}

/** PostgreSQL append-only network-policy evidence; retries replay one stable row. */
export function createPostgresNetworkPolicyRecorder(database: Database): NetworkPolicyRecorder {
  return {
    async record(recordValue) {
      const record = NetworkPolicyRecordSchema.parse(recordValue);
      await appendIdempotentSandboxAudit(
        database,
        record.operationKey,
        'network-policy',
        {
          organizationId: record.organizationId,
          actorType: 'service',
          actorId: 'sandbox-service',
          action: 'workspace.created',
          targetType: 'workspace',
          targetId: record.workspaceId,
          metadata: {
            recordKind: 'network_policy_applied',
            operationKey: record.operationKey,
            projectId: record.projectId,
            profile: record.policy.profile,
            outboundDomains: record.policy.outboundDomains,
            blockAll: record.policy.blockAll,
            providerEnforced: record.providerEnforced,
          },
          occurredAt: record.recordedAt,
        },
      );
    },
  };
}
