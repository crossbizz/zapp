import { describe, expect, it } from 'vitest';

import {
  InvalidTransition,
  createLifecycleManager,
  handleLifecycleFailure,
  lifecycleFailureDisposition,
  reconcileWorkspaces,
  transitionLifecycle,
} from '../src/lifecycle/manager.js';
import {
  HARD_REPLACE_MS,
  createWorkspaceReaper,
  idleTimeoutMs,
} from '../src/lifecycle/reaper.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

describe('workspace lifecycle manager', () => {
  it('accepts only adjacent transitions in the PRD lifecycle', () => {
    const legal = [
      ['requested', 'provisioning'],
      ['provisioning', 'started'],
      ['started', 'ready'],
      ['ready', 'active'],
      ['active', 'checkpointing'],
      ['checkpointing', 'idle'],
      ['idle', 'terminated'],
    ] as const;

    for (const [from, to] of legal) {
      expect(transitionLifecycle(from, to)).toBe(to);
    }

    for (const [from, to] of [
      ['requested', 'ready'],
      ['active', 'idle'],
      ['terminated', 'requested'],
      ['ready', 'ready'],
    ] as const) {
      expect(() => transitionLifecycle(from, to)).toThrow(InvalidTransition);
    }
  });

  it('retries provider creation exactly three times before a failed outcome and event', async () => {
    const attempts: unknown[] = [];
    const delays: number[] = [];
    const notices: unknown[] = [];
    const forcedTerminal: unknown[] = [];
    const manager = createLifecycleManager({
      sleep(ms) {
        delays.push(ms);
        return Promise.resolve();
      },
      jitterDelayMs(attempt) {
        return attempt * 100;
      },
      emit(notice) {
        notices.push(notice);
        return Promise.resolve();
      },
      forceTerminal(scope, abnormal) {
        forcedTerminal.push({ scope, abnormal });
        return Promise.resolve();
      },
    });

    const scope = {
      workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      operationKey: `op_${'a'.repeat(64)}`,
    };
    const result = await manager.provision(scope, (attempt) => {
      attempts.push(attempt);
      return Promise.reject(new Error('provider unavailable'));
    });

    expect(result).toEqual({ outcome: 'failed', attempts: 3, workspaceStatus: 'terminated' });
    expect(attempts).toEqual([
      { attempt: 1, operationKey: scope.operationKey },
      { attempt: 2, operationKey: scope.operationKey },
      { attempt: 3, operationKey: scope.operationKey },
    ]);
    expect(delays).toEqual([100, 200]);
    expect(forcedTerminal).toEqual([
      { scope, abnormal: true },
    ]);
    expect(notices).toEqual([
      {
        kind: 'creation_failed',
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        operationKey: scope.operationKey,
        attempts: 3,
        abnormal: true,
      },
    ]);
  });

  it('treats a malformed provider handle as a keyed creation failure', async () => {
    const attempts: number[] = [];
    const terminal: unknown[] = [];
    const manager = createLifecycleManager({
      sleep() {
        return Promise.resolve();
      },
      jitterDelayMs() {
        return 0;
      },
      emit(notice) {
        terminal.push(notice);
        return Promise.resolve();
      },
      forceTerminal(scope, abnormal) {
        terminal.push({ scope, abnormal });
        return Promise.resolve();
      },
    });
    const scope = {
      workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      operationKey: `op_${'9'.repeat(64)}`,
    };

    const result = await manager.provision(scope, ({ attempt, operationKey }) => {
      expect(operationKey).toBe(scope.operationKey);
      attempts.push(attempt);
      return Promise.resolve({ providerWorkspaceId: '' });
    });

    expect(result).toEqual({ outcome: 'failed', attempts: 3, workspaceStatus: 'terminated' });
    expect(attempts).toEqual([1, 2, 3]);
    expect(terminal).toHaveLength(2);
  });

  it('executes each failure recovery effect with tenant scope and an operation key', async () => {
    const effects: string[] = [];
    const scope = {
      workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      operationKey: `op_${'b'.repeat(64)}`,
    };
    const dependencies = {
      retryCreation(input: unknown, attempts: number) {
        effects.push(`retryCreation:${JSON.stringify(input)}:${String(attempts)}`);
        return Promise.resolve();
      },
      retryStatus(input: unknown) {
        effects.push(`retryStatus:${JSON.stringify(input)}`);
        return Promise.resolve();
      },
      captureBootLogsArtifact(input: unknown) {
        effects.push(`captureBootLogsArtifact:${JSON.stringify(input)}`);
        return Promise.resolve();
      },
      markTerminated(input: unknown, abnormal: true) {
        effects.push(`markTerminated:${JSON.stringify(input)}:${String(abnormal)}`);
        return Promise.resolve();
      },
      recoverFromCheckpoint(input: unknown) {
        effects.push(`recoverFromCheckpoint:${JSON.stringify(input)}`);
        return Promise.resolve();
      },
      failCommand(input: unknown) {
        effects.push(`failCommand:${JSON.stringify(input)}`);
        return Promise.resolve();
      },
      retryNetworkOperation(input: unknown) {
        effects.push(`retryNetworkOperation:${JSON.stringify(input)}`);
        return Promise.resolve();
      },
      restoreWorkspace(input: unknown) {
        effects.push(`restoreWorkspace:${JSON.stringify(input)}`);
        return Promise.resolve();
      },
      restoreFromGitAndArtifacts(input: unknown) {
        effects.push(`restoreFromGitAndArtifacts:${JSON.stringify(input)}`);
        return Promise.resolve();
      },
    };

    for (const kind of [
      'provider_creation_failure',
      'scheduling_delay',
      'readiness_failure',
      'oom',
      'command_timeout',
      'network_failure',
      'unexpected_termination',
      'expired_sandbox_id',
      'expired_snapshot',
      'volume_sync_failure',
    ] as const) {
      await handleLifecycleFailure({ ...scope, kind }, dependencies);
    }

    expect(effects.map((effect) => effect.split(':', 1)[0])).toEqual([
      'retryCreation',
      'retryStatus',
      'captureBootLogsArtifact',
      'markTerminated',
      'markTerminated',
      'recoverFromCheckpoint',
      'failCommand',
      'retryNetworkOperation',
      'markTerminated',
      'recoverFromCheckpoint',
      'restoreWorkspace',
      'restoreFromGitAndArtifacts',
      'restoreFromGitAndArtifacts',
    ]);
    expect(effects.every((effect) => effect.includes(scope.operationKey))).toBe(true);
  });

  it('defines a closed recovery action for every PRD failure case', () => {
    expect(
      [
        'provider_creation_failure',
        'scheduling_delay',
        'readiness_failure',
        'oom',
        'command_timeout',
        'network_failure',
        'unexpected_termination',
        'expired_sandbox_id',
        'expired_snapshot',
        'volume_sync_failure',
      ].map((kind) => lifecycleFailureDisposition(kind)),
    ).toEqual([
      { action: 'retry_creation', maxAttempts: 3 },
      { action: 'retry_status' },
      { action: 'capture_boot_logs_then_terminate', abnormal: true },
      { action: 'terminate_then_restore_checkpoint', abnormal: true },
      { action: 'fail_command' },
      { action: 'retry_network_operation' },
      { action: 'terminate_then_restore_checkpoint', abnormal: true },
      { action: 'restore_workspace' },
      { action: 'restore_from_git_and_artifacts' },
      { action: 'restore_from_git_and_artifacts' },
    ]);
    expect(() => lifecycleFailureDisposition('other')).toThrow();
  });

  it('terminates provider orphans and marks stale active rows terminated', async () => {
    const terminated: string[] = [];
    const staleRows: unknown[] = [];
    const alerts: unknown[] = [];

    const result = await reconcileWorkspaces(
      {
        operationKey: `op_${'c'.repeat(64)}`,
        rows: [
          {
            workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            providerWorkspaceId: 'sb-live',
            status: 'active',
          },
          {
            workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
            organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            providerWorkspaceId: 'sb-missing',
            status: 'active',
          },
        ],
        providerSandboxes: [
          {
            providerWorkspaceId: 'sb-live',
            organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
          },
          {
            providerWorkspaceId: 'sb-orphan',
            organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
          },
        ],
      },
      {
        acquireLeaderLease(operationKey) {
          expect(operationKey).toBe(`op_${'c'.repeat(64)}`);
          return Promise.resolve('lease-1');
        },
        releaseLeaderLease(leaseToken) {
          expect(leaseToken).toBe('lease-1');
          return Promise.resolve();
        },
        terminateProvider(input) {
          terminated.push(input.providerWorkspaceId);
          expect(input.organizationId).toBe('org_01J8ME7YQZJ2V9Q0X3T5B6K7NA');
          expect(input.operationKey).toMatch(/^op_[a-f0-9]{64}$/u);
          expect(input.leaseToken).toBe('lease-1');
          return Promise.resolve();
        },
        markTerminated(input, abnormal) {
          staleRows.push({ workspaceId: input.workspaceId, abnormal });
          expect(input.organizationId).toBe('org_01J8ME7YQZJ2V9Q0X3T5B6K7NA');
          expect(input.operationKey).toMatch(/^op_[a-f0-9]{64}$/u);
          expect(input.leaseToken).toBe('lease-1');
          return Promise.resolve();
        },
        alert(alert) {
          alerts.push(alert);
          return Promise.resolve();
        },
      },
    );

    expect(result).toEqual({
      leaseAcquired: true,
      orphanProvidersTerminated: 1,
      staleRowsTerminated: 1,
    });
    expect(terminated).toEqual(['sb-orphan']);
    expect(staleRows).toEqual([
      { workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NB', abnormal: true },
    ]);
    expect(alerts).toEqual([
      {
        kind: 'orphan_provider',
        providerWorkspaceId: 'sb-orphan',
        organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      },
      {
        kind: 'stale_database_row',
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
        organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      },
    ]);
  });
});

describe('workspace reaper', () => {
  it('uses 15 minute interactive and 30 minute autonomous idle deadlines', () => {
    expect(idleTimeoutMs('builder')).toBe(15 * 60_000);
    expect(idleTimeoutMs('preview')).toBe(15 * 60_000);
    expect(idleTimeoutMs('verifier')).toBe(30 * 60_000);
    expect(idleTimeoutMs('scan')).toBe(30 * 60_000);
  });

  it('checkpoints before idle termination and hard-replaces at 23 hours', async () => {
    const actions: string[] = [];
    const reaper = createWorkspaceReaper({
      now: () => NOW,
      claim(input) {
        actions.push(`claim:${input.workspaceId}:${input.expectedStatus}`);
        return Promise.resolve(true);
      },
      checkpoint(input) {
        actions.push(`checkpoint:${input.workspaceId}`);
        return Promise.resolve();
      },
      terminate(input) {
        actions.push(`terminate:${input.workspaceId}`);
        return Promise.resolve();
      },
      transition(input) {
        actions.push(`transition:${input.workspaceId}:${input.from}:${input.to}`);
        return Promise.resolve();
      },
    });

    const result = await reaper.sweep([
      {
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        purpose: 'builder',
        status: 'active',
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        lastActiveAt: new Date(NOW.getTime() - 15 * 60_000),
        operationKey: `op_${'d'.repeat(64)}`,
      },
      {
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
        purpose: 'verifier',
        status: 'active',
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        lastActiveAt: new Date(NOW.getTime() - 20 * 60_000),
        operationKey: `op_${'e'.repeat(64)}`,
      },
      {
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
        purpose: 'scan',
        status: 'active',
        createdAt: new Date(NOW.getTime() - HARD_REPLACE_MS),
        lastActiveAt: new Date(NOW.getTime() - 60_000),
        operationKey: `op_${'f'.repeat(64)}`,
      },
    ]);

    expect(result).toEqual({ reaped: 2, idle: 1, hardReplaced: 1 });
    expect(actions).toEqual([
      'claim:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA:active',
      'checkpoint:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA:checkpointing:idle',
      'terminate:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA:idle:terminated',
      'claim:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC:active',
      'checkpoint:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC:checkpointing:idle',
      'terminate:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC:idle:terminated',
    ]);
  });

  it('uses creation time for null activity, rejects a stale claim, and resumes partial runs', async () => {
    const actions: string[] = [];
    const reaper = createWorkspaceReaper({
      now: () => NOW,
      claim(input) {
        actions.push(`claim:${input.workspaceId}`);
        return Promise.resolve(input.workspaceId.endsWith('NA'));
      },
      checkpoint(input) {
        actions.push(`checkpoint:${input.workspaceId}`);
        return Promise.resolve();
      },
      terminate(input) {
        actions.push(`terminate:${input.workspaceId}`);
        return Promise.resolve();
      },
      transition(input) {
        actions.push(`transition:${input.workspaceId}:${input.from}:${input.to}`);
        return Promise.resolve();
      },
    });

    const summary = await reaper.sweep([
      {
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        purpose: 'builder',
        status: 'active',
        createdAt: new Date(NOW.getTime() - 15 * 60_000),
        lastActiveAt: null,
        operationKey: `op_${'1'.repeat(64)}`,
      },
      {
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
        purpose: 'builder',
        status: 'active',
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        lastActiveAt: new Date(NOW.getTime() - 15 * 60_000),
        operationKey: `op_${'2'.repeat(64)}`,
      },
      {
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
        purpose: 'scan',
        status: 'checkpointing',
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        lastActiveAt: new Date(NOW.getTime() - 31 * 60_000),
        operationKey: `op_${'3'.repeat(64)}`,
      },
      {
        workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
        purpose: 'scan',
        status: 'idle',
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        lastActiveAt: new Date(NOW.getTime() - 31 * 60_000),
        operationKey: `op_${'4'.repeat(64)}`,
      },
    ]);

    expect(summary).toEqual({ reaped: 3, idle: 3, hardReplaced: 0 });
    expect(actions).toEqual([
      'claim:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      'checkpoint:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA:checkpointing:idle',
      'terminate:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NA:idle:terminated',
      'claim:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
      'checkpoint:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC:checkpointing:idle',
      'terminate:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7NC:idle:terminated',
      'terminate:ws_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
      'transition:ws_01J8ME7YQZJ2V9Q0X3T5B6K7ND:idle:terminated',
    ]);
  });
});
