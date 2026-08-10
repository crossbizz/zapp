import { describe, expect, it, vi } from 'vitest';

import {
  AUTONOMOUS_RUN_BUDGET_MS,
  INTERACTIVE_RUN_BUDGET_MS,
  SandboxQuotaExceededError,
  createRunawayComputeGovernor,
  type GovernorCapacityPort,
} from '../src/lifecycle/governor.js';

const IDS = {
  workspace: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  workspace2: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  organization: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  project: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  run: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  run2: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  task: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  user: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
} as const;

const NOW = new Date('2026-08-09T12:00:00.000Z');
const operationKey = (character: string) => `op_${character.repeat(64)}`;

function admission(purpose: 'builder' | 'preview' | 'verifier' | 'scan' = 'builder') {
  return {
    workspaceId: IDS.workspace,
    organizationId: IDS.organization,
    projectId: IDS.project,
    runId: IDS.run,
    taskId: IDS.task,
    purpose,
    operationKey: operationKey('a'),
  };
}

function capacity(overrides: Partial<GovernorCapacityPort> = {}): GovernorCapacityPort {
  return {
    claim: vi.fn<GovernorCapacityPort['claim']>((input) =>
      Promise.resolve({
        status: 'admitted' as const,
        deadlineAt: new Date(input.requestedAt.getTime() + input.budgetMs),
      }),
    ),
    release: vi.fn<GovernorCapacityPort['release']>(() => Promise.resolve()),
    claimExpired: vi.fn<GovernorCapacityPort['claimExpired']>(() => Promise.resolve([])),
    renewExpired: vi.fn<GovernorCapacityPort['renewExpired']>(() => Promise.resolve(true)),
    completeExpired: vi.fn<GovernorCapacityPort['completeExpired']>(() =>
      Promise.resolve(),
    ),
    releaseExpired: vi.fn<GovernorCapacityPort['releaseExpired']>(() =>
      Promise.resolve(),
    ),
    listOrganization: vi.fn<GovernorCapacityPort['listOrganization']>(() =>
      Promise.resolve([]),
    ),
    ...overrides,
  };
}

