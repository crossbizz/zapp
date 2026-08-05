import {
  AuditActionSchema as PlatformAuditActionSchema,
  GitAuditActionSchema as PlatformGitAuditActionSchema,
  newId,
} from '@zapp/contracts';
import {
  GIT_AUDIT_ACTIONS,
  GitAuditActionSchema as GitServiceAuditActionSchema,
} from '@zapp/git-service';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  AuditActionSchema,
  AuditActorSchema,
  AuditActorTypeSchema,
  AuditEntrySchema,
  AuditMetadataSchema,
  AuditRecordSchema,
  AuditScalarSchema,
  AuditTargetSchema,
  AuditTargetTypeSchema,
  AuditValueSchema,
  type AuditAction,
  type AuditActor,
  type AuditActorType,
  type AuditEntry,
  type AuditMetadata,
  type AuditRecord,
  type AuditScalar,
  type AuditTarget,
  type AuditTargetType,
  type AuditValue,
} from '../src/index.js';
import { JsonValueSchema, type JsonValue } from '../src/orgs/store.js';

describe('schema-inferred service boundaries', () => {
  it('accepts every git-service writer action through the control-api read vocabulary', () => {
    expect(AuditActionSchema).toBe(PlatformAuditActionSchema);
    expect(GitServiceAuditActionSchema).toBe(PlatformGitAuditActionSchema);
    for (const action of GIT_AUDIT_ACTIONS) {
      expect(AuditActionSchema.safeParse(action).success, action).toBe(true);
    }
  });

  it('exports boundary types inferred from their public schemas', () => {
    expectTypeOf<JsonValue>().toEqualTypeOf<z.infer<typeof JsonValueSchema>>();
    expectTypeOf<AuditAction>().toEqualTypeOf<z.infer<typeof AuditActionSchema>>();
    expectTypeOf<AuditActorType>().toEqualTypeOf<z.infer<typeof AuditActorTypeSchema>>();
    expectTypeOf<AuditActor>().toEqualTypeOf<z.infer<typeof AuditActorSchema>>();
    expectTypeOf<AuditTargetType>().toEqualTypeOf<z.infer<typeof AuditTargetTypeSchema>>();
    expectTypeOf<AuditTarget>().toEqualTypeOf<z.infer<typeof AuditTargetSchema>>();
    expectTypeOf<AuditScalar>().toEqualTypeOf<z.infer<typeof AuditScalarSchema>>();
    expectTypeOf<AuditValue>().toEqualTypeOf<z.infer<typeof AuditValueSchema>>();
    expectTypeOf<AuditMetadata>().toEqualTypeOf<z.infer<typeof AuditMetadataSchema>>();
    expectTypeOf<AuditRecord>().toEqualTypeOf<z.infer<typeof AuditRecordSchema>>();
    expectTypeOf<AuditEntry>().toEqualTypeOf<z.infer<typeof AuditEntrySchema>>();
  });

  it('accepts nested JSON settings through one schema and rejects non-JSON values', () => {
    expect(
      JsonValueSchema.parse({ providers: ['anthropic', null], limits: { daily: 25 } }),
    ).toEqual({ providers: ['anthropic', null], limits: { daily: 25 } });
    expect(JsonValueSchema.safeParse({ nested: { invalid: undefined } }).success).toBe(false);
    expect(JsonValueSchema.safeParse({ nested: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it('keeps every writable audit record inside the audit read boundary', () => {
    const record = AuditRecordSchema.parse({
      organizationId: newId('org'),
      actorType: 'user',
      actorId: 'schema-boundary-user',
      action: 'organization.settings_updated',
      targetType: 'organization',
      targetId: newId('org'),
      metadata: {
        changedFields: ['builderCanDeploy', 'defaultModelPolicy'],
        noOp: false,
        operationKey: 'settings-operation-key',
      },
      occurredAt: new Date('2026-08-05T12:00:00.000Z'),
    });

    expect(AuditActorSchema.parse({ type: record.actorType, id: record.actorId })).toEqual({
      type: record.actorType,
      id: record.actorId,
    });
    expect(AuditTargetSchema.parse({ type: record.targetType, id: record.targetId })).toEqual({
      type: record.targetType,
      id: record.targetId,
    });
    expect(AuditMetadataSchema.parse(record.metadata)).toEqual(record.metadata);
    expect(AuditActionSchema.safeParse('organization.settings_updtaed').success).toBe(false);
    expect(AuditMetadataSchema.safeParse({ request: { body: 'nested' } }).success).toBe(false);
  });
});
