import { createHash } from 'node:crypto';

import { WorkspacePurposeSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

const HOUR_MS = 60 * 60_000;
export const INTERACTIVE_RUN_BUDGET_MS = 4 * HOUR_MS;
export const AUTONOMOUS_RUN_BUDGET_MS = 8 * HOUR_MS;

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_SWEEP_LIMIT = 100;

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const PositiveLimitSchema = z.number().int().positive();

const GovernorAdmissionInputSchema = z
  .object({
    workspaceId: idSchema('ws'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    purpose: WorkspacePurposeSchema,
    operationKey: OperationKeySchema,
  })
  .strict();

const GovernorClaimInputSchema = GovernorAdmissionInputSchema.extend({
  requestedAt: z.date(),
  budgetMs: PositiveLimitSchema,
  globalLimit: PositiveLimitSchema,
  organizationLimit: PositiveLimitSchema,
}).strict();

const GovernorAdmissionDecisionSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.enum(['admitted', 'replay']), deadlineAt: z.date() })
    .strict(),
  z.object({ status: z.literal('queued'), queuePosition: PositiveLimitSchema }).strict(),
]);

const GovernorReleaseInputSchema = z
  .object({
    workspaceId: idSchema('ws'),
    organizationId: idSchema('org'),
    operationKey: OperationKeySchema,
  })
  .strict();

const GovernorExpiredClaimSchema = GovernorAdmissionInputSchema.omit({
  operationKey: true,
})
  .extend({
    deadlineAt: z.date(),
    leaseToken: z.string().min(1),
  })
  .strict();
const GovernorTerminationCandidateSchema = GovernorExpiredClaimSchema.omit({
  leaseToken: true,
});

const ClaimExpiredInputSchema = z
  .object({
    now: z.date(),
    ownerId: z.string().min(1),
    leaseMs: PositiveLimitSchema,
    limit: PositiveLimitSchema,
  })
  .strict();

const ExpiredFenceInputSchema = z
  .object({
    workspaceId: idSchema('ws'),
    leaseToken: z.string().min(1),
    operationKey: OperationKeySchema,
  })
  .strict();

const RenewExpiredInputSchema = ExpiredFenceInputSchema.omit({ operationKey: true })
  .extend({ leaseMs: PositiveLimitSchema })
  .strict();

const OrganizationListInputSchema = z
  .object({ organizationId: idSchema('org'), operationKey: OperationKeySchema })
  .strict();

const GovernorTerminateAllInputSchema = z
  .object({
    organizationId: idSchema('org'),
    actorUserId: idSchema('user'),
    reason: z.string().trim().min(10).max(500),
    operationKey: OperationKeySchema,
  })
  .strict();

const GovernorTerminateAllResultSchema = z
  .object({ terminated: z.number().int().nonnegative() })
  .strict();

const OrganizationLimitsSchema = z
  .object({ concurrentSandboxes: PositiveLimitSchema })
  .strict();

type GovernorClaimInput = z.infer<typeof GovernorClaimInputSchema>;
type GovernorReleaseInput = z.infer<typeof GovernorReleaseInputSchema>;
type GovernorExpiredClaim = z.infer<typeof GovernorExpiredClaimSchema>;
type GovernorTerminationCandidate = z.infer<typeof GovernorTerminationCandidateSchema>;
type ExpiredFenceInput = z.infer<typeof ExpiredFenceInputSchema>;
type GovernorTerminateAllInput = z.infer<typeof GovernorTerminateAllInputSchema>;

export interface GovernorCapacityPort {
  /**
   * Atomically checks both limits, persists one deadline per tenant+run, and claims or
   * replays one workspace slot. Decisions remain replayable by operationKey after release.
   */
  readonly claim: (input: GovernorClaimInput) => Promise<unknown>;
  /** Idempotently removes one admitted workspace from both counters, retaining its decision. */
  readonly release: (input: GovernorReleaseInput) => Promise<void>;
  /** Claims expired rows with a renewable durable fence; never an in-memory lease. */
  readonly claimExpired: (
    input: z.infer<typeof ClaimExpiredInputSchema>,
  ) => Promise<unknown>;
  readonly renewExpired: (input: z.infer<typeof RenewExpiredInputSchema>) => Promise<boolean>;
  readonly completeExpired: (input: ExpiredFenceInput) => Promise<void>;
  readonly releaseExpired: (input: ExpiredFenceInput) => Promise<void>;
  /** Returns active rows for exactly one organization. */
  readonly listOrganization: (
    input: z.infer<typeof OrganizationListInputSchema>,
  ) => Promise<unknown>;
}

