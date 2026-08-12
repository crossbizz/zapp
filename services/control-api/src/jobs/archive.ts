import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AgentEventSchema, CheckpointKindSchema, idSchema } from '@zapp/contracts';
import { sandboxSnapshotMeasurements, type Database } from '@zapp/db';
import { gt } from 'drizzle-orm';
import { z } from 'zod';

import { loadArtifactStorageEnv } from '../env.js';

const DAY_MS = 86_400_000;
const EVENT_RETENTION_MS = 90 * DAY_MS;
const PARTITION_NAME = /^agent_events_(\d{4})_(0[1-9]|1[0-2])$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const ArchiveCandidateSchema = z
  .object({
    name: z.string().regex(PARTITION_NAME),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    state: z.enum(['attached', 'detached']),
  })
  .strict();

const ArchiveHeadSchema = z
  .object({
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(SHA256),
  })
  .strict();

const SnapshotRetentionRecordSchema = z
  .object({
    snapshotId: z.string().trim().min(1),
    kind: CheckpointKindSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
const RestoreCliArgumentsSchema = z.tuple([
  z.literal('--archive-key'),
  z.string(),
  z.literal('--run-id'),
  idSchema('run'),
]);
const RESTORE_CLI_USAGE =
  'Usage: archive:restore --archive-key archives/agent-events/YYYY/MM/agent_events_YYYY_MM.jsonl --run-id run_*';

export interface AgentEventArchiveDatabase {
  /** Includes eligible attached partitions and detached partitions left by an interrupted run. */
  listCandidates(cutoff: Date): Promise<unknown>;
  /** Detachment fences late writes before the archive is read. */
  detach(name: string): Promise<'detached' | 'already_detached' | 'missing'>;
  readEvents(name: string): Promise<unknown>;
  drop(name: string): Promise<void>;
}

export interface AgentEventArchiveObjectStore {
  putIfAbsent(input: {
    readonly key: string;
    readonly body: string;
    readonly sha256: string;
  }): Promise<void>;
  head(key: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

export interface SnapshotRetentionAuditPort {
  listRetentionRecords(): Promise<unknown>;
}

export interface AgentEventArchiveS3Sender {
  send(command: PutObjectCommand | HeadObjectCommand | GetObjectCommand): Promise<unknown>;
}

export interface AgentEventArchiveSqlPort {
  query(statement: string): Promise<unknown>;
}

interface ArchiveLifecycleTimers {
  setInterval(callback: () => void, delayMs: number): number | object;
  clearInterval(handle: number | object): void;
}

export interface AgentEventArchiveJob {
  run(now: Date): Promise<{
    readonly archived: number;
    readonly skipped: number;
    readonly snapshotViolations: readonly SnapshotRetentionViolation[];
  }>;
}

export interface SnapshotRetentionViolation {
  readonly snapshotId: string;
  readonly kind: z.infer<typeof CheckpointKindSchema>;
  readonly expectedExpiresAt: string;
  readonly actualExpiresAt: string;
}

/**
 * Archives whole monthly partitions. The ordering is deliberate: detach, read,
 * immutable upload, remote checksum verification, then drop. A crash at any
 * earlier boundary leaves either an attached table or a detached table that the
 * next run can safely discover and resume.
 */
export function createAgentEventArchiveJob(options: {
  readonly database: AgentEventArchiveDatabase;
  readonly objectStore: AgentEventArchiveObjectStore;
  readonly snapshots?: SnapshotRetentionAuditPort;
}): AgentEventArchiveJob {
  return {
    async run(rawNow) {
      const now = validDate(rawNow);
      const cutoff = new Date(now.getTime() - EVENT_RETENTION_MS);
      const candidates = z
        .array(ArchiveCandidateSchema)
        .parse(await options.database.listCandidates(cutoff));
      const snapshotViolations =
        options.snapshots === undefined
          ? []
          : auditSnapshotRetention(await options.snapshots.listRetentionRecords());
      let archived = 0;
      let skipped = 0;

      for (const candidate of candidates) {
        assertPartitionRange(candidate);
        if (Date.parse(candidate.endsAt) >= cutoff.getTime()) {
          skipped += 1;
          continue;
        }
        const detachResult = await options.database.detach(candidate.name);
        if (detachResult === 'missing') {
          skipped += 1;
          continue;
        }
        const events = z.array(AgentEventSchema).parse(await options.database.readEvents(candidate.name));
        assertEventsBelongToPartition(events, candidate.startsAt, candidate.endsAt);
        const body = renderJsonLines(events);
        const sha256 = createHash('sha256').update(body).digest('hex');
        const key = archiveKey(candidate.name);
        await options.objectStore.putIfAbsent({ key, body, sha256 });
        const head = ArchiveHeadSchema.safeParse(await options.objectStore.head(key));
        if (
          !head.success ||
          head.data.bytes !== Buffer.byteLength(body) ||
          head.data.sha256 !== sha256
        ) {
          throw new Error(`archive verification failed for ${candidate.name}`);
        }
        await options.database.drop(candidate.name);
        archived += 1;
      }

      return { archived, skipped, snapshotViolations };
    },
  };
}

/** Parses archive JSONL without writing it back to the hot event table. */
export async function restoreRunEvents(input: {
  readonly objectStore: AgentEventArchiveObjectStore;
  readonly archiveKey: string;
  readonly runId: string;
}): Promise<readonly Readonly<z.infer<typeof AgentEventSchema>>[]> {
  const runId = idSchema('run').parse(input.runId);
  const key = z
    .string()
    .regex(/^archives\/agent-events\/\d{4}\/(?:0[1-9]|1[0-2])\/agent_events_\d{4}_(?:0[1-9]|1[0-2])\.jsonl$/u)
    .parse(input.archiveKey);
  const rawBody = await input.objectStore.get(key);
  if (typeof rawBody !== 'string') throw new Error(`event archive not found: ${key}`);
  const lines = rawBody.endsWith('\n') ? rawBody.slice(0, -1).split('\n') : rawBody.split('\n');
  const events = lines.filter((line) => line.length > 0).map((line) => AgentEventSchema.parse(JSON.parse(line) as unknown));
  const restored = events
    .filter((event) => event.runId === runId)
    .map((event) => deepFreeze(event));
  return Object.freeze(restored);
}

/** Support-tool entrypoint. It deliberately has no database write dependency. */
export async function runArchiveRestoreCli(input: {
  readonly argv: readonly string[];
  readonly objectStore: AgentEventArchiveObjectStore;
  readonly write: (line: string) => void;
}): Promise<0> {
  const parsed = RestoreCliArgumentsSchema.safeParse(input.argv);
  if (!parsed.success) {
    throw new Error(RESTORE_CLI_USAGE);
  }
  const [, archiveKey, , runId] = parsed.data;
  const events = await restoreRunEvents({ objectStore: input.objectStore, archiveKey, runId });
  input.write(`${JSON.stringify(events)}\n`);
  return 0;
}

export function auditSnapshotRetention(rawRecords: unknown): SnapshotRetentionViolation[] {
  return z.array(SnapshotRetentionRecordSchema).parse(rawRecords).flatMap((record) => {
    const ttlDays = record.kind === 'diagnostic' ? 7 : 30;
    const expectedExpiresAt = new Date(Date.parse(record.createdAt) + ttlDays * DAY_MS).toISOString();
    return record.expiresAt === expectedExpiresAt
      ? []
      : [
          {
            snapshotId: record.snapshotId,
            kind: record.kind,
            expectedExpiresAt,
            actualExpiresAt: record.expiresAt,
          },
        ];
  });
}

export function createDatabaseSnapshotRetentionAuditPort(
  database: Database,
  now: () => Date = () => new Date(),
): SnapshotRetentionAuditPort {
  return {
    async listRetentionRecords() {
      const instant = validDate(now());
      const rows = await database
        .select({
          snapshotId: sandboxSnapshotMeasurements.providerSnapshotId,
          kind: sandboxSnapshotMeasurements.kind,
          createdAt: sandboxSnapshotMeasurements.createdAt,
          expiresAt: sandboxSnapshotMeasurements.expiresAt,
        })
        .from(sandboxSnapshotMeasurements)
        .where(gt(sandboxSnapshotMeasurements.expiresAt, instant));
      return rows.map((row) =>
        SnapshotRetentionRecordSchema.parse({
          snapshotId: row.snapshotId,
          kind: row.kind,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        }),
      );
    },
  };
}

export function createS3AgentEventArchiveObjectStore(
  config: {
    readonly bucket: string;
    readonly endpoint?: string;
    readonly region?: string;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
  },
  sender: AgentEventArchiveS3Sender = new S3Client({
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.region === undefined ? {} : { region: config.region }),
    ...(config.accessKeyId === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey ?? '',
          },
        }),
    forcePathStyle: true,
  }),
): AgentEventArchiveObjectStore {
  const bucket = z.string().trim().min(1).parse(config.bucket);
  return {
    async putIfAbsent(input) {
      try {
        await sender.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: input.body,
            ContentType: 'application/x-ndjson',
            IfNoneMatch: '*',
            Metadata: { sha256: input.sha256 },
          }),
        );
      } catch (error: unknown) {
        if (httpStatus(error) !== 412) throw error;
      }
    },
    async head(key) {
      try {
        const response = await sender.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const parsed = z
          .object({
            ContentLength: z.number().int().nonnegative(),
            Metadata: z.record(z.string()).default({}),
          })
          .passthrough()
          .parse(response);
        return { bytes: parsed.ContentLength, sha256: parsed.Metadata['sha256'] };
      } catch (error: unknown) {
        if (httpStatus(error) === 404) return undefined;
        throw error;
      }
    },
    async get(key) {
      try {
        const response = await sender.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const parsed = z
          .object({
            Body: z
              .object({ transformToString: z.function().returns(z.promise(z.string())) })
              .passthrough(),
          })
          .passthrough()
          .parse(response);
        return await parsed.Body.transformToString();
      } catch (error: unknown) {
        if (httpStatus(error) === 404) return undefined;
        throw error;
      }
    },
  };
}

