import { createHash } from 'node:crypto';

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  auditSnapshotRetention,
  createAgentEventArchiveJob,
  createAgentEventArchiveLifecycle,
  createDatabaseSnapshotRetentionAuditPort,
  createPostgresAgentEventArchiveDatabase,
  createS3AgentEventArchiveObjectStore,
  runArchiveRestoreCli,
  restoreRunEvents,
  type AgentEventArchiveDatabase,
  type AgentEventArchiveObjectStore,
} from '../src/jobs/archive.js';

const januaryEvent = {
  id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
  sequence: 1,
  type: 'run.created',
  visibility: 'user',
  occurredAt: '2026-01-04T00:00:00.000Z',
  payload: { z: 1, a: { y: true, b: false } },
} as const;

function archiveFixture(options: { readonly verified?: boolean } = {}) {
  const objects = new Map<string, { body: string; sha256: string }>();
  const listCandidates = vi.fn<AgentEventArchiveDatabase['listCandidates']>(() =>
    Promise.resolve([
      {
        name: 'agent_events_2026_01',
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-02-01T00:00:00.000Z',
        state: 'attached',
      },
    ]),
  );
  const detach = vi.fn<AgentEventArchiveDatabase['detach']>(() => Promise.resolve('detached'));
  const readEvents = vi.fn<AgentEventArchiveDatabase['readEvents']>(() =>
    Promise.resolve([januaryEvent]),
  );
  const drop = vi.fn<AgentEventArchiveDatabase['drop']>(() => Promise.resolve());
  const database: AgentEventArchiveDatabase = {
    listCandidates,
    detach,
    readEvents,
    drop,
  };
  const putIfAbsent = vi.fn<AgentEventArchiveObjectStore['putIfAbsent']>((input) => {
    if (!objects.has(input.key)) {
      objects.set(input.key, { body: input.body, sha256: input.sha256 });
    }
    return Promise.resolve();
  });
  const head = vi.fn<AgentEventArchiveObjectStore['head']>((key) => {
    const stored = objects.get(key);
    return Promise.resolve(
      stored === undefined
        ? undefined
        : {
            bytes: Buffer.byteLength(stored.body),
            sha256: options.verified === false ? '0'.repeat(64) : stored.sha256,
          },
    );
  });
  const get = vi.fn<AgentEventArchiveObjectStore['get']>((key) =>
    Promise.resolve(objects.get(key)?.body),
  );
  const objectStore: AgentEventArchiveObjectStore = {
    putIfAbsent,
    head,
    get,
  };
  return {
    database,
    objectStore,
    objects,
    spies: { listCandidates, detach, readEvents, drop, putIfAbsent, head, get },
  };
}