export interface RunawayComputeGovernor {
  readonly admit: (input: unknown) => Promise<
    | { readonly status: 'admitted'; readonly deadlineAt: Date }
    | { readonly status: 'replay'; readonly deadlineAt: Date }
  >;
  readonly release: (input: unknown) => Promise<void>;
  readonly sweepExpired: () => Promise<void>;
  readonly terminateAll: (input: unknown) => Promise<{ readonly terminated: number }>;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

export class SandboxQuotaExceededError extends Error {
  public readonly code = 'sandbox_quota_exceeded' as const;
  public readonly statusCode = 429 as const;

  public constructor(public readonly queuePosition: number) {
    super('The organization sandbox quota is currently full.');
    this.name = 'SandboxQuotaExceededError';
  }
}

export interface RunawayComputeGovernorDependencies {
  readonly ownerId: string;
  readonly globalLimit: number;
  readonly now: () => Date;
  readonly limits: {
    getOrganizationLimits(organizationId: string): Promise<unknown>;
  };
  readonly capacity: GovernorCapacityPort;
  readonly actions: {
    /** Implementations must honor both the durable lease token and abort signal before mutation. */
    checkpointAndTerminate(
      input: GovernorExpiredClaim & {
        readonly operationKey: string;
        readonly signal: AbortSignal;
      },
    ): Promise<void>;
    terminate(
      input: GovernorTerminationCandidate & {
        readonly operationKey: string;
        readonly signal: AbortSignal;
      },
    ): Promise<void>;
  };
  readonly audit: {
    /** Must be idempotent by operationKey and complete before provider mutation. */
    recordTerminateAll(input: GovernorTerminateAllInput): Promise<void>;
  };
  readonly scheduler: {
    setInterval(callback: () => Promise<void>, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
  };
  readonly sweepIntervalMs?: number;
  readonly leaseMs?: number;
  readonly sweepLimit?: number;
}

function budgetForPurpose(purpose: z.infer<typeof WorkspacePurposeSchema>): number {
  return purpose === 'builder' || purpose === 'preview'
    ? INTERACTIVE_RUN_BUDGET_MS
    : AUTONOMOUS_RUN_BUDGET_MS;
}

function childOperationKey(parent: string, action: string): string {
  return `op_${createHash('sha256').update(`${parent}:${action}`).digest('hex')}`;
}

export function createRunawayComputeGovernor(
  dependencies: RunawayComputeGovernorDependencies,
): RunawayComputeGovernor {
  const ownerId = z.string().min(1).parse(dependencies.ownerId);
  const globalLimit = PositiveLimitSchema.parse(dependencies.globalLimit);
  const sweepIntervalMs = PositiveLimitSchema.parse(
    dependencies.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
  );
  const leaseMs = PositiveLimitSchema.parse(dependencies.leaseMs ?? DEFAULT_LEASE_MS);
  const sweepLimit = PositiveLimitSchema.parse(
    dependencies.sweepLimit ?? DEFAULT_SWEEP_LIMIT,
  );

  let intervalHandle: { readonly value: unknown } | undefined;
  let activeSweep: Promise<void> | undefined;
  const lifecycle = { stopping: false };
  const activeClaims = new Set<{
    readonly controller: AbortController;
    readonly renewalHandle: unknown;
  }>();
  const isStopping = (): boolean => lifecycle.stopping;

  const sweepExpired = (): Promise<void> => {
    if (isStopping()) return Promise.resolve();
    if (activeSweep !== undefined) return activeSweep;
    const sweep = (async () => {
      for (
        let processed = 0;
        processed < sweepLimit && !isStopping();
        processed += 1
      ) {
        const [claim] = z
          .array(GovernorExpiredClaimSchema)
          .max(1)
          .parse(
            await dependencies.capacity.claimExpired(
              ClaimExpiredInputSchema.parse({
                now: z.date().parse(dependencies.now()),
                ownerId,
                leaseMs,
                limit: 1,
              }),
            ),
          );
        if (claim === undefined) break;
        const operationKey = childOperationKey(
          `op_${createHash('sha256').update(`${claim.runId}:${claim.deadlineAt.toISOString()}`).digest('hex')}`,
          `wall-clock:${claim.workspaceId}`,
        );
        const fence = ExpiredFenceInputSchema.parse({
          workspaceId: claim.workspaceId,
          leaseToken: claim.leaseToken,
          operationKey,
        });
        if (isStopping()) {
          await dependencies.capacity.releaseExpired(fence);
          break;
        }
        const controller = new AbortController();
        const renewal = { lost: false };
        let renewalInFlight: Promise<void> | undefined;
        const markRenewalLost = (): void => {
          renewal.lost = true;
          controller.abort(new Error('Sandbox expiry lease was lost.'));
        };
        const renew = (): Promise<void> => {
          if (renewal.lost) return Promise.reject(new Error('Sandbox expiry lease was lost.'));
          if (renewalInFlight !== undefined) return renewalInFlight;
          const pending = (async () => {
            const renewed = await dependencies.capacity.renewExpired(
              RenewExpiredInputSchema.parse({
                workspaceId: claim.workspaceId,
                leaseToken: claim.leaseToken,
                leaseMs,
              }),
            );
            if (!renewed) {
              markRenewalLost();
              throw new Error('Sandbox expiry lease was lost.');
            }
          })();
          const tracked = pending.finally(() => {
            if (renewalInFlight === tracked) renewalInFlight = undefined;
          });
          renewalInFlight = tracked;
          return tracked;
        };
        const renewalHandle = dependencies.scheduler.setInterval(async () => {
          try {
            await renew();
          } catch {
            markRenewalLost();
          }
        }, Math.max(1, Math.floor(leaseMs / 2)));
        const activeClaim = { controller, renewalHandle };
        activeClaims.add(activeClaim);
        try {
          await dependencies.actions.checkpointAndTerminate({
            ...claim,
            operationKey,
            signal: controller.signal,
          });
          await renew();
          await dependencies.capacity.completeExpired(fence);
        } catch {
          controller.abort();
          try {
            await renewalInFlight;
          } catch {
            // A lost fence cannot be released or completed by this owner.
          }
          if (!renewal.lost) await dependencies.capacity.releaseExpired(fence);
        } finally {
          dependencies.scheduler.clearInterval(renewalHandle);
          activeClaims.delete(activeClaim);
        }
      }
    })();
    const tracked = sweep.finally(() => {
      if (activeSweep === tracked) activeSweep = undefined;
    });
    activeSweep = tracked;
    return tracked;
  };

  return {
    async admit(inputValue) {
      const input = GovernorAdmissionInputSchema.parse(inputValue);
      const limits = OrganizationLimitsSchema.parse(
        await dependencies.limits.getOrganizationLimits(input.organizationId),
      );
      const decision = GovernorAdmissionDecisionSchema.parse(
        await dependencies.capacity.claim(
          GovernorClaimInputSchema.parse({
            ...input,
            requestedAt: z.date().parse(dependencies.now()),
            budgetMs: budgetForPurpose(input.purpose),
            globalLimit,
            organizationLimit: limits.concurrentSandboxes,
          }),
        ),
      );
      if (decision.status === 'queued') {
        throw new SandboxQuotaExceededError(decision.queuePosition);
      }
      return decision;
    },

    async release(inputValue) {
      await dependencies.capacity.release(GovernorReleaseInputSchema.parse(inputValue));
    },

    sweepExpired,

    async terminateAll(inputValue) {
      const input = GovernorTerminateAllInputSchema.parse(inputValue);
      await dependencies.audit.recordTerminateAll(input);
      const candidates = z
        .array(GovernorTerminationCandidateSchema)
        .parse(
          await dependencies.capacity.listOrganization(
            OrganizationListInputSchema.parse({
              organizationId: input.organizationId,
              operationKey: input.operationKey,
            }),
          ),
        );
      let terminated = 0;
      for (const candidate of candidates) {
        if (candidate.organizationId !== input.organizationId) {
          throw new Error('Sandbox capacity store returned a cross-tenant workspace.');
        }
        const operationKey = childOperationKey(
          input.operationKey,
          `terminate-all:${candidate.workspaceId}`,
        );
        await dependencies.actions.terminate({
          ...candidate,
          operationKey,
          signal: new AbortController().signal,
        });
        await dependencies.capacity.release(
          GovernorReleaseInputSchema.parse({
            workspaceId: candidate.workspaceId,
            organizationId: input.organizationId,
            operationKey,
          }),
        );
        terminated += 1;
      }
      return GovernorTerminateAllResultSchema.parse({ terminated });
    },

    start() {
      if (intervalHandle !== undefined) return;
      lifecycle.stopping = false;
      intervalHandle = {
        value: dependencies.scheduler.setInterval(async () => {
          try {
            await sweepExpired();
          } catch {
            // Durable claims remain available for the next bounded sweep.
          }
        }, sweepIntervalMs),
      };
    },

    async stop() {
      lifecycle.stopping = true;
      if (intervalHandle !== undefined) {
        dependencies.scheduler.clearInterval(intervalHandle.value);
        intervalHandle = undefined;
      }
      for (const activeClaim of activeClaims) {
        dependencies.scheduler.clearInterval(activeClaim.renewalHandle);
        activeClaim.controller.abort(new Error('Sandbox governor is shutting down.'));
      }
      try {
        await activeSweep;
      } catch {
        // Shutdown has already stopped scheduling; the durable claim is retried by another owner.
      }
    },
  };
}
