import { internalRepoRef, newId } from '@zapp/contracts';
import type { Executor } from '@zapp/db';
import { describe, expect, it } from 'vitest';

import {
  GitAuditEventSchema,
  createDbGitAuditSink,
  createRecordingGitAuditSink,
  type GitAuditEvent,
} from '../src/audit.js';

const ORGANIZATION = newId('org');
const PROJECT = newId('proj');
const REF = internalRepoRef({ organizationId: ORGANIZATION, projectId: PROJECT });
const OCCURRED_AT = new Date('2026-03-01T00:00:00.000Z');
const TOKEN_SENTINEL = 'sentinel-token-value-must-never-enter-audit';

const VALID_MINTED_EVENT = {
  organizationId: ORGANIZATION,
  action: 'git_token.minted',
  projectId: PROJECT,
  requestingService: 'sandbox-service',
  occurredAt: OCCURRED_AT,
  metadata: {
    internalRepoRef: REF,
    access: 'write',
    ttlSec: 300,
    expiresAt: '2026-03-01T00:05:00.000Z',
    tokenUser: 'zt-1900000000-0123456789ab',
    runId: newId('run'),
    taskId: null,
  },
} satisfies GitAuditEvent;

const VALID_REVOKED_EVENT = {
  organizationId: ORGANIZATION,
  action: 'git_token.revoked',
  projectId: PROJECT,
  requestingService: 'control-api',
  occurredAt: OCCURRED_AT,
  metadata: {
    internalRepoRef: REF,
    revoked: 2,
  },
} satisfies GitAuditEvent;

const VALID_EVENTS = [VALID_MINTED_EVENT, VALID_REVOKED_EVENT] satisfies readonly GitAuditEvent[];

const REJECTED_SCALAR_KEYS = [
  ['token', 'sentinel-rejected-token'],
  ['password', 'sentinel-rejected-password'],
  ['credential', 'sentinel-rejected-credential'],
  ['unexpectedField', 'sentinel-rejected-unknown-field'],
  ['reason', TOKEN_SENTINEL],
] as const;

const REJECTED_KEY_CASES = VALID_EVENTS.flatMap((event) =>
  REJECTED_SCALAR_KEYS.map(([key, value]) => ({ action: event.action, event, key, value })),
);

const REQUIRED_KEY_CASES = VALID_EVENTS.flatMap((event) =>
  Object.keys(event.metadata).map((key) => ({ action: event.action, event, key })),
);

const TOKEN_FIELD_CASES = VALID_EVENTS.flatMap((event) =>
  Object.keys(event.metadata).map((key) => ({ action: event.action, event, key })),
);

function withMetadataKey(event: GitAuditEvent, key: string, value: string): GitAuditEvent {
  return {
    ...event,
    metadata: { ...event.metadata, [key]: value },
  } as unknown as GitAuditEvent;
}

function acceptingExecutor(): Executor {
  return {
    insert() {
      return {
        values() {
          return Promise.resolve();
        },
      };
    },
  } as unknown as Executor;
}

describe('GitAuditEventSchema', () => {
  it.each(VALID_EVENTS)('accepts the reviewed $action metadata', (event) => {
    expect(GitAuditEventSchema.safeParse(event).success).toBe(true);
  });

  it.each(REJECTED_KEY_CASES)('rejects $action metadata key $key', ({ event, key, value }) => {
    expect(GitAuditEventSchema.safeParse(withMetadataKey(event, key, value)).success).toBe(false);
  });

  it.each(TOKEN_FIELD_CASES)(
    'rejects the exact token sentinel in $action metadata field $key',
    ({ event, key }) => {
      expect(
        GitAuditEventSchema.safeParse(withMetadataKey(event, key, TOKEN_SENTINEL)).success,
      ).toBe(false);
    },
  );

  it.each([
    ['minted internalRepoRef', VALID_MINTED_EVENT, 'internalRepoRef', 'not-an-internal-ref'],
    ['minted access', VALID_MINTED_EVENT, 'access', 'admin'],
    ['minted zero ttlSec', VALID_MINTED_EVENT, 'ttlSec', 0],
    ['minted fractional ttlSec', VALID_MINTED_EVENT, 'ttlSec', 1.5],
    ['minted excessive ttlSec', VALID_MINTED_EVENT, 'ttlSec', 601],
    ['minted expiresAt', VALID_MINTED_EVENT, 'expiresAt', 'not-a-timestamp'],
    ['minted tokenUser', VALID_MINTED_EVENT, 'tokenUser', 'ordinary-user'],
    ['minted runId', VALID_MINTED_EVENT, 'runId', newId('task')],
    ['minted taskId', VALID_MINTED_EVENT, 'taskId', newId('run')],
    ['revoked internalRepoRef', VALID_REVOKED_EVENT, 'internalRepoRef', 'not-an-internal-ref'],
    ['revoked zero count', VALID_REVOKED_EVENT, 'revoked', 0],
    ['revoked fractional count', VALID_REVOKED_EVENT, 'revoked', 1.5],
  ])('rejects an invalid %s', (_case, event, key, value) => {
    expect(
      GitAuditEventSchema.safeParse({
        ...event,
        metadata: { ...event.metadata, [key]: value },
      }).success,
    ).toBe(false);
  });

  it.each(REQUIRED_KEY_CASES)('requires the $action metadata key $key', ({ event, key }) => {
    const metadata = Object.fromEntries(
      Object.entries(event.metadata).filter(([candidate]) => candidate !== key),
    );

    expect(GitAuditEventSchema.safeParse({ ...event, metadata }).success).toBe(false);
  });
});

describe('createRecordingGitAuditSink', () => {
  it.each(REJECTED_KEY_CASES)(
    'rejects $action metadata key $key',
    async ({ event, key, value }) => {
      const sink = createRecordingGitAuditSink();

      await expect(sink.record(withMetadataKey(event, key, value))).rejects.toThrow();
    },
  );

  it.each(TOKEN_FIELD_CASES)(
    'rejects the exact token sentinel in $action metadata field $key',
    async ({ event, key }) => {
      const sink = createRecordingGitAuditSink();

      await expect(sink.record(withMetadataKey(event, key, TOKEN_SENTINEL))).rejects.toThrow();
    },
  );
});

describe('createDbGitAuditSink', () => {
  it.each(REJECTED_KEY_CASES)(
    'rejects $action metadata key $key',
    async ({ event, key, value }) => {
      const sink = createDbGitAuditSink(acceptingExecutor());

      await expect(sink.record(withMetadataKey(event, key, value))).rejects.toThrow();
    },
  );

  it.each(TOKEN_FIELD_CASES)(
    'rejects the exact token sentinel in $action metadata field $key',
    async ({ event, key }) => {
      const sink = createDbGitAuditSink(acceptingExecutor());

      await expect(sink.record(withMetadataKey(event, key, TOKEN_SENTINEL))).rejects.toThrow();
    },
  );
});
