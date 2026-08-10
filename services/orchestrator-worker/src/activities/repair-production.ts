import { createHash, randomUUID } from 'node:crypto';

import {
  CompleteRequestSchema,
  GatewayStreamEventSchema,
  type CompleteRequest,
  type GatewayStreamEvent,
} from '@zapp/model-gateway';
import {
  agentEvents,
  agentPhases,
  agentRuns,
  agentTasks,
  createActivityIdempotencyRepository,
  nextEventSequence,
  type Database,
} from '@zapp/db';
import {
  FailureModelClassificationRequestSchema,
  RepairCheckResultSchema,
  VerifyRepairCommitResultSchema,
  type AffectedGateCheckInput,
  type FailureClassificationScope,
  type FailureModelClassificationRequest,
  type FailureModelClassifier,
  type RepairBuilderPort,
  type RepairCheckPort,
  type RepairCommitPort,
  type RepairEscalation,
  type RepairOutcomePort,
  type RepairSuccess,
  type RepairTaskCreateInput,
  type RepairTaskCreateResult,
  type RepairTaskPort,
  type TargetedRepairCheckInput,
  GateResultSchema,
} from '@zapp/verification-engine';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { and, eq, sql } from 'drizzle-orm';

import { executeIdempotentActivity } from './idempotency.js';
import {
  TaskWorkflowActivityResultSchemas,
  type TaskWorkflowActivities,
} from './merge.js';
import { createRepairActivities, type RepairActivities } from './repair.js';
import type {
  FreshVerifierWorkspace,
  VerificationGateRunner,
  VerifierWorkspacePort,
} from './verify-phase.js';

const REPAIR_CLASSIFIER_SYSTEM_PROMPT = [
  'Classify the verification failure using only the supplied evidence and diff summary.',
  'Return strict JSON with exactly classification and reason.',
  'classification must be product_code, test_code, or environment.',
  'Do not classify infrastructure or flaky dependency; code owns those decisions.',
].join(' ');
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface RepairModelGateway {
  stream(request: CompleteRequest, signal: AbortSignal): AsyncIterable<GatewayStreamEvent>;
}

function completionIdFor(
  request: FailureModelClassificationRequest,
  scope: FailureClassificationScope,
): string {
  return `cmp_${createHash('sha256')
    .update(JSON.stringify({ scope, failureId: request.failureId, gateId: request.gateId }))
    .digest('hex')}`;
}

export function createModelGatewayFailureClassifier(
  gateway: RepairModelGateway,
): FailureModelClassifier {
  return {
    async classify(requestValue, scope) {
      const request = FailureModelClassificationRequestSchema.parse(requestValue);
      const completion = CompleteRequestSchema.parse({
        completionId: completionIdFor(request, scope),
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runId: scope.runId,
        taskId: scope.taskId,
        agentRole: 'verifier',
        messages: [
          { role: 'system', content: REPAIR_CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(request) },
        ],
        cacheBreakpointMessageIndexes: [0],
        maxInputTokens: 8_192,
        maxOutputTokens: 512,
      });
      const controller = new AbortController();
      let response = '';
      let completed = false;
      for await (const eventValue of gateway.stream(completion, controller.signal)) {
        const event = GatewayStreamEventSchema.parse(eventValue);
        if (event.type === 'text-delta') {
          response += event.text;
          if (response.length > 20_000) throw new Error('repair_classifier_response_too_large');
        } else if (event.type === 'error') {
          throw new Error(`repair_classifier_${event.code}`);
        } else if (event.type === 'done') {
          completed = true;
        }
      }
      if (!completed) throw new Error('repair_classifier_stream_incomplete');
      return JSON.parse(response) as unknown;
    },
  };
}