export function createPostgresAgentEventArchiveDatabase(
  sqlPort: AgentEventArchiveSqlPort,
): AgentEventArchiveDatabase {
  return {
    async listCandidates(cutoff) {
      validDate(cutoff);
      const rows = z
        .array(
          z
            .object({ name: z.string().regex(PARTITION_NAME), attached: z.boolean() })
            .strict(),
        )
        .parse(
          await sqlPort.query(`select child.relname as name,
       exists (
         select 1
           from pg_inherits inherited
           join pg_class parent on parent.oid = inherited.inhparent
          where inherited.inhrelid = child.oid
            and parent.relname = 'agent_events'
       ) as attached
  from pg_class child
  join pg_namespace namespace on namespace.oid = child.relnamespace
 where namespace.nspname = current_schema()
   and child.relkind in ('r', 'p')
   and child.relname ~ '^agent_events_[0-9]{4}_(0[1-9]|1[0-2])$'`),
        );
      return rows
        .map((row) => ({ ...partitionRange(row.name), state: row.attached ? 'attached' : 'detached' }))
        .toSorted((left, right) => left.startsAt.localeCompare(right.startsAt));
    },
    async detach(name) {
      const identifier = partitionIdentifier(name);
      await sqlPort.query(`do $archive$
begin
  perform pg_advisory_xact_lock(hashtextextended('agent-events-archive:${name}', 0));
  if exists (
    select 1
      from pg_inherits inherited
      join pg_class child on child.oid = inherited.inhrelid
      join pg_class parent on parent.oid = inherited.inhparent
     where child.relname = '${name}'
       and parent.relname = 'agent_events'
  ) then
    alter table agent_events detach partition ${identifier};
  end if;
end
$archive$`);
      const [state] = z
        .array(
          z.object({ exists: z.boolean() }).strict(),
        )
        .parse(
          await sqlPort.query(
            `select to_regclass('public.${identifier}') is not null as exists`,
          ),
        );
      if (state?.exists !== true) return 'missing';
      return 'detached';
    },
    async readEvents(name) {
      const identifier = partitionIdentifier(name);
      const rows = z
        .array(
          z
            .object({
              id: z.string(),
              organization_id: z.string(),
              project_id: z.string(),
              run_id: z.string(),
              sequence: z.union([z.string().regex(/^\d+$/u), z.number().int().nonnegative()]),
              type: z.string(),
              visibility: z.string(),
              occurred_at: z.coerce.date(),
              phase_id: z.string().nullable(),
              task_id: z.string().nullable(),
              agent_id: z.string().nullable(),
              payload_json: z.record(z.unknown()),
            })
            .strict(),
        )
        .parse(
          await sqlPort.query(`select id, organization_id, project_id, run_id,
       sequence::text as sequence, type, visibility, occurred_at,
       phase_id, task_id, agent_id, payload_json
  from ${identifier}
 order by occurred_at, id`),
        );
      return rows.map((row) =>
        AgentEventSchema.parse({
          id: row.id,
          organizationId: row.organization_id,
          projectId: row.project_id,
          runId: row.run_id,
          sequence: Number(row.sequence),
          type: row.type,
          visibility: row.visibility,
          occurredAt: row.occurred_at.toISOString(),
          ...(row.phase_id === null ? {} : { phaseId: row.phase_id }),
          ...(row.task_id === null ? {} : { taskId: row.task_id }),
          ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
          payload: row.payload_json,
        }),
      );
    },
    async drop(name) {
      await sqlPort.query(`drop table if exists ${partitionIdentifier(name)}`);
    },
  };
}

