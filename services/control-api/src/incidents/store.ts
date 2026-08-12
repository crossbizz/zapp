import { auditEvents, type Database, type Executor } from '@zapp/db';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { NO_TRANSACTION, type AuditExecutor } from '../plugins/audit.js';
import { decryptSecret, encryptSecret, type MasterKeyPort } from '../secrets/crypto.js';
import {
  CreateIncidentInputSchema,
  IncidentConflictError,
  IncidentListInputSchema,
  IncidentLookupSchema,
  IncidentRecordSchema,
  LinkIncidentFixRunInputSchema,
  ResolveIncidentInputSchema,
  incidentIdFor,
  incidentLinkId,
  incidentResolutionId,
  type IncidentRecord,
  type IncidentStore,
} from '../routes/incidents.js';

const CreationMetadataSchema = IncidentRecordSchema.pick({
  projectId: true,
  commitSha: true,
  source: true,
  evidenceArtifactId: true,
})
  .extend({
    diagnostic: z
      .object({
        ciphertext: z.string().min(1),
        iv: z.string().min(1),
        authTag: z.string().min(1),
        wrappedDek: z.string().min(1),
        keyVersion: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const DiagnosticMetadataSchema = IncidentRecordSchema.pick({
  title: true,
  errorPayload: true,
  traceUrl: true,
  logsUrl: true,
  reproductionRoute: true,
}).strict();

const LinkMetadataSchema = z
  .object({
    projectId: IncidentRecordSchema.shape.projectId,
    incidentId: IncidentRecordSchema.shape.id,
    releaseId: IncidentRecordSchema.shape.releaseId,
  })
  .strict();

const ResolutionMetadataSchema = z
  .object({
    projectId: IncidentRecordSchema.shape.projectId,
    incidentId: IncidentRecordSchema.shape.id,
    fixRunId: IncidentRecordSchema.shape.fixRunId.unwrap(),
  })
  .strict();

function dbExecutor(tx: AuditExecutor): Executor {
  if (tx === NO_TRANSACTION) {
    throw new Error('incident links require the caller mutation transaction');
  }
  return tx;
}

async function creationRecord(
  row: typeof auditEvents.$inferSelect,
  masterKey: MasterKeyPort,
): Promise<IncidentRecord> {
  const metadata = CreationMetadataSchema.parse(row.metadataJson);
  const diagnostic = DiagnosticMetadataSchema.parse(
    JSON.parse(await decryptSecret(metadata.diagnostic, masterKey)) as unknown,
  );
  return IncidentRecordSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    projectId: metadata.projectId,
    releaseId: row.targetId,
    commitSha: metadata.commitSha,
    source: metadata.source,
    title: diagnostic.title,
    errorPayload: diagnostic.errorPayload,
    traceUrl: diagnostic.traceUrl,
    logsUrl: diagnostic.logsUrl,
    reproductionRoute: diagnostic.reproductionRoute,
    evidenceArtifactId: metadata.evidenceArtifactId,
    fixRunId: null,
    resolutionReleaseId: null,
    createdAt: row.occurredAt,
  });
}

function sameCreation(left: IncidentRecord, right: IncidentRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function applyLinks(
  executor: Executor,
  organizationId: string,
  records: IncidentRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const byId = new Map(records.map((record) => [record.id, record]));
  const ids = records.map((record) => record.id);
  const links = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        inArray(auditEvents.action, ['incident.fix_run_created', 'incident.resolved']),
        inArray(sql<string>`${auditEvents.metadataJson} ->> 'incidentId'`, ids),
      ),
    )
    .orderBy(auditEvents.occurredAt);
  for (const link of links) {
    if (link.action === 'incident.fix_run_created') {
      const metadata = LinkMetadataSchema.parse(link.metadataJson);
      const record = byId.get(metadata.incidentId);
      if (record !== undefined && record.projectId === metadata.projectId) {
        record.fixRunId = link.targetId;
      }
    }
    if (link.action === 'incident.resolved') {
      const metadata = ResolutionMetadataSchema.parse(link.metadataJson);
      const record = byId.get(metadata.incidentId);
      if (record !== undefined && record.projectId === metadata.projectId) {
        record.fixRunId = metadata.fixRunId;
        record.resolutionReleaseId = link.targetId;
      }
    }
  }
}

export function createDbIncidentStore(database: Database, masterKey: MasterKeyPort): IncidentStore {
  return {
    async create(rawInput) {
      const input = CreateIncidentInputSchema.parse(rawInput);
      const id = incidentIdFor(input.organizationId, input.idempotencyKey);
      const expected = IncidentRecordSchema.parse({
        id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        releaseId: input.releaseId,
        commitSha: input.commitSha,
        source: input.source,
        title: input.title,
        errorPayload: input.errorPayload,
        traceUrl: input.traceUrl,
        logsUrl: input.logsUrl,
        reproductionRoute: input.reproductionRoute,
        evidenceArtifactId: input.evidenceArtifactId,
        fixRunId: null,
        resolutionReleaseId: null,
        createdAt: input.createdAt,
      });
      const diagnostic = await encryptSecret(
        JSON.stringify(
          DiagnosticMetadataSchema.parse({
            title: input.title,
            errorPayload: input.errorPayload,
            traceUrl: input.traceUrl,
            logsUrl: input.logsUrl,
            reproductionRoute: input.reproductionRoute,
          }),
        ),
        masterKey,
      );
      return await database.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(auditEvents)
          .values({
            id,
            organizationId: input.organizationId,
            actorType: input.actorType,
            actorId: input.actorId,
            action: 'incident.created',
            targetType: 'release',
            targetId: input.releaseId,
            metadataJson: CreationMetadataSchema.parse({
              projectId: input.projectId,
              commitSha: input.commitSha,
              source: input.source,
              evidenceArtifactId: input.evidenceArtifactId,
              diagnostic,
            }),
            occurredAt: input.createdAt,
          })
          .onConflictDoNothing({ target: auditEvents.id })
          .returning();
        if (inserted !== undefined) return expected;
        const [existing] = await tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.id, id))
          .limit(1);
        if (existing === undefined || existing.action !== 'incident.created') {
          throw new IncidentConflictError();
        }
        const replay = await creationRecord(existing, masterKey);
        if (!sameCreation(replay, expected)) throw new IncidentConflictError();
        await applyLinks(tx, input.organizationId, [replay]);
        return replay;
      });
    },

    async get(rawInput) {
      const input = IncidentLookupSchema.parse(rawInput);
      const [row] = await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, input.organizationId),
            eq(auditEvents.id, input.incidentId),
            eq(auditEvents.action, 'incident.created'),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      const record = await creationRecord(row, masterKey);
      await applyLinks(database, input.organizationId, [record]);
      return record;
    },

    async list(rawInput) {
      const input = IncidentListInputSchema.parse(rawInput);
      const rows = await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, input.organizationId),
            eq(auditEvents.action, 'incident.created'),
            eq(sql<string>`${auditEvents.metadataJson} ->> 'projectId'`, input.projectId),
            ...(input.cursor === undefined ? [] : [lt(auditEvents.id, input.cursor)]),
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(input.limit + 1);
      const records = await Promise.all(
        rows.slice(0, input.limit).map((row) => creationRecord(row, masterKey)),
      );
      await applyLinks(database, input.organizationId, records);
      return {
        items: records,
        nextCursor: rows.length > input.limit ? (records.at(-1)?.id ?? null) : null,
      };
    },

    async linkFixRun(tx, rawInput) {
      const input = LinkIncidentFixRunInputSchema.parse(rawInput);
      const executor = dbExecutor(tx);
      const [created] = await executor
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, input.organizationId),
            eq(auditEvents.id, input.incidentId),
            eq(auditEvents.action, 'incident.created'),
          ),
        )
        .limit(1);
      if (created === undefined) throw new IncidentConflictError();
      const incident = await creationRecord(created, masterKey);
      if (incident.projectId !== input.projectId || incident.releaseId !== input.releaseId) {
        throw new IncidentConflictError();
      }
      const existingLinks = await executor
        .select({ targetId: auditEvents.targetId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, input.organizationId),
            eq(auditEvents.action, 'incident.fix_run_created'),
            eq(sql<string>`${auditEvents.metadataJson} ->> 'incidentId'`, input.incidentId),
          ),
        );
      if (existingLinks.some((link) => link.targetId !== input.runId)) {
        throw new IncidentConflictError();
      }
      await executor
        .insert(auditEvents)
        .values({
          id: incidentLinkId(input.incidentId, input.runId),
          organizationId: input.organizationId,
          actorType: 'user',
          actorId: input.actorId,
          action: 'incident.fix_run_created',
          targetType: 'run',
          targetId: input.runId,
          metadataJson: LinkMetadataSchema.parse({
            projectId: input.projectId,
            incidentId: input.incidentId,
            releaseId: input.releaseId,
          }),
          occurredAt: input.occurredAt,
        })
        .onConflictDoNothing({ target: auditEvents.id });
    },

    async resolveForRun(tx, rawInput) {
      const input = ResolveIncidentInputSchema.parse(rawInput);
      const executor = dbExecutor(tx);
      const links = await executor
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, input.organizationId),
            eq(auditEvents.action, 'incident.fix_run_created'),
            eq(auditEvents.targetType, 'run'),
            eq(auditEvents.targetId, input.fixRunId),
            eq(sql<string>`${auditEvents.metadataJson} ->> 'projectId'`, input.projectId),
          ),
        );
      for (const link of links) {
        const metadata = LinkMetadataSchema.parse(link.metadataJson);
        await executor
          .insert(auditEvents)
          .values({
            id: incidentResolutionId(metadata.incidentId, input.releaseId),
            organizationId: input.organizationId,
            actorType: 'user',
            actorId: input.actorId,
            action: 'incident.resolved',
            targetType: 'release',
            targetId: input.releaseId,
            metadataJson: ResolutionMetadataSchema.parse({
              projectId: input.projectId,
              incidentId: metadata.incidentId,
              fixRunId: input.fixRunId,
            }),
            occurredAt: input.occurredAt,
          })
          .onConflictDoNothing({ target: auditEvents.id });
      }
    },
  };
}