function deterministicRepairTaskId(operationKey: string): string {
  const digest = createHash('sha256').update(operationKey).digest();
  let value = BigInt(`0x${digest.subarray(0, 17).toString('hex')}`) >> 6n;
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    const character = CROCKFORD_ALPHABET[Number(value & 31n)];
    if (character === undefined) throw new Error('repair_task_id_encoding_failed');
    encoded = `${character}${encoded}`;
    value >>= 5n;
  }
  return `task_${encoded}`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export interface PostgresRepairLifecycle {
  create(input: RepairTaskCreateInput): Promise<RepairTaskCreateResult>;
  succeeded(input: RepairSuccess): Promise<void>;
  escalate(input: RepairEscalation): Promise<void>;
}

export function createPostgresRepairLifecycle(database: Database): PostgresRepairLifecycle {
  return {
    async create(input) {
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`,
        );
        const [parent] = await tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .innerJoin(agentPhases, eq(agentPhases.id, agentTasks.phaseId))
          .innerJoin(agentRuns, eq(agentRuns.id, agentPhases.runId))
          .where(
            and(
              eq(agentTasks.id, input.taskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentTasks.status, 'repairing'),
              eq(agentPhases.organizationId, input.organizationId),
              eq(agentPhases.runId, input.runId),
              eq(agentRuns.organizationId, input.organizationId),
              eq(agentRuns.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (parent === undefined) throw new Error('repair_parent_task_not_repairing');

        const repairTaskId = deterministicRepairTaskId(input.idempotencyKey);
        const title = `Repair ${input.classification} failure for ${input.context.criterion.id}`;
        const acceptanceCriteria = [input.context.criterion];
        await tx
          .insert(agentTasks)
          .values({
            id: repairTaskId,
            organizationId: input.organizationId,
            phaseId: input.phaseId,
            parentTaskId: input.taskId,
            title,
            status: 'running',
            riskLevel: input.protectedFailure === null ? 'medium' : 'high',
            baseCommitSha: input.failingCommitSha,
            outputCommitSha: null,
            acceptanceCriteriaJson: acceptanceCriteria,
            dependenciesJson: [],
            assignedAgentRole: 'builder',
          })
          .onConflictDoNothing();
        const [created] = await tx
          .select()
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.id, repairTaskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentTasks.parentTaskId, input.taskId),
            ),
          )
          .limit(1);
        if (
          created === undefined ||
          created.title !== title ||
          !['running', 'passed', 'failed'].includes(created.status) ||
          created.baseCommitSha !== input.failingCommitSha ||
          created.assignedAgentRole !== 'builder' ||
          !sameJson(created.acceptanceCriteriaJson, acceptanceCriteria)
        ) {
          throw new Error('repair_task_idempotency_conflict');
        }
        return { repairTaskId };
      });
    },
    async succeeded(input) {
      await database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`,
        );
        const [parentScope] = await tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .innerJoin(agentPhases, eq(agentPhases.id, agentTasks.phaseId))
          .innerJoin(agentRuns, eq(agentRuns.id, agentPhases.runId))
          .where(
            and(
              eq(agentTasks.id, input.taskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentPhases.organizationId, input.organizationId),
              eq(agentPhases.runId, input.runId),
              eq(agentRuns.organizationId, input.organizationId),
              eq(agentRuns.projectId, input.projectId),
            ),
          )
          .limit(1);
        const [repairScope] = await tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.id, input.repairTaskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentTasks.parentTaskId, input.taskId),
            ),
          )
          .limit(1);
        if (parentScope === undefined || repairScope === undefined) {
          throw new Error('repair_success_scope_missing');
        }
        const outputCommitSha = input.commitShas.at(-1) ?? null;
        await tx
          .update(agentTasks)
          .set({ status: 'passed', outputCommitSha })
          .where(
            and(
              eq(agentTasks.id, input.repairTaskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentTasks.parentTaskId, input.taskId),
              eq(agentTasks.status, 'running'),
            ),
          );
        await tx
          .update(agentTasks)
          .set({ status: 'verifying' })
          .where(
            and(
              eq(agentTasks.id, input.taskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentTasks.status, 'repairing'),
            ),
          );
        const [state] = await tx
          .select({
            repairStatus: agentTasks.status,
            repairCommitSha: agentTasks.outputCommitSha,
          })
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.id, input.repairTaskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentTasks.parentTaskId, input.taskId),
            ),
          )
          .limit(1);
        const [parent] = await tx
          .select({ status: agentTasks.status })
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.id, input.taskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
            ),
          )
          .limit(1);
        if (
          state?.repairStatus !== 'passed' ||
          state.repairCommitSha !== outputCommitSha ||
          parent?.status !== 'verifying'
        ) {
          throw new Error('repair_success_transition_conflict');
        }
      });
    },
    async escalate(input) {
      await database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`,
        );
        const [scope] = await tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .innerJoin(agentPhases, eq(agentPhases.id, agentTasks.phaseId))
          .innerJoin(agentRuns, eq(agentRuns.id, agentPhases.runId))
          .where(
            and(
              eq(agentTasks.id, input.taskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentPhases.runId, input.runId),
              eq(agentRuns.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (scope === undefined) throw new Error('repair_escalation_scope_missing');
        const [repairScope] = await tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.id, input.repairTaskId),
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              eq(agentTasks.parentTaskId, input.taskId),
            ),
          )
          .limit(1);
        if (repairScope === undefined) throw new Error('repair_escalation_child_missing');
        await tx
          .update(agentTasks)
          .set({ status: 'failed' })
          .where(
            and(
              eq(agentTasks.organizationId, input.organizationId),
              eq(agentTasks.phaseId, input.phaseId),
              sql`${agentTasks.id} in (${input.taskId}, ${input.repairTaskId})`,
              sql`${agentTasks.status} in ('repairing', 'running')`,
            ),
          );
        const [existing] = await tx
          .select({ payloadJson: agentEvents.payloadJson })
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.organizationId, input.organizationId),
              eq(agentEvents.runId, input.runId),
              eq(agentEvents.taskId, input.taskId),
              eq(agentEvents.type, 'task.failed'),
              sql`${agentEvents.payloadJson}->>'repairTaskId' = ${input.repairTaskId}`,
            ),
          )
          .limit(1);
        const payload = { ...input.event.payload, repairTaskId: input.repairTaskId };
        if (existing !== undefined) {
          if (!sameJson(existing.payloadJson, payload)) {
            throw new Error('repair_escalation_idempotency_conflict');
          }
          return;
        }
        const sequence = await nextEventSequence(tx, input.runId);
        await tx.insert(agentEvents).values({
          id: `evt_${deterministicRepairTaskId(input.idempotencyKey).slice('task_'.length)}`,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId: input.runId,
          sequence,
          occurredAt: new Date(),
          phaseId: input.phaseId,
          taskId: input.taskId,
          agentId: 'verifier',
          type: input.event.type,
          visibility: input.event.visibility,
          payloadJson: payload,
        });
      });
    },
  };
}

export function createTaskWorkflowRepairBuilder(options: {
  readonly activities: TaskWorkflowActivities;
  readonly model: string | null;
  readonly budget: { readonly maxCredits: number } | null;
}): RepairBuilderPort {
  return {
    async repair(input) {
      const branchName = `task/${input.repairTaskId}`;
      let workspaceId = input.workspaceId;
      if (workspaceId === null) {
        const workspace = TaskWorkflowActivityResultSchemas.createTaskWorkspace.parse(
          await options.activities.createTaskWorkspace({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            taskId: input.repairTaskId,
            baseCommitSha: input.baseCommitSha,
            branchName,
            idempotencyKey: `${input.idempotencyKey}:workspace`,
          }),
        );
        workspaceId = workspace.workspaceId;
      }
      const session = TaskWorkflowActivityResultSchemas.runTaskBuilderSession.parse(
        await options.activities.runTaskBuilderSession({
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          taskId: input.repairTaskId,
          workspaceId,
          mode: 'fix',
          model: options.model,
          prompt: JSON.stringify({
            kind: 'verification_repair',
            iteration: input.iteration,
            classification: input.classification,
            criterion: input.context.criterion,
            failingGate: input.context.failingGate,
            relatedFiles: input.context.relatedFiles,
            affectedGateIds: input.affectedGateIds,
          }),
          budget: options.budget,
          idempotencyKey: `${input.idempotencyKey}:session`,
        }),
      );
      if (session.status !== 'completed') throw new Error(`repair_builder_${session.status}`);
      const committed = TaskWorkflowActivityResultSchemas.commitAndPushTask.parse(
        await options.activities.commitAndPushTask({
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          taskId: input.repairTaskId,
          workspaceId,
          branchName,
          message: `Repair ${input.context.criterion.id} iteration ${String(input.iteration)}`,
          idempotencyKey: `${input.idempotencyKey}:commit`,
        }),
      );
      return {
        receipt: {
          commitSha: committed.commitSha,
          parentCommitSha: input.baseCommitSha,
          repairTaskId: input.repairTaskId,
          workspaceId,
          branchName,
        },
      };
    },
  };
}

export interface RepairWorkspaceResolver {
  resolve(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
  }): Promise<WorkspaceRuntime>;
}

export function createWorkspaceRepairCommitPort(
  resolver: RepairWorkspaceResolver,
): RepairCommitPort {
  return {
    async verify(input) {
      const runtime = await resolver.resolve({
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId: input.runId,
        taskId: input.receipt.repairTaskId,
        workspaceId: input.receipt.workspaceId,
      });
      const commit = await runtime.exec({
        cmd: 'git',
        args: ['show', '-s', '--format=%H %P', input.receipt.commitSha],
        timeoutMs: 30_000,
      });
      const branch = await runtime.exec({
        cmd: 'git',
        args: ['rev-parse', `refs/heads/${input.expectedBranchName}`],
        timeoutMs: 30_000,
      });
      const [commitSha, parentCommitSha, extraParent] = commit.stdout.trim().split(/\s+/u);
      if (
        commit.exitCode !== 0 ||
        branch.exitCode !== 0 ||
        extraParent !== undefined ||
        commitSha !== input.receipt.commitSha ||
        parentCommitSha !== input.expectedParentCommitSha ||
        input.receipt.parentCommitSha !== input.expectedParentCommitSha ||
        input.receipt.branchName !== input.expectedBranchName ||
        branch.stdout.trim() !== input.receipt.commitSha
      ) {
        throw new Error('repair_commit_receipt_unverified');
      }
      return VerifyRepairCommitResultSchema.parse({ verified: true });
    },
  };
}

export interface TargetedRepairRunner {
  run(input: TargetedRepairCheckInput, workspace: FreshVerifierWorkspace): Promise<unknown>;
}

export function createFreshWorkspaceRepairChecks(options: {
  readonly workspaces: VerifierWorkspacePort;
  readonly gates: VerificationGateRunner;
  readonly targeted: TargetedRepairRunner;
  readonly redact: (value: string) => string;
}): RepairCheckPort {
  async function inWorkspace<T>(
    input: TargetedRepairCheckInput | AffectedGateCheckInput,
    operation: (workspace: FreshVerifierWorkspace) => Promise<T>,
  ): Promise<T> {
    const workspace = await options.workspaces.open({
      runId: input.runId,
      phaseId: input.phaseId,
      commitSha: input.commitSha,
      networkProfile: 'restricted_verification',
    });
    try {
      if (
        workspace.resolvedCommitSha !== input.commitSha ||
        workspace.gateContext.commit !== input.commitSha
      ) {
        throw new Error('repair_check_workspace_commit_mismatch');
      }
      return await operation(workspace);
    } finally {
      await workspace.close();
    }
  }

  return {
    targeted(input) {
      return inWorkspace(input, async (workspace) =>
        RepairCheckResultSchema.parse(await options.targeted.run(input, workspace)),
      );
    },
    affected(input) {
      return inWorkspace(input, async (workspace) => {
        const results = [];
        for (const gateId of input.affectedGateIds) {
          results.push({
            gateId,
            result: GateResultSchema.parse(
              await options.gates.run(gateId, workspace.gateContext),
            ),
          });
        }
        const evidenceArtifactIds = [
          ...new Set(results.flatMap(({ result }) => result.evidenceArtifactIds)),
        ];
        const status = results.every(({ result }) => result.status === 'passed')
          ? 'passed'
          : results.every(({ result }) =>
                result.status === 'passed' || result.status === 'waived') &&
              results.some(({ result }) => result.status === 'waived')
            ? 'waived'
            : 'failed';
        return RepairCheckResultSchema.parse({
          status,
          evidenceArtifactIds,
          output: options.redact(JSON.stringify(results)),
        });
      });
    },
  };
}

async function executeStage<T>(
  database: Database,
  activityType: string,
  input: { readonly idempotencyKey: string },
  next: () => Promise<T>,
): Promise<T> {
  return (await executeIdempotentActivity({
    store: createActivityIdempotencyRepository(database),
    activityType,
    args: [input],
    ownerId: randomUUID(),
    leaseMs: 30 * 60_000,
    renewIntervalMs: 10_000,
    next,
  })) as T;
}

export function createProductionRepairActivities(options: {
  readonly database: Database;
  readonly redact: (value: string) => string;
  readonly modelGateway: RepairModelGateway;
  readonly taskActivities: TaskWorkflowActivities;
  readonly model: string | null;
  readonly budget: { readonly maxCredits: number } | null;
  readonly workspaceResolver: RepairWorkspaceResolver;
  readonly verifierWorkspaces: VerifierWorkspacePort;
  readonly gateRunner: VerificationGateRunner;
  readonly targetedRunner: TargetedRepairRunner;
}): RepairActivities {
  const lifecycle = createPostgresRepairLifecycle(options.database);
  const builder = createTaskWorkflowRepairBuilder({
    activities: options.taskActivities,
    model: options.model,
    budget: options.budget,
  });
  const commits = createWorkspaceRepairCommitPort(options.workspaceResolver);
  const checks = createFreshWorkspaceRepairChecks({
    workspaces: options.verifierWorkspaces,
    gates: options.gateRunner,
    targeted: options.targetedRunner,
    redact: options.redact,
  });
  const keyedTasks: RepairTaskPort = {
    create: (input) =>
      executeStage(options.database, 'repair.createTask', input, () => lifecycle.create(input)),
  };
  const keyedBuilder: RepairBuilderPort = {
    repair: (input) =>
      executeStage(options.database, 'repair.builder', input, () => builder.repair(input)),
  };
  const keyedCommits: RepairCommitPort = {
    verify: (input) =>
      executeStage(options.database, 'repair.verifyCommit', input, () => commits.verify(input)),
  };
  const keyedChecks: RepairCheckPort = {
    targeted: (input) =>
      executeStage(options.database, 'repair.targetedCheck', input, () => checks.targeted(input)),
    affected: (input) =>
      executeStage(options.database, 'repair.affectedGates', input, () => checks.affected(input)),
  };
  const keyedOutcomes: RepairOutcomePort = {
    succeeded: (input) =>
      executeStage(options.database, 'repair.succeeded', input, () => lifecycle.succeeded(input)),
    escalate: (input) =>
      executeStage(options.database, 'repair.escalate', input, () => lifecycle.escalate(input)),
  };
  return createRepairActivities({
    redact: options.redact,
    modelClassifier: createModelGatewayFailureClassifier(options.modelGateway),
    repairTasks: keyedTasks,
    builder: keyedBuilder,
    commits: keyedCommits,
    checks: keyedChecks,
    outcomes: keyedOutcomes,
  });
}