describe('agent event retention archive', () => {
  it('detaches partitions older than 90 days, writes deterministic JSONL, verifies it, then drops', async () => {
    const fixture = archiveFixture();
    const job = createAgentEventArchiveJob({
      database: fixture.database,
      objectStore: fixture.objectStore,
    });

    await expect(job.run(new Date('2026-05-03T00:00:00.000Z'))).resolves.toEqual({
      archived: 1,
      skipped: 0,
      snapshotViolations: [],
    });

    const expectedBody = `${JSON.stringify({
      id: januaryEvent.id,
      organizationId: januaryEvent.organizationId,
      projectId: januaryEvent.projectId,
      runId: januaryEvent.runId,
      sequence: januaryEvent.sequence,
      type: januaryEvent.type,
      visibility: januaryEvent.visibility,
      occurredAt: januaryEvent.occurredAt,
      payload: { a: { b: false, y: true }, z: 1 },
    })}\n`;
    const key = 'archives/agent-events/2026/01/agent_events_2026_01.jsonl';
    expect(fixture.objects.get(key)).toEqual({
      body: expectedBody,
      sha256: createHash('sha256').update(expectedBody).digest('hex'),
    });
    expect(fixture.spies.detach).toHaveBeenCalledWith('agent_events_2026_01');
    expect(fixture.spies.drop).toHaveBeenCalledWith('agent_events_2026_01');
    expect(fixture.spies.drop.mock.invocationCallOrder[0]).toBeGreaterThan(
      fixture.spies.head.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('never drops when upload verification fails and safely reuses an identical existing object', async () => {
    const failed = archiveFixture({ verified: false });
    const failedJob = createAgentEventArchiveJob({
      database: failed.database,
      objectStore: failed.objectStore,
    });

    await expect(failedJob.run(new Date('2026-05-03T00:00:00.000Z'))).rejects.toThrow(
      'archive verification failed',
    );
    expect(failed.spies.drop).not.toHaveBeenCalled();

    const retry = archiveFixture();
    const key = 'archives/agent-events/2026/01/agent_events_2026_01.jsonl';
    const body = `${JSON.stringify({
      id: januaryEvent.id,
      organizationId: januaryEvent.organizationId,
      projectId: januaryEvent.projectId,
      runId: januaryEvent.runId,
      sequence: januaryEvent.sequence,
      type: januaryEvent.type,
      visibility: januaryEvent.visibility,
      occurredAt: januaryEvent.occurredAt,
      payload: { a: { b: false, y: true }, z: 1 },
    })}\n`;
    retry.objects.set(key, {
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    retry.spies.detach.mockResolvedValue('already_detached');

    await expect(
      createAgentEventArchiveJob({
        database: retry.database,
        objectStore: retry.objectStore,
      }).run(new Date('2026-05-03T00:00:00.000Z')),
    ).resolves.toMatchObject({ archived: 1 });
    expect(retry.spies.drop).toHaveBeenCalledOnce();
  });

  it('rejects unsafe or ineligible partition metadata before any mutation', async () => {
    const fixture = archiveFixture();
    fixture.spies.listCandidates.mockResolvedValue([
      {
        name: 'agent_events_2026_04;drop table users',
        startsAt: '2026-04-01T00:00:00.000Z',
        endsAt: '2026-05-01T00:00:00.000Z',
        state: 'attached',
      },
    ]);

    await expect(
      createAgentEventArchiveJob({
        database: fixture.database,
        objectStore: fixture.objectStore,
      }).run(new Date('2026-05-03T00:00:00.000Z')),
    ).rejects.toThrow();
    expect(fixture.spies.detach).not.toHaveBeenCalled();
  });

  it('does not archive a partition until its whole range is strictly older than 90 days', async () => {
    const fixture = archiveFixture();
    await expect(
      createAgentEventArchiveJob({
        database: fixture.database,
        objectStore: fixture.objectStore,
      }).run(new Date('2026-05-02T00:00:00.000Z')),
    ).resolves.toEqual({ archived: 0, skipped: 1, snapshotViolations: [] });
    expect(fixture.spies.detach).not.toHaveBeenCalled();
  });
});

describe('read-only archive support tooling', () => {
  it('rehydrates only one run, validates every line, and returns frozen records', async () => {
    const otherRun = {
      ...januaryEvent,
      id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
      runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
    };
    const body = `${JSON.stringify(januaryEvent)}\n${JSON.stringify(otherRun)}\n`;
    const get = vi.fn<AgentEventArchiveObjectStore['get']>(() => Promise.resolve(body));
    const store: AgentEventArchiveObjectStore = {
      putIfAbsent: vi.fn(),
      head: vi.fn(),
      get,
    };

    const restored = await restoreRunEvents({
      objectStore: store,
      archiveKey: 'archives/agent-events/2026/01/agent_events_2026_01.jsonl',
      runId: januaryEvent.runId,
    });

    expect(restored).toEqual([januaryEvent]);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored[0])).toBe(true);

    get.mockResolvedValue(`${body}{"id":"invalid"}\n`);
    await expect(
      restoreRunEvents({
        objectStore: store,
        archiveKey: 'archives/agent-events/2026/01/agent_events_2026_01.jsonl',
        runId: januaryEvent.runId,
      }),
    ).rejects.toThrow();
  });

  it('provides a bounded CLI that emits only the selected run as JSON', async () => {
    const output: string[] = [];
    await expect(
      runArchiveRestoreCli({
        argv: [
          '--archive-key',
          'archives/agent-events/2026/01/agent_events_2026_01.jsonl',
          '--run-id',
          januaryEvent.runId,
        ],
        objectStore: {
          putIfAbsent: vi.fn(),
          head: vi.fn(),
          get: vi.fn(() => Promise.resolve(`${JSON.stringify(januaryEvent)}\n`)),
        },
        write: (line) => {
          output.push(line);
        },
      }),
    ).resolves.toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? 'null')).toEqual([januaryEvent]);

    await expect(
      runArchiveRestoreCli({ argv: [], objectStore: archiveFixture().objectStore, write: vi.fn() }),
    ).rejects.toThrow('Usage:');
  });
});

describe('snapshot retention audit', () => {
  it('enforces active/release-evidence at 30 days and diagnostics at 7 days', () => {
    const createdAt = '2026-04-01T00:00:00.000Z';
    expect(
      auditSnapshotRetention([
        {
          snapshotId: 'snap_active',
          kind: 'active',
          createdAt,
          expiresAt: '2026-05-01T00:00:00.000Z',
        },
        {
          snapshotId: 'snap_diagnostic',
          kind: 'diagnostic',
          createdAt,
          expiresAt: '2026-04-08T00:00:00.000Z',
        },
        {
          snapshotId: 'snap_evidence',
          kind: 'release_evidence',
          createdAt,
          expiresAt: '2026-05-01T00:00:00.000Z',
        },
      ]),
    ).toEqual([]);

    expect(
      auditSnapshotRetention([
        {
          snapshotId: 'snap_wrong',
          kind: 'diagnostic',
          createdAt,
          expiresAt: '2026-05-01T00:00:00.000Z',
        },
      ]),
    ).toEqual([
      {
        snapshotId: 'snap_wrong',
        kind: 'diagnostic',
        expectedExpiresAt: '2026-04-08T00:00:00.000Z',
        actualExpiresAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
  });

  it('reads active persisted provider snapshots for the production audit', async () => {
    const database = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() =>
            Promise.resolve([
              {
                snapshotId: 'snap_diagnostic',
                kind: 'diagnostic',
                createdAt: new Date('2026-04-01T00:00:00.000Z'),
                expiresAt: new Date('2026-04-08T00:00:00.000Z'),
              },
            ]),
          ),
        })),
      })),
    };
    const port = createDatabaseSnapshotRetentionAuditPort(
      database as unknown as Parameters<typeof createDatabaseSnapshotRetentionAuditPort>[0],
      () => new Date('2026-04-02T00:00:00.000Z'),
    );

    await expect(port.listRetentionRecords()).resolves.toEqual([
      {
        snapshotId: 'snap_diagnostic',
        kind: 'diagnostic',
        createdAt: '2026-04-01T00:00:00.000Z',
        expiresAt: '2026-04-08T00:00:00.000Z',
      },
    ]);
  });
});