function governor(input: {
  capacity?: GovernorCapacityPort;
  checkpointAndTerminate?: (value: unknown) => Promise<void>;
  terminate?: (value: unknown) => Promise<void>;
  audit?: (value: unknown) => Promise<void>;
  now?: () => Date;
  leaseMs?: number;
  sweepLimit?: number;
  scheduler?: {
    setInterval(callback: () => Promise<void>, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
  };
} = {}) {
  return createRunawayComputeGovernor({
    ownerId: 'sandbox-service-test-owner',
    globalLimit: 100,
    now: input.now ?? (() => NOW),
    limits: {
      getOrganizationLimits: vi.fn(() => Promise.resolve({ concurrentSandboxes: 2 })),
    },
    capacity: input.capacity ?? capacity(),
    actions: {
      checkpointAndTerminate:
        input.checkpointAndTerminate ?? vi.fn(() => Promise.resolve()),
      terminate: input.terminate ?? vi.fn(() => Promise.resolve()),
    },
    audit: {
      recordTerminateAll: input.audit ?? vi.fn(() => Promise.resolve()),
    },
    scheduler:
      input.scheduler ??
      ({
        setInterval: vi.fn(() => Symbol('interval')),
        clearInterval: vi.fn(),
      } as const),
    ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
    ...(input.sweepLimit === undefined ? {} : { sweepLimit: input.sweepLimit }),
  });
}

describe('runaway-compute governor', () => {
  it('atomically admits against global and organization limits with purpose-derived run deadlines', async () => {
    const claims: unknown[] = [];
    const store = capacity({
      claim: vi.fn<GovernorCapacityPort['claim']>((input) => {
        claims.push(input);
        return Promise.resolve({
          status: 'admitted',
          deadlineAt: new Date(input.requestedAt.getTime() + input.budgetMs),
        });
      }),
    });
    const service = governor({ capacity: store });

    await expect(service.admit(admission('builder'))).resolves.toEqual({
      status: 'admitted',
      deadlineAt: new Date(NOW.getTime() + INTERACTIVE_RUN_BUDGET_MS),
    });
    await expect(
      service.admit({
        ...admission('scan'),
        workspaceId: IDS.workspace2,
        runId: IDS.run2,
      }),
    ).resolves.toEqual({
      status: 'admitted',
      deadlineAt: new Date(NOW.getTime() + AUTONOMOUS_RUN_BUDGET_MS),
    });
    expect(claims).toEqual([
      expect.objectContaining({
        globalLimit: 100,
        organizationLimit: 2,
        requestedAt: NOW,
        budgetMs: INTERACTIVE_RUN_BUDGET_MS,
      }),
      expect.objectContaining({
        globalLimit: 100,
        organizationLimit: 2,
        requestedAt: NOW,
        budgetMs: AUTONOMOUS_RUN_BUDGET_MS,
      }),
    ]);
  });

  it('reuses one authoritative deadline for every workspace in a run created hours apart', async () => {
    let now = NOW;
    let runDeadline: Date | undefined;
    const claim = vi.fn<GovernorCapacityPort['claim']>((input) => {
      const status = runDeadline === undefined ? 'admitted' : 'replay';
      runDeadline ??= new Date(input.requestedAt.getTime() + input.budgetMs);
      return Promise.resolve({ status, deadlineAt: runDeadline });
    });
    const service = governor({ capacity: capacity({ claim }), now: () => now });

    const first = await service.admit(admission('builder'));
    now = new Date(NOW.getTime() + 3 * 60 * 60_000);
    const second = await service.admit({
      ...admission('builder'),
      workspaceId: IDS.workspace2,
      operationKey: operationKey('b'),
    });

    expect(first.deadlineAt).toEqual(new Date(NOW.getTime() + INTERACTIVE_RUN_BUDGET_MS));
    expect(second).toEqual({ status: 'replay', deadlineAt: first.deadlineAt });
    expect(claim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: IDS.run,
        requestedAt: now,
        budgetMs: INTERACTIVE_RUN_BUDGET_MS,
      }),
    );
  });

  it('replays an existing claim and returns a typed positive queue-position error on denial', async () => {
    const claim = vi
      .fn<GovernorCapacityPort['claim']>()
      .mockResolvedValueOnce({
        status: 'replay',
        deadlineAt: new Date(NOW.getTime() + INTERACTIVE_RUN_BUDGET_MS),
      })
      .mockResolvedValueOnce({ status: 'queued', queuePosition: 3 });
    const service = governor({ capacity: capacity({ claim }) });

    await expect(service.admit(admission())).resolves.toEqual({
      status: 'replay',
      deadlineAt: new Date(NOW.getTime() + INTERACTIVE_RUN_BUDGET_MS),
    });
    const rejected = service.admit({ ...admission(), workspaceId: IDS.workspace2 });
    await expect(rejected).rejects.toBeInstanceOf(SandboxQuotaExceededError);
    await expect(rejected).rejects.toMatchObject({
      code: 'sandbox_quota_exceeded',
      statusCode: 429,
      queuePosition: 3,
    });
  });

  it('rejects malformed limits, decisions, and admissions at the boundary', async () => {
    const badLimits = createRunawayComputeGovernor({
      ownerId: 'sandbox-service-test-owner',
      globalLimit: 100,
      now: () => NOW,
      limits: { getOrganizationLimits: () => Promise.resolve({ concurrentSandboxes: 0 }) },
      capacity: capacity(),
      actions: {
        checkpointAndTerminate: () => Promise.resolve(),
        terminate: () => Promise.resolve(),
      },
      audit: { recordTerminateAll: () => Promise.resolve() },
      scheduler: { setInterval: () => Symbol('interval'), clearInterval: () => undefined },
    });
    await expect(badLimits.admit(admission())).rejects.toThrow();

    const badDecision = governor({
      capacity: capacity({
        claim: () => Promise.resolve({ status: 'queued', queuePosition: 0 }),
      }),
    });
    await expect(badDecision.admit(admission())).rejects.toThrow();
    await expect(badDecision.admit({ ...admission(), organizationId: 'org_bad' })).rejects.toThrow();
  });

  it('claims expired runs, checkpoints before termination, completes the fence, and releases failures', async () => {
    const events: string[] = [];
    const expired = {
      workspaceId: IDS.workspace,
      organizationId: IDS.organization,
      projectId: IDS.project,
      runId: IDS.run,
      taskId: IDS.task,
      purpose: 'builder' as const,
      deadlineAt: new Date(NOW.getTime() - 1),
      leaseToken: 'lease-1',
    };
    const store = capacity({
      claimExpired: vi
        .fn<GovernorCapacityPort['claimExpired']>()
        .mockResolvedValueOnce([expired])
        .mockResolvedValueOnce([
          { ...expired, workspaceId: IDS.workspace2, leaseToken: 'lease-2' },
        ])
        .mockResolvedValue([]),
      completeExpired: vi.fn<GovernorCapacityPort['completeExpired']>((input) => {
        events.push(`complete:${input.workspaceId}:${input.leaseToken}`);
        return Promise.resolve();
      }),
      releaseExpired: vi.fn<GovernorCapacityPort['releaseExpired']>((input) => {
        events.push(`release:${input.workspaceId}:${input.leaseToken}`);
        return Promise.resolve();
      }),
    });
    const service = governor({
      capacity: store,
      checkpointAndTerminate: (input) => {
        const parsed = input as { workspaceId: string };
        events.push(`terminate:${parsed.workspaceId}`);
        return parsed.workspaceId === IDS.workspace2
          ? Promise.reject(new Error('checkpoint unavailable'))
          : Promise.resolve();
      },
    });

    await service.sweepExpired();
    expect(events).toEqual([
      `terminate:${IDS.workspace}`,
      `complete:${IDS.workspace}:lease-1`,
      `terminate:${IDS.workspace2}`,
      `release:${IDS.workspace2}:lease-2`,
    ]);
  });

  it('renews a long expiry action and lets a new fenced owner take over after renewal loss', async () => {
    const first = {
      workspaceId: IDS.workspace,
      organizationId: IDS.organization,
      projectId: IDS.project,
      runId: IDS.run,
      taskId: IDS.task,
      purpose: 'builder' as const,
      deadlineAt: new Date(NOW.getTime() - 1),
      leaseToken: 'lease-old',
    };
    const claimExpired = vi
      .fn<GovernorCapacityPort['claimExpired']>()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...first, leaseToken: 'lease-new' }])
      .mockResolvedValue([]);
    const renewExpired = vi
      .fn<GovernorCapacityPort['renewExpired']>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const completeExpired = vi.fn<GovernorCapacityPort['completeExpired']>(() =>
      Promise.resolve(),
    );
    let renewalTick: (() => Promise<void>) | undefined;
    const scheduler = {
      setInterval: vi.fn((callback: () => Promise<void>) => {
        renewalTick = callback;
        return Symbol('renewal');
      }),
      clearInterval: vi.fn(),
    };
    const actionLeaseTokens: string[] = [];
    const service = governor({
      leaseMs: 10,
      capacity: capacity({ claimExpired, renewExpired, completeExpired }),
      scheduler,
      checkpointAndTerminate: (input) => {
        const parsed = input as { leaseToken: string; signal: AbortSignal };
        actionLeaseTokens.push(parsed.leaseToken);
        if (parsed.leaseToken === 'lease-new') return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          parsed.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('lost expiry lease'));
            },
            { once: true },
          );
        });
      },
    });

    const staleOwner = service.sweepExpired();
    await vi.waitFor(() => {
      expect(renewalTick).toBeDefined();
    });
    await renewalTick?.();
    await renewalTick?.();
    await staleOwner;
    await service.sweepExpired();

    expect(actionLeaseTokens).toEqual(['lease-old', 'lease-new']);
    expect(renewExpired).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      leaseToken: 'lease-old',
      leaseMs: 10,
    });
    expect(completeExpired).toHaveBeenCalledTimes(1);
    expect(completeExpired).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: 'lease-new' }),
    );
  });

  it('claims one expiry at a time so later work is not leased behind a long action', async () => {
    const expired = {
      workspaceId: IDS.workspace,
      organizationId: IDS.organization,
      projectId: IDS.project,
      runId: IDS.run,
      taskId: IDS.task,
      purpose: 'builder' as const,
      deadlineAt: new Date(NOW.getTime() - 1),
      leaseToken: 'lease-first',
    };
    const limits: number[] = [];
    const claimExpired = vi.fn<GovernorCapacityPort['claimExpired']>((input) => {
      limits.push(input.limit);
      const invocation = limits.length;
      if (invocation === 1) return Promise.resolve([expired]);
      if (invocation === 2) {
        return Promise.resolve([
          { ...expired, workspaceId: IDS.workspace2, leaseToken: 'lease-second' },
        ]);
      }
      return Promise.resolve([]);
    });
    let finishFirst: (() => void) | undefined;
    const service = governor({
      sweepLimit: 2,
      capacity: capacity({ claimExpired }),
      checkpointAndTerminate: (input) => {
        const { workspaceId } = input as { workspaceId: string };
        if (workspaceId === IDS.workspace2) return Promise.resolve();
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      },
    });

    const sweep = service.sweepExpired();
    await vi.waitFor(() => {
      expect(finishFirst).toBeDefined();
    });
    expect(claimExpired).toHaveBeenCalledTimes(1);
    finishFirst?.();
    await sweep;

    expect(limits).toEqual([1, 1]);
  });

  it('aborts a stalled fenced action and clears its renewal when stopped', async () => {
    const expired = {
      workspaceId: IDS.workspace,
      organizationId: IDS.organization,
      projectId: IDS.project,
      runId: IDS.run,
      taskId: IDS.task,
      purpose: 'builder' as const,
      deadlineAt: new Date(NOW.getTime() - 1),
      leaseToken: 'lease-stalled',
    };
    const scheduler = {
      setInterval: vi.fn(() => Symbol('renewal')),
      clearInterval: vi.fn(),
    };
    let actionStarted = false;
    const service = governor({
      capacity: capacity({
        claimExpired: vi
          .fn<GovernorCapacityPort['claimExpired']>()
          .mockResolvedValueOnce([expired])
          .mockResolvedValue([]),
      }),
      scheduler,
      checkpointAndTerminate: (input) => {
        const { signal } = input as { signal: AbortSignal };
        actionStarted = true;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('shutdown'));
            },
            { once: true },
          );
        });
      },
    });

    const sweep = service.sweepExpired();
    await vi.waitFor(() => {
      expect(actionStarted).toBe(true);
    });
    const outcome = await Promise.race([
      service.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, 50);
      }),
    ]);

    expect(outcome).toBe('stopped');
    await sweep;
    expect(scheduler.clearInterval).toHaveBeenCalled();
  });

  it('releases a delayed expiry claim that arrives after shutdown without starting work', async () => {
    const expired = {
      workspaceId: IDS.workspace,
      organizationId: IDS.organization,
      projectId: IDS.project,
      runId: IDS.run,
      taskId: IDS.task,
      purpose: 'builder' as const,
      deadlineAt: new Date(NOW.getTime() - 1),
      leaseToken: 'lease-after-stop',
    };
    let resolveClaim: ((claims: readonly [typeof expired]) => void) | undefined;
    const pendingClaim = new Promise<readonly [typeof expired]>((resolve) => {
      resolveClaim = resolve;
    });
    const releaseExpired = vi.fn<GovernorCapacityPort['releaseExpired']>(() =>
      Promise.resolve(),
    );
    const checkpointAndTerminate = vi.fn(() => Promise.resolve());
    const service = governor({
      capacity: capacity({
        claimExpired: vi.fn(() => pendingClaim),
        releaseExpired,
      }),
      checkpointAndTerminate,
    });

    const sweep = service.sweepExpired();
    const stopped = service.stop();
    resolveClaim?.([expired]);
    await Promise.all([sweep, stopped]);

    expect(checkpointAndTerminate).not.toHaveBeenCalled();
    expect(releaseExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspace,
        leaseToken: 'lease-after-stop',
      }),
    );
  });

  it('starts one bounded scheduler, prevents overlapping sweeps, and stops cleanly', async () => {
    let tick: (() => Promise<void>) | undefined;
    const handle = Symbol('governor');
    const scheduler = {
      setInterval: vi.fn((callback: () => Promise<void>, intervalMs: number) => {
        expect(intervalMs).toBe(30_000);
        tick = callback;
        return handle;
      }),
      clearInterval: vi.fn(),
    };
    let releaseClaim: (() => void) | undefined;
    const claim = new Promise<readonly []>((resolve) => {
      releaseClaim = () => {
        resolve([]);
      };
    });
    const store = capacity({ claimExpired: vi.fn(() => claim) });
    const service = governor({ capacity: store, scheduler });

    service.start();
    service.start();
    expect(scheduler.setInterval).toHaveBeenCalledTimes(1);
    const first = tick?.();
    const second = tick?.();
    const { claimExpired } = store;
    expect(claimExpired).toHaveBeenCalledTimes(1);
    releaseClaim?.();
    await Promise.all([first, second]);
    await service.stop();
    await service.stop();
    expect(scheduler.clearInterval).toHaveBeenCalledTimes(1);
    expect(scheduler.clearInterval).toHaveBeenCalledWith(handle);
  });

  it('audits before an idempotent tenant-scoped support termination and releases every completed workspace', async () => {
    const events: string[] = [];
    const store = capacity({
      listOrganization: vi.fn<GovernorCapacityPort['listOrganization']>(
        ({ organizationId }) =>
          Promise.resolve([
            {
              workspaceId: IDS.workspace,
              organizationId,
              projectId: IDS.project,
              runId: IDS.run,
              taskId: IDS.task,
              purpose: 'builder' as const,
              deadlineAt: new Date(NOW.getTime() + 1_000),
            },
          ]),
      ),
      release: vi.fn<GovernorCapacityPort['release']>(({ workspaceId }) => {
        events.push(`release:${workspaceId}`);
        return Promise.resolve();
      }),
    });
    const service = governor({
      capacity: store,
      audit: (input) => {
        const { operationKey: key } = input as { operationKey: string };
        events.push(`audit:${key}`);
        return Promise.resolve();
      },
      terminate: (input) => {
        const { workspaceId } = input as { workspaceId: string };
        events.push(`terminate:${workspaceId}`);
        return Promise.resolve();
      },
    });

    await expect(
      service.terminateAll({
        organizationId: IDS.organization,
        actorUserId: IDS.user,
        reason: 'Customer-requested support containment',
        operationKey: operationKey('f'),
      }),
    ).resolves.toEqual({ terminated: 1 });
    expect(events).toEqual([
      `audit:${operationKey('f')}`,
      `terminate:${IDS.workspace}`,
      `release:${IDS.workspace}`,
    ]);
  });
});