/** Daily probe; whole-month selection means a daily schedule cannot partially archive a partition. */
export function createAgentEventArchiveLifecycle(options: {
  readonly job: AgentEventArchiveJob;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
  readonly onSnapshotViolations?: (violations: readonly SnapshotRetentionViolation[]) => void;
  readonly timers?: ArchiveLifecycleTimers;
}) {
  const now = options.now ?? ((): Date => new Date());
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies ArchiveLifecycleTimers);
  let handle: number | object | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = options.job
      .run(now())
      .then((result) => {
        if (result.snapshotViolations.length > 0) {
          options.onSnapshotViolations?.(result.snapshotViolations);
        }
      })
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  };
  return {
    start(): Promise<void> {
      if (closed) throw new Error('agent event archive lifecycle is closed');
      handle = timers.setInterval(poll, DAY_MS);
      poll();
      return Promise.resolve();
    },
    async close(): Promise<void> {
      closed = true;
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      await active;
    },
  };
}

function archiveKey(partitionName: string): string {
  const match = PARTITION_NAME.exec(partitionName);
  if (match === null) throw new Error('invalid event partition name');
  const [, year, month] = match;
  if (year === undefined || month === undefined) throw new Error('invalid event partition name');
  return `archives/agent-events/${year}/${month}/${partitionName}.jsonl`;
}

