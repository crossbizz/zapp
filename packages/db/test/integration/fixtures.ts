import { newId } from '@zapp/contracts';

import type { Database } from '../../src/client.js';
import { nextEventSequence } from '../../src/events.js';
import { agentEvents } from '../../src/schema/execution.js';
import { organizations, users } from '../../src/schema/identity.js';
import { agentRuns } from '../../src/schema/planning.js';
import { branches, projects } from '../../src/schema/projects.js';

/**
 * A whole tenant in one call: organization, owner, project, branch, run and its
 * events. Isolation tests need two of everything, and spelling both out inline
 * buries the assertion in setup.
 */

/**
 * Fixed, and inside the partitions the migration seeds (2026-08 … 2027-07).
 * `new Date()` would make these suites start failing in August 2027 for reasons
 * that have nothing to do with the code under test.
 */
export const EVENT_TIME = new Date('2026-08-15T12:00:00.000Z');

export interface SeededTenant {
  readonly organizationId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly runId: string;
  /** Event ids in sequence order, `1 … eventCount`. */
  readonly eventIds: string[];
}

export async function seedTenant(
  db: Database,
  options: { readonly slug: string; readonly eventCount?: number },
): Promise<SeededTenant> {
  const organizationId = newId('org');
  const userId = newId('user');
  const projectId = newId('proj');
  const branchId = newId('br');
  const runId = newId('run');

  await db
    .insert(organizations)
    .values({ id: organizationId, name: options.slug, slug: `${options.slug}-${organizationId}` });
  await db.insert(users).values({
    id: userId,
    email: `${options.slug}+${userId}@example.com`,
    displayName: `${options.slug} owner`,
  });
  await db.insert(projects).values({
    id: projectId,
    organizationId,
    name: `${options.slug} app`,
    slug: `${options.slug}-app`,
    sourceType: 'prompt',
    supportLevel: 'verified',
    createdBy: userId,
  });
  await db.insert(branches).values({
    id: branchId,
    organizationId,
    projectId,
    name: 'main',
    status: 'active',
  });
  await db.insert(agentRuns).values({
    id: runId,
    organizationId,
    projectId,
    branchId,
    mode: 'build',
    status: 'running',
    startedBy: userId,
  });

  const eventIds: string[] = [];
  for (let index = 0; index < (options.eventCount ?? 0); index += 1) {
    const id = newId('evt');
    // Sequential on purpose: the allocator is what assigns sequence numbers in
    // production too, so the fixture exercises it rather than faking it.
    const sequence = await nextEventSequence(db, runId);
    await db.insert(agentEvents).values({
      id,
      organizationId,
      runId,
      sequence,
      type: 'tool.completed',
      payloadJson: { tool: 'run_build', exitCode: 0 },
      visibility: 'user',
      occurredAt: EVENT_TIME,
    });
    eventIds.push(id);
  }

  return { organizationId, userId, projectId, branchId, runId, eventIds };
}