describe('R2 archive adapter', () => {
  it('uses conditional immutable writes and reads verification metadata', async () => {
    const commands: unknown[] = [];
    const sender = {
      send: vi.fn((command: unknown) => {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          return Promise.resolve({ ContentLength: 3, Metadata: { sha256: 'a'.repeat(64) } });
        }
        if (command instanceof GetObjectCommand) {
          return Promise.resolve({ Body: { transformToString: () => Promise.resolve('one') } });
        }
        return Promise.resolve({});
      }),
    };
    const store = createS3AgentEventArchiveObjectStore(
      {
        endpoint: 'http://minio.test:9000',
        region: 'us-east-1',
        bucket: 'zapp-artifacts',
        accessKeyId: 'test-access',
        secretAccessKey: 'test-secret',
      },
      sender,
    );

    await store.putIfAbsent({
      key: 'archives/agent-events/2026/01/agent_events_2026_01.jsonl',
      body: 'one',
      sha256: 'a'.repeat(64),
    });
    await expect(
      store.head('archives/agent-events/2026/01/agent_events_2026_01.jsonl'),
    ).resolves.toEqual({ bytes: 3, sha256: 'a'.repeat(64) });
    await expect(
      store.get('archives/agent-events/2026/01/agent_events_2026_01.jsonl'),
    ).resolves.toBe('one');

    const put = commands[0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect((put as PutObjectCommand).input).toMatchObject({
      Bucket: 'zapp-artifacts',
      IfNoneMatch: '*',
      Metadata: { sha256: 'a'.repeat(64) },
    });
  });

  it('treats only a provider precondition failure as an existing immutable archive', async () => {
    const existing = createS3AgentEventArchiveObjectStore(
      { bucket: 'zapp-artifacts' },
      {
        send: vi.fn(() =>
          Promise.reject(Object.assign(new Error('exists'), { $metadata: { httpStatusCode: 412 } })),
        ),
      },
    );
    await expect(
      existing.putIfAbsent({ key: 'archive', body: 'one', sha256: 'a'.repeat(64) }),
    ).resolves.toBeUndefined();

    const unavailable = createS3AgentEventArchiveObjectStore(
      { bucket: 'zapp-artifacts' },
      { send: vi.fn(() => Promise.reject(new Error('provider unavailable'))) },
    );
    await expect(
      unavailable.putIfAbsent({ key: 'archive', body: 'one', sha256: 'a'.repeat(64) }),
    ).rejects.toThrow('provider unavailable');
  });
});

