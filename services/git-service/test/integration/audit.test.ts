import { newId } from '@zapp/contracts';
import { organizations } from '@zapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbGitAuditSink, type GitAuditSink } from '../../src/audit.js';
import { hasDatabase, setUpTestDatabase } from './helpers.js';

/**
 * The half of "audited" a recording sink cannot prove: the row reaches
 * `audit_events` (plan 06 GIT-3).
 *
 * Small on purpose. What is worth checking against a real PostgreSQL is that the
 * shape this service writes is one the shipped schema accepts — the tenant
 * foreign key, the not-null `occurred_at`, the `jsonb` metadata — and that the
 * table's append-only trigger applies to these rows like every other. Everything
 * about *when* a row is written is `test/tokens.test.ts`'s.
 *
 * Env-gated: with no `DATABASE_URL` this suite skips loudly and never passes
 * silently.
 */

describe.skipIf(!hasDatabase)('the git audit sink, on PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof setUpTestDatabase>>;
  let sink: GitAuditSink;
  const organizationId = newId('org');
  const projectId = newId('proj');

  beforeAll(async () => {
    database = await setUpTestDatabase();
    sink = createDbGitAuditSink(database.db);

    // `audit_events.organization_id` is a foreign key, so the tenant has to
    // exist — which is the point: a row filed under an organization nobody has
    // is a row nobody will find.
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'git service suite',
      slug: `git-service-${organizationId.slice(-8).toLowerCase()}`,
      createdAt: new Date(),
    });
  }, 180_000);

  afterAll(async () => {
    await database.close();
  });

  it('writes a git_token.minted row the schema accepts', async () => {
    const occurredAt = new Date('2026-03-01T10:11:12.000Z');

    await sink.record({
      organizationId,
      action: 'git_token.minted',
      projectId,
      requestingService: 'sandbox-service',
      occurredAt,
      metadata: {
        internalRepoRef: `${organizationId.toLowerCase()}/${projectId.toLowerCase()}`,
        access: 'write',
        ttlSec: 300,
        expiresAt: '2026-03-01T10:16:12.000Z',
        tokenUser: 'zt-1900000000-0123456789ab',
        reason: 'push the run branch',
        runId: null,
        taskId: null,
      },
    });

    const [row] = await database.sql<
      {
        actor_type: string;
        actor_id: string;
        action: string;
        target_type: string;
        target_id: string;
        metadata_json: Record<string, unknown>;
        /** postgres.js hands `timestamptz` back as its text form on a raw query. */
        occurred_at: string;
      }[]
    >`
      select actor_type, actor_id, action, target_type, target_id, metadata_json, occurred_at
        from audit_events
       where organization_id = ${organizationId} and target_id = ${projectId}
         and action = 'git_token.minted'
    `;

    expect(row).toMatchObject({
      // The same shape the control plane's `auditService` writes, so one query
      // over this table reads both services' rows.
      actor_type: 'service',
      actor_id: 'sandbox-service',
      action: 'git_token.minted',
      target_type: 'project',
      target_id: projectId,
    });
    expect(new Date(row?.occurred_at ?? '')).toEqual(occurredAt);
    expect(row?.metadata_json).toMatchObject({ access: 'write', ttlSec: 300 });
    // The secret is not in the row, and there is no field it would fit in.
    expect(JSON.stringify(row)).not.toContain('forgejo-secret');
  });

  it('cannot edit or remove what it wrote', async () => {
    // `audit_events` is append-only and the migration enforces it with a trigger
    // for every role, owner and superuser included (`packages/db/drizzle/0003`,
    // `0006`). A correction is another row, never an edit — and this service has
    // no code that could try.
    await expect(
      database.sql`update audit_events set action = 'tampered' where target_id = ${projectId}`,
    ).rejects.toThrow();
    await expect(
      database.sql`delete from audit_events where target_id = ${projectId}`,
    ).rejects.toThrow();
  });
});