function partitionRange(name: string): {
  readonly name: string;
  readonly startsAt: string;
  readonly endsAt: string;
} {
  const match = PARTITION_NAME.exec(name);
  if (match === null) throw new Error('invalid event partition name');
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    name,
    startsAt: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    endsAt: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

function partitionIdentifier(name: string): string {
  z.string().regex(PARTITION_NAME).parse(name);
  return `"${name}"`;
}

function assertPartitionRange(candidate: z.infer<typeof ArchiveCandidateSchema>): void {
  const match = PARTITION_NAME.exec(candidate.name);
  if (match === null) throw new Error('invalid event partition name');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const expectedStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const expectedEnd = new Date(Date.UTC(year, month, 1)).toISOString();
  if (candidate.startsAt !== expectedStart || candidate.endsAt !== expectedEnd) {
    throw new Error(`event partition range mismatch: ${candidate.name}`);
  }
}

function assertEventsBelongToPartition(
  events: readonly z.infer<typeof AgentEventSchema>[],
  startsAt: string,
  endsAt: string,
): void {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  for (const event of events) {
    const occurredAt = Date.parse(event.occurredAt);
    if (occurredAt < start || occurredAt >= end) {
      throw new Error(`event ${event.id} lies outside its archive partition`);
    }
  }
}

function renderJsonLines(events: readonly z.infer<typeof AgentEventSchema>[]): string {
  return events
    .toSorted((left, right) =>
      left.occurredAt === right.occurredAt
        ? left.id.localeCompare(right.id)
        : left.occurredAt.localeCompare(right.occurredAt),
    )
    .map((event) =>
      JSON.stringify({
        id: event.id,
        organizationId: event.organizationId,
        projectId: event.projectId,
        runId: event.runId,
        sequence: event.sequence,
        type: event.type,
        visibility: event.visibility,
        occurredAt: event.occurredAt,
        ...(event.phaseId === undefined ? {} : { phaseId: event.phaseId }),
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        payload: canonicalize(event.payload),
      }),
    )
    .join('\n') + (events.length === 0 ? '' : '\n');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('invalid archive clock');
  return value;
}

function httpStatus(error: unknown): number | undefined {
  return z
    .object({ $metadata: z.object({ httpStatusCode: z.number().int().optional() }).passthrough() })
    .passthrough()
    .safeParse(error).data?.$metadata.httpStatusCode;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  const argv = process.argv.slice(2);
  if (!RestoreCliArgumentsSchema.safeParse(argv).success) {
    process.stderr.write(`${RESTORE_CLI_USAGE}\n`);
    process.exitCode = 1;
  } else {
    runArchiveRestoreCli({
      argv,
      objectStore: createS3AgentEventArchiveObjectStore(loadArtifactStorageEnv()),
      write: (line) => {
        process.stdout.write(line);
      },
    }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'archive restore failed'}\n`);
      process.exitCode = 1;
    });
  }
}