describe('Postgres partition adapter and lifecycle', () => {
  it('discovers attached and interrupted detached partitions and quotes only validated identifiers', async () => {
    const statements: string[] = [];
    const query = vi.fn((statement: string) => {
      statements.push(statement);
      if (statement.includes('from pg_class')) {
        return Promise.resolve([
          { name: 'agent_events_2026_01', attached: true },
          { name: 'agent_events_2025_12', attached: false },
        ]);
      }
      if (statement.includes('to_regclass')) {
        return Promise.resolve([{ exists: true }]);
      }
      if (statement.includes('payload_json')) {
        return Promise.resolve([
          {
            id: januaryEvent.id,
            organization_id: januaryEvent.organizationId,
            project_id: januaryEvent.projectId,
            run_id: januaryEvent.runId,
            sequence: '1',
            type: januaryEvent.type,
            visibility: januaryEvent.visibility,
            occurred_at: new Date(januaryEvent.occurredAt),
            phase_id: null,
            task_id: null,
            agent_id: null,
            payload_json: januaryEvent.payload,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const database = createPostgresAgentEventArchiveDatabase({ query });

    await expect(
      database.listCandidates(new Date('2026-05-03T00:00:00.000Z')),
    ).resolves.toEqual([
      {
        name: 'agent_events_2025_12',
        startsAt: '2025-12-01T00:00:00.000Z',
        endsAt: '2026-01-01T00:00:00.000Z',
        state: 'detached',
      },
      {
        name: 'agent_events_2026_01',
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-02-01T00:00:00.000Z',
        state: 'attached',
      },
    ]);
    await expect(database.detach('agent_events_2026_01')).resolves.toBe('detached');
    await expect(database.readEvents('agent_events_2026_01')).resolves.toEqual([januaryEvent]);
    await database.drop('agent_events_2026_01');
    expect(statements).toContain(
      `do $archive$
begin
  perform pg_advisory_xact_lock(hashtextextended('agent-events-archive:agent_events_2026_01', 0));
  if exists (
    select 1
      from pg_inherits inherited
      join pg_class child on child.oid = inherited.inhrelid
      join pg_class parent on parent.oid = inherited.inhparent
     where child.relname = 'agent_events_2026_01'
       and parent.relname = 'agent_events'
  ) then
    alter table agent_events detach partition "agent_events_2026_01";
  end if;
end
$archive$`,
    );
    expect(statements).toContain('drop table if exists "agent_events_2026_01"');
    await expect(database.drop('agent_events_bad;drop table users')).rejects.toThrow();
  });

  it('starts without blocking readiness, stays single-flight, and drains on close', async () => {
    let tick: (() => void) | undefined;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => pending.then(() => ({ archived: 0, skipped: 0, snapshotViolations: [] })));
    const clearInterval = vi.fn();
    const lifecycle = createAgentEventArchiveLifecycle({
      job: { run },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      timers: {
        setInterval(callback, delayMs) {
          expect(delayMs).toBe(86_400_000);
          tick = callback;
          return { timer: 'archive' };
        },
        clearInterval,
      },
    });

    await expect(lifecycle.start()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });
    tick?.();
    expect(run).toHaveBeenCalledOnce();
    const closing = lifecycle.close();
    release?.();
    await closing;
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it('reports snapshot policy violations without blocking the archive schedule', async () => {
    const onSnapshotViolations = vi.fn();
    const lifecycle = createAgentEventArchiveLifecycle({
      job: {
        run: () =>
          Promise.resolve({
            archived: 0,
            skipped: 0,
            snapshotViolations: [
              {
                snapshotId: 'snap_wrong',
                kind: 'diagnostic',
                expectedExpiresAt: '2026-04-08T00:00:00.000Z',
                actualExpiresAt: '2026-05-01T00:00:00.000Z',
              },
            ],
          }),
      },
      onSnapshotViolations,
      timers: { setInterval: () => ({ timer: 'archive' }), clearInterval: vi.fn() },
    });

    await lifecycle.start();
    await vi.waitFor(() => {
      expect(onSnapshotViolations).toHaveBeenCalledOnce();
    });
    await lifecycle.close();
  });
});
