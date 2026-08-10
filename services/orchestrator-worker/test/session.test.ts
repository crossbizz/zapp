import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ToolRegistry,
  type BrowserEvidencePort,
  type DeploymentHealthPort,
  type EnvironmentPort,
  type MigrationPort,
  type PreviewToolPort,
  type ProjectDataPort,
  type ReleasePort,
  type ToolRegistryDependencies,
} from '@zapp/agent-tools';
import type { ToolName } from '@zapp/contracts';
import type { CompleteRequest, GatewayStreamEvent } from '@zapp/model-gateway';
import { MemoryWorkspaceRuntime } from '@zapp/workspace-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionLoop, type SessionEvent } from '../src/session/loop.js';
import {
  MemoryTranscriptStore,
  type SessionTranscript,
  type TranscriptStore,
} from '../src/session/transcript.js';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registryDependencies(
  runtime: MemoryWorkspaceRuntime,
  overrides: Partial<Omit<ToolRegistryDependencies, 'runtime'>> = {},
): ToolRegistryDependencies {
  const projectData: ProjectDataPort = {
    readLogs: () => Promise.resolve({ ok: true, entries: [], truncated: false }),
    readTestResults: () =>
      Promise.resolve({ status: 'passed', summary: 'passed', artifactId: 'artifact-tests' }),
    readDatabaseSchema: () =>
      Promise.resolve({ ok: true, dialect: 'postgresql', schema: 'public' }),
    readLatestProjectContract: () =>
      Promise.resolve({
        ok: true,
        version: 1,
        contract: {
          version: 1,
          package_manager: 'pnpm',
          workspace_root: '.',
          install: { command: 'pnpm install' },
          develop: { command: 'pnpm dev', port: 3000 },
          build: { command: 'pnpm build' },
          typecheck: { command: 'pnpm typecheck' },
          lint: { command: 'pnpm lint' },
          test: {
            unit: 'pnpm test',
            browser: 'pnpm test:browser',
            integration: 'pnpm test:integration',
          },
        },
      }),
  };
  const migrations: MigrationPort = {
    executeMigration: () => Promise.resolve({ migrationId: 'migration-test', status: 'applied' }),
  };
  const environment: EnvironmentPort = {
    setEnvironmentVariable: () =>
      Promise.resolve({ updated: true, name: 'CONFIG_VALUE', scope: 'preview' }),
  };
  const browser: BrowserEvidencePort = {
    runBrowserTests: () => Promise.resolve({ passed: true, summary: 'passed' }),
    captureScreenshot: () =>
      Promise.resolve({ artifactId: 'artifact-screenshot', path: 'artifacts/home.png' }),
    inspectConsole: () => Promise.resolve({ entries: [] }),
    inspectNetwork: () => Promise.resolve({ requests: [] }),
  };
  const release: ReleasePort = {
    createReleaseCandidate: () => Promise.resolve({ id: 'release-test', status: 'candidate' }),
    getReadiness: () => Promise.resolve({ state: 'ready', findings: [] }),
    approve: () => Promise.resolve({ id: 'release-test', status: 'approved' }),
    deploy: () => Promise.resolve({ deploymentId: 'deployment-test' }),
    rollback: () => Promise.resolve({ deploymentId: 'deployment-rollback' }),
    getEvidence: () => Promise.resolve({ releaseId: 'release-test', artifacts: [] }),
  };
  const preview: PreviewToolPort = {
    createPreview: () =>
      Promise.resolve({ previewId: 'preview-test', url: 'https://preview.example.test' }),
    runPreviewSmokeTest: () => Promise.resolve({ passed: true, summary: 'healthy' }),
  };
  const deploymentHealth: DeploymentHealthPort = {
    checkDeploymentHealth: () => Promise.resolve({ healthy: true, details: 'healthy' }),
  };

  return {
    runtime,
    redactor: { redact: (value) => value.replaceAll('registered-secret', '[REDACTED]') },
    projectData,
    migrations,
    environment,
    browser,
    release,
    preview,
    deploymentHealth,
    ...overrides,
  };
}

async function memoryRegistry(
  overrides: Partial<Omit<ToolRegistryDependencies, 'runtime'>> = {},
): Promise<{ registry: ToolRegistry; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-session-'));
  roots.push(root);
  const runtime = new MemoryWorkspaceRuntime(root);
  return { registry: new ToolRegistry(registryDependencies(runtime, overrides)), root };
}

function context() {
  return {
    role: 'builder' as const,
    scope: { organizationId: 'org-test', projectId: 'project-test', runId: 'run-test' },
    taskId: 'task-test',
    tokenBudget: 2_000,
    tokenCount: 8,
    sections: [
      {
        kind: 'currentTask' as const,
        content: 'Write the requested file.',
        tokenCount: 8,
        sourceArtifactIds: ['artifact-plan'],
        sourceEventIds: [],
      },
    ],
  };
}

function input(tools: ToolName[] = ['write_file']) {
  return {
    runId: 'run-test',
    taskId: 'task-test',
    role: 'builder' as const,
    mode: 'build' as const,
    context: context(),
    tools,
    budgets: { maxTurns: 4, maxTokens: 1_000, maxWallClockMs: 30_000 },
  };
}

const countRequestTokens = (): number => 1;
const USAGE_ATTRIBUTION = {
  provider: 'anthropic',
  model: 'claude-test',
  finishReason: 'stop',
} as const;

function scriptedGateway(turns: readonly (readonly GatewayStreamEvent[])[]) {
  const requests: CompleteRequest[] = [];
  return {
    requests,
    gateway: {
      async *stream(request: CompleteRequest): AsyncIterable<GatewayStreamEvent> {
        await Promise.resolve();
        requests.push(request);
        const turn = turns[requests.length - 1];
        if (turn === undefined) throw new Error('Unexpected gateway call');
        for (const event of turn) yield event;
      },
    },
  };
}

describe('agent session loop', () => {
  it('places run-mode guardrails in the model system message', async () => {
    const { registry } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const scripted = scriptedGateway([
      [
        { type: 'text-delta', text: 'Answer with citations.' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 2 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder prompt',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    await session.run({
      ...input(),
      mode: 'ask',
      modeInstructions: 'Use only read tools and cite every code claim.',
    });

    expect(scripted.requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'builder prompt\n\nUse only read tools and cite every code claim.',
    });
  });

  it('durably returns strict Prototype mocks without counting a failed smoke result', async () => {
    const preview: PreviewToolPort = {
      createPreview: () =>
        Promise.resolve({ previewId: 'preview-test', url: 'https://preview.example.test' }),
      runPreviewSmokeTest: () => Promise.resolve({ passed: false, summary: 'route failed' }),
    };
    const { registry } = await memoryRegistry({ preview });
    const transcripts = new MemoryTranscriptStore();
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-smoke',
          toolName: 'run_preview_smoke_test',
          input: { previewId: 'preview-test' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 2 },
        { type: 'done' },
      ],
      [
        {
          type: 'text-delta',
          text: JSON.stringify({
            summary: 'Prototype needs a healthy preview.',
            mocks: [{ name: 'payment-provider', reason: 'Provider setup is pending.' }],
          }),
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 2 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('approved') },
      prompts: {
        builder: 'builder prompt',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run({
      ...input(['run_preview_smoke_test']),
      mode: 'prototype',
      modeInstructions: 'Return strict Prototype completion JSON.',
    });

    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Prototype needs a healthy preview.',
      mocks: [{ name: 'payment-provider', reason: 'Provider setup is pending.' }],
      completedTools: [],
    });
    const stored = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(stored).toMatchObject({
      prototypeMocks: [{ name: 'payment-provider', reason: 'Provider setup is pending.' }],
      successfulToolNames: [],
    });
  });


  it('keeps a foreign completion lease retryable with the durable request intact', async () => {
    const { registry } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const session = createSessionLoop({
      gateway: {
        async *stream(): AsyncIterable<GatewayStreamEvent> {
          await Promise.resolve();
          yield {
            type: 'error',
            code: 'completion_leased',
            message: 'The completion is owned by another live gateway.',
          };
        },
      },
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder prompt',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    await expect(session.run(input())).rejects.toMatchObject({
      name: 'SessionCompletionRetryableError',
    });
    const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(saved?.terminalStatus).toBeNull();
    expect(saved?.inFlightCompletion).not.toBeNull();
  });

  it('durably emits usage.recorded before mapping an accounting cutoff to budget_exhausted', async () => {
    const { registry } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const events: SessionEvent[] = [];
    const session = createSessionLoop({
      gateway: {
        async *stream(request): AsyncIterable<GatewayStreamEvent> {
          await Promise.resolve();
          yield {
            type: 'usage.recorded',
            completionId: request.completionId,
            usage: [
              {
                provider: 'anthropic',
                model: 'claude-sonnet-5',
                inputTokens: 1,
                outputTokens: 1,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 0,
                occurredAt: '2026-08-09T16:00:00.000Z',
              },
            ],
            credits: { used: '8.0000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
          };
          yield {
            type: 'error',
            code: 'budget_exceeded',
            message: 'The run credit budget is exhausted.',
          };
        },
      },
      tools: registry,
      transcripts,
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder prompt',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run(input());

    expect(result.status).toBe('budget_exhausted');
    expect(events).toHaveLength(1);
    const emitted = events[0];
    expect(emitted?.type).toBe('usage.recorded');
    expect(emitted?.payload['completionId']).toMatch(/^cmp_/u);
    const recordedUsage = emitted?.payload['usage'];
    expect(Array.isArray(recordedUsage)).toBe(true);
    if (!Array.isArray(recordedUsage)) throw new Error('Expected recorded usage array');
    expect(recordedUsage[0]).toMatchObject({ provider: 'anthropic', inputTokens: 1 });
    expect(emitted?.payload['budget']).toEqual({ level: 'warning', utilizationBps: 8_000 });
    const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(saved?.eventOutbox).toHaveLength(1);
    expect(saved?.eventOutbox[0]?.delivered).toBe(true);
    expect(saved?.eventOutbox[0]?.event.type).toBe('usage.recorded');
    expect(saved?.terminalErrorCode).toBe('budget_exceeded');
  });

  it('persists a real write result and completes on the second model turn', async () => {
    const { registry, root } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const events: SessionEvent[] = [];
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-write',
          toolName: 'write_file',
          input: { path: 'result.txt', content: 'registered-secret removed' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, inputTokens: 40, outputTokens: 20, totalTokens: 60 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'Implemented and verified.' },
        { type: 'usage', ...USAGE_ATTRIBUTION, inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder prompt',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value.replaceAll('registered-secret', '[REDACTED]'),
      countRequestTokens,
      results: {
        collect: () => ({
          commits: ['0123456789abcdef0123456789abcdef01234567'],
          artifacts: [],
        }),
      },
    });

    const result = await session.run(input());

    expect(result).toEqual({
      status: 'completed',
      commits: ['0123456789abcdef0123456789abcdef01234567'],
      artifacts: [],
      summary: 'Implemented and verified.',
    });
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('registered-secret removed');
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool' });
    const modelVisibleResult = JSON.stringify(scripted.requests[1]?.messages.at(-1));
    expect(modelVisibleResult).not.toContain('registered-secret');
    expect(modelVisibleResult).toContain('zapp-untrusted-content');
    expect(events.map((event) => event.type)).toEqual([
      'tool.started',
      'tool.output',
      'tool.completed',
    ]);
    const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(saved?.turns).toBe(2);
    expect(saved?.tokensUsed).toBe(500);
    expect(saved?.completedToolCallIds).toEqual(['call-write']);
  });

  it('yields after a real tool and durably applies one redirect at the next model turn', async () => {
    const { registry, root } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-controlled-write',
          toolName: 'write_file',
          input: { path: 'controlled.txt', content: 'first tool finished' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'Redirect applied before this turn.' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder prompt',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });
    const redirect = {
      operationKey: `op_${'b'.repeat(64)}`,
      instruction: 'Keep the existing API and use the repository adapter.',
    };

    await expect(
      session.run({
        ...input(),
        control: { yieldAfterTool: true, redirect: null },
      }),
    ).resolves.toMatchObject({ status: 'yielded' });
    expect(await readFile(join(root, 'controlled.txt'), 'utf8')).toBe('first tool finished');
    expect(scripted.requests).toHaveLength(1);

    await expect(
      session.run({
        ...input(),
        control: { yieldAfterTool: true, redirect },
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      summary: 'Redirect applied before this turn.',
      redirectApplied: true,
    });
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]?.messages).toContainEqual({
      role: 'user',
      content: redirect.instruction,
    });

    await expect(
      session.run({
        ...input(),
        control: { yieldAfterTool: true, redirect },
      }),
    ).resolves.toMatchObject({ status: 'completed', redirectApplied: true });
    expect(scripted.requests).toHaveLength(2);
    const stored = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(stored?.appliedRedirectOperationKeys).toEqual([redirect.operationKey]);
    expect(
      stored?.messages.filter(
        (message) => message.role === 'user' && message.content === redirect.instruction,
      ),
    ).toHaveLength(1);
  });

  it('surfaces a code-side policy denial to the model without executing the mutation', async () => {
    const { registry, root } = await memoryRegistry();
    const events: SessionEvent[] = [];
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-denied',
          toolName: 'write_file',
          input: { path: 'denied.txt', content: 'must not be written' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'I cannot modify files in Ask mode.' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts: new MemoryTranscriptStore(),
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run({ ...input(), mode: 'ask' });

    expect(result.status).toBe('completed');
    await expect(readFile(join(root, 'denied.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(events.map((event) => event.type)).toEqual(['tool.started', 'tool.failed']);
    expect(events[1]?.payload).toMatchObject({ code: 'ask_mode_mutation' });
    expect(scripted.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [
        {
          output: { type: 'execution-denied', reason: 'ask_mode_mutation' },
        },
      ],
    });
  });

  it('pauses for approval and resumes the mutation exactly once', async () => {
    let migrationCalls = 0;
    const migrations: MigrationPort = {
      executeMigration: () => {
        migrationCalls += 1;
        return Promise.resolve({ migrationId: 'migration-resume', status: 'applied' });
      },
    };
    const { registry } = await memoryRegistry({ migrations });
    const transcripts = new MemoryTranscriptStore();
    const events: SessionEvent[] = [];
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-migration',
          toolName: 'execute_migration',
          input: { environmentId: 'environment-test', migration: 'CREATE TABLE sample (id text)' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 12 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'Migration completed.' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 8 },
        { type: 'done' },
      ],
    ]);
    let approval: 'pending' | 'approved' = 'pending';
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve(approval) },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });
    const sessionInput = input(['execute_migration']);

    const paused = await session.run(sessionInput);
    expect(paused).toMatchObject({
      status: 'needs_approval',
      pendingApproval: {
        toolCallId: 'call-migration',
        tool: 'execute_migration',
        reason: 'production_migration',
      },
    });
    expect(migrationCalls).toBe(0);

    approval = 'approved';
    const resumed = await session.run(sessionInput);
    expect(resumed).toEqual({
      status: 'completed',
      commits: [],
      artifacts: [],
      summary: 'Migration completed.',
    });
    expect(migrationCalls).toBe(1);
    expect(scripted.requests).toHaveLength(2);

    const replayed = await session.run(sessionInput);
    expect(replayed).toEqual(resumed);
    expect(migrationCalls).toBe(1);
    expect(scripted.requests).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([
      'approval.requested',
      'approval.resolved',
      'tool.started',
      'tool.output',
      'tool.completed',
    ]);
  });

  it('enforces maxTurns before another gateway call', async () => {
    const { registry, root } = await memoryRegistry();
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-one-turn',
          toolName: 'write_file',
          input: { path: 'one-turn.txt', content: 'written once' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts: new MemoryTranscriptStore(),
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run({
      ...input(),
      budgets: { maxTurns: 1, maxTokens: 1_000, maxWallClockMs: 30_000 },
    });

    expect(result.status).toBe('budget_exhausted');
    expect(scripted.requests).toHaveLength(1);
    expect(await readFile(join(root, 'one-turn.txt'), 'utf8')).toBe('written once');
  });

  it('cancels an in-flight tool and makes no further gateway calls', async () => {
    let signalToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const environment: EnvironmentPort = {
      setEnvironmentVariable: (_input, _context, signal) =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            const reason = signal.reason as unknown;
            reject(reason instanceof Error ? reason : new Error('Tool execution cancelled'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          signalToolStarted?.();
          if (signal.aborted) onAbort();
        }),
    };
    const { registry } = await memoryRegistry({ environment });
    const events: SessionEvent[] = [];
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-cancel',
          toolName: 'set_environment_variable',
          input: {
            environmentId: 'environment-test',
            name: 'CONFIG_VALUE',
            secretRef: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
            scope: 'preview',
          },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts: new MemoryTranscriptStore(),
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });
    const cancellation = new AbortController();

    const running = session.run(input(['set_environment_variable']), cancellation.signal);
    await toolStarted;
    cancellation.abort(new Error('cancel test'));
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(scripted.requests).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(['tool.started', 'tool.failed']);
    expect(events[1]?.payload).toMatchObject({ code: 'tool_cancelled' });
  });

  it('treats the token budget as a hard pre-execution limit', async () => {
    const { registry, root } = await memoryRegistry();
    const requests: CompleteRequest[] = [];
    const events: SessionEvent[] = [];
    const gateway = {
      async *stream(request: CompleteRequest): AsyncIterable<GatewayStreamEvent> {
        await Promise.resolve();
        requests.push(request);
        yield {
          type: 'tool-call',
          toolCallId: 'call-over-token-budget',
          toolName: 'write_file',
          input: { path: 'over-budget.txt', content: 'must not be written' },
        };
        yield { type: 'usage', ...USAGE_ATTRIBUTION, inputTokens: 8, outputTokens: 8, totalTokens: 1 };
        yield {
          type: 'usage.recorded',
          completionId: request.completionId,
          usage: [
            {
              provider: 'anthropic',
              model: 'claude-sonnet-5',
              inputTokens: 8,
              outputTokens: 8,
              cacheReadInputTokens: 0,
              cacheWriteInputTokens: 0,
              occurredAt: '2026-08-09T16:00:00.000Z',
            },
          ],
          credits: { used: '1.0000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
        };
        yield { type: 'done' };
      },
    };
    const session = createSessionLoop({
      gateway,
      tools: registry,
      transcripts: new MemoryTranscriptStore(),
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run({
      ...input(),
      budgets: { maxTurns: 4, maxTokens: 10, maxWallClockMs: 30_000 },
    });

    expect(result.status).toBe('budget_exhausted');
    expect(requests).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(['usage.recorded']);
    await expect(readFile(join(root, 'over-budget.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves a retryable accounting completion after raw usage crosses the token cutoff', async () => {
    const { registry } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const session = createSessionLoop({
      gateway: {
        async *stream(): AsyncIterable<GatewayStreamEvent> {
          await Promise.resolve();
          yield {
            type: 'usage',
            ...USAGE_ATTRIBUTION,
            inputTokens: 8,
            outputTokens: 8,
            totalTokens: 16,
          };
          yield {
            type: 'error',
            code: 'completion_retryable',
            message: 'The completion accounting result must be retried.',
          };
        },
      },
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    await expect(
      session.run({
        ...input(),
        budgets: { maxTurns: 4, maxTokens: 10, maxWallClockMs: 30_000 },
      }),
    ).rejects.toMatchObject({ name: 'SessionCompletionRetryableError' });
    const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(saved?.terminalStatus).toBeNull();
    expect(saved?.inFlightCompletion).not.toBeNull();
  });

  it.each([
    { label: 'absent', usage: [] },
    {
      label: 'understated',
      usage: [{ type: 'usage' as const, ...USAGE_ATTRIBUTION, outputTokens: 1 }],
    },
  ])(
    'does not let $label provider output usage release a reserved allowance to the next turn',
    async ({ usage }) => {
      const { registry } = await memoryRegistry();
      const transcripts = new MemoryTranscriptStore();
      const scripted = scriptedGateway([
        [
          {
            type: 'tool-call',
            toolCallId: `call-${usage.length === 0 ? 'absent' : 'understated'}-usage`,
            toolName: 'read_logs',
            input: { cursor: null, limit: 10 },
          },
          ...usage,
          { type: 'done' },
        ],
        [{ type: 'text-delta', text: 'Finished within the reserved budget.' }, { type: 'done' }],
      ]);
      const session = createSessionLoop({
        gateway: scripted.gateway,
        tools: registry,
        transcripts,
        events: { emit: () => undefined },
        approvals: { status: () => Promise.resolve('pending') },
        prompts: {
          builder: 'builder',
          planner: 'planner',
          verifier: 'verifier',
          summarizer: 'summary',
        },
        redact: (value) => value,
        countRequestTokens,
      });

      const result = await session.run({
        ...input(['read_logs']),
        budgets: { maxTurns: 2, maxTokens: 12, maxWallClockMs: 30_000 },
      });

      expect(result.status).toBe('completed');
      expect(scripted.requests.map((request) => request.maxOutputTokens)).toEqual([5, 5]);
      expect(scripted.requests).toHaveLength(2);
      const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
      expect(saved?.tokensUsed).toBe(12);
    },
  );

  it('aborts a blocked gateway when the wall-clock budget expires', async () => {
    vi.useFakeTimers();
    try {
      const { registry } = await memoryRegistry();
      let releaseStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        releaseStarted = resolve;
      });
      let gatewayCalls = 0;
      const session = createSessionLoop({
        gateway: {
          async *stream(_request, signal): AsyncIterable<GatewayStreamEvent> {
            gatewayCalls += 1;
            releaseStarted?.();
            await new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve();
                },
                { once: true },
              );
              if (signal.aborted) resolve();
            });
          },
        },
        tools: registry,
        transcripts: new MemoryTranscriptStore(),
        events: { emit: () => undefined },
        approvals: { status: () => Promise.resolve('pending') },
        prompts: {
          builder: 'builder',
          planner: 'planner',
          verifier: 'verifier',
          summarizer: 'summary',
        },
        redact: (value) => value,
        countRequestTokens,
      });

      const running = session.run({
        ...input(),
        budgets: { maxTurns: 4, maxTokens: 1_000, maxWallClockMs: 1_000 },
      });
      await started;
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await running;

      expect(result.status).toBe('budget_exhausted');
      expect(gatewayCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed without replaying a mutation with an ambiguous post-execution checkpoint', async () => {
    const { registry, root } = await memoryRegistry();
    await writeFile(join(root, 'resume.txt'), 'completed mutation result');
    const transcripts = new MemoryTranscriptStore();
    await transcripts.save(null, {
      key: { runId: 'run-test', taskId: 'task-test' },
      role: 'builder',
      mode: 'build',
      tools: ['write_file'],
      budgets: { maxTurns: 4, maxTokens: 1_000, maxWallClockMs: 30_000 },
      startedAtMs: Date.now(),
      provenance: [],
      messages: [
        { role: 'system', content: 'builder' },
        { role: 'user', content: 'continue' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-ambiguous',
              toolName: 'write_file',
              input: { path: 'resume.txt', content: 'mutation replayed' },
            },
          ],
        },
      ],
      turns: 1,
      tokensUsed: 10,
      completedToolCallIds: [],
      pendingToolCalls: [
        {
          toolCallId: 'call-ambiguous',
          toolName: 'write_file',
          input: { path: 'resume.txt', content: 'mutation replayed' },
        },
      ],
      activeToolCallId: 'call-ambiguous',
      executionLease: {
        toolCallId: 'call-ambiguous',
        ownerId: 'lost-worker',
        fence: 1,
        expiresAtMs: Date.now() - 1,
      },
      nextFence: 2,
      eventOutbox: [],
      commits: [],
      artifacts: [],
      summary: '',
      terminalStatus: null,
      terminalErrorCode: null,
    });
    const events: SessionEvent[] = [];
    const scripted = scriptedGateway([
      [
        { type: 'text-delta', text: 'Recovered without replay.' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 5 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run(input());

    expect(result.status).toBe('failed');
    expect(await readFile(join(root, 'resume.txt'), 'utf8')).toBe('completed mutation result');
    expect(scripted.requests).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['tool.failed']);
    expect(events[0]?.payload).toMatchObject({ code: 'tool_outcome_unknown' });
  });

  it('durably fails malformed approval responses without executing', async () => {
    let migrationCalls = 0;
    const migrations: MigrationPort = {
      executeMigration: () => {
        migrationCalls += 1;
        return Promise.resolve({ migrationId: 'migration-invalid-approval', status: 'applied' });
      },
    };
    const { registry } = await memoryRegistry({ migrations });
    const transcripts = new MemoryTranscriptStore();
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-invalid-approval',
          toolName: 'execute_migration',
          input: { environmentId: 'environment-test', migration: 'DROP TABLE users' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve({ approved: true } as never) },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run(input(['execute_migration']));

    expect(result.status).toBe('failed');
    expect(migrationCalls).toBe(0);
    const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(saved?.terminalStatus).toBe('failed');
  });

  it('redacts model text, tool-input values, and tool-input keys before persistence', async () => {
    const { registry } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const scripted = scriptedGateway([
      [
        { type: 'text-delta', text: 'registered-secret summary' },
        {
          type: 'tool-call',
          toolCallId: 'call-secret-input',
          toolName: 'write_file',
          input: {
            path: 'secret.txt',
            content: 'registered-secret value',
            'registered-secret-key': 'registered-secret nested',
          },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'registered-secret final' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value.replaceAll('registered-secret', '[REDACTED]'),
      countRequestTokens,
    });

    const result = await session.run({ ...input(), mode: 'ask' });

    expect(result.summary).toBe('[REDACTED] final');
    const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(JSON.stringify(saved)).not.toContain('registered-secret');
    expect(JSON.stringify(saved)).toContain('[REDACTED]-key');
  });

  it('uses a fenced execution lease before declaring an active mutation abandoned', async () => {
    vi.useFakeTimers();
    let releaseTool: (() => void) | undefined;
    let markToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let environmentCalls = 0;
    const environment: EnvironmentPort = {
      setEnvironmentVariable: () =>
        new Promise((resolve) => {
          environmentCalls += 1;
          markToolStarted?.();
          releaseTool = () => {
            resolve({ updated: true, name: 'CONFIG_VALUE', scope: 'preview' });
          };
        }),
    };
    const { registry } = await memoryRegistry({ environment });
    const transcripts = new MemoryTranscriptStore();
    let clock = 1_000;
    const gateway = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-leased',
          toolName: 'set_environment_variable',
          input: {
            environmentId: 'environment-test',
            name: 'CONFIG_VALUE',
            secretRef: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
            scope: 'preview',
          },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'leased mutation complete' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]).gateway;
    const common = {
      gateway,
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending' as const) },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value: string) => value,
      countRequestTokens,
      now: () => clock,
      executionLeaseMs: 100,
    };
    const first = createSessionLoop({ ...common, workerId: 'worker-one' });
    const second = createSessionLoop({ ...common, workerId: 'worker-two' });
    const running = first.run(input(['set_environment_variable']));
    await toolStarted;

    const beforeExpiry = await second.run(input(['set_environment_variable'])).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    clock = 1_101;
    await vi.advanceTimersByTimeAsync(34);
    const afterNominalExpiry = await second.run(input(['set_environment_variable'])).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    releaseTool?.();
    const completed = await running;

    expect(beforeExpiry).toMatchObject({ error: { name: 'SessionLeaseBusyError' } });
    expect(afterNominalExpiry).toMatchObject({ error: { name: 'SessionLeaseBusyError' } });
    expect(environmentCalls).toBe(1);
    expect(completed.status).toBe('completed');
  });

  it('replays a durable event outbox after post-mutation delivery failure', async () => {
    const { registry, root } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-outbox',
          toolName: 'write_file',
          input: { path: 'outbox.txt', content: 'written once' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'outbox recovered' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const delivered: SessionEvent[] = [];
    let failOutput = true;
    const dependencies = {
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: {
        emit: (event: SessionEvent) => {
          if (event.type === 'tool.output' && failOutput) {
            failOutput = false;
            throw new Error('event delivery unavailable');
          }
          delivered.push(event);
        },
      },
      approvals: { status: () => Promise.resolve('pending' as const) },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value: string) => value,
      countRequestTokens,
    };
    const session = createSessionLoop(dependencies);

    await expect(session.run(input())).rejects.toThrow('event delivery unavailable');
    expect(await readFile(join(root, 'outbox.txt'), 'utf8')).toBe('written once');
    const resumed = await createSessionLoop(dependencies).run(input());
    expect(resumed.status).toBe('completed');
    expect(delivered.map((event) => event.type)).toEqual([
      'tool.started',
      'tool.output',
      'tool.completed',
    ]);
    expect(new Set(delivered.map((event) => event.eventKey)).size).toBe(delivered.length);
    expect(scripted.requests).toHaveLength(2);
  });

  it('durably returns structured commit and artifact references on terminal replay', async () => {
    const { registry } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-results',
          toolName: 'write_file',
          input: { path: 'results.txt', content: 'results' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'results complete' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const dependencies = {
      gateway: scripted.gateway,
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending' as const) },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value: string) => value,
      countRequestTokens,
      results: {
        collect: () => ({
          commits: ['0123456789abcdef0123456789abcdef01234567'],
          artifacts: ['artifact-session-result'],
        }),
      },
    };
    const completed = await createSessionLoop(dependencies).run(input());
    const replayed = await createSessionLoop(dependencies).run(input());

    expect(completed.commits).toEqual(['0123456789abcdef0123456789abcdef01234567']);
    expect(completed.artifacts).toEqual(['artifact-session-result']);
    expect(replayed).toEqual(completed);
  });

  it('aggregates an artifact reference from a typed registry result', async () => {
    const { registry } = await memoryRegistry();
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-test-results',
          toolName: 'read_test_results',
          input: { suite: 'unit' },
        },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'screenshot complete' },
        { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 10 },
        { type: 'done' },
      ],
    ]);
    const session = createSessionLoop({
      gateway: scripted.gateway,
      tools: registry,
      transcripts: new MemoryTranscriptStore(),
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });

    const result = await session.run(input(['read_test_results']));

    expect(result.artifacts).toEqual(['artifact-tests']);
  });

  it('reserves exact request input tokens before opening the gateway', async () => {
    const { registry } = await memoryRegistry();
    let gatewayCalls = 0;
    const session = createSessionLoop({
      gateway: {
        async *stream(): AsyncIterable<GatewayStreamEvent> {
          await Promise.resolve();
          gatewayCalls += 1;
          yield { type: 'done' };
        },
      },
      tools: registry,
      transcripts: new MemoryTranscriptStore(),
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens: () => 20,
    });

    const result = await session.run({
      ...input(),
      budgets: { maxTurns: 4, maxTokens: 20, maxWallClockMs: 30_000 },
    });

    expect(result.status).toBe('budget_exhausted');
    expect(gatewayCalls).toBe(0);
  });

  it('replays one durably reserved completion request after interruption and advances identity only after commit', async () => {
    const { registry } = await memoryRegistry();
    const durable = new MemoryTranscriptStore();
    let interrupted = false;
    const store: TranscriptStore = {
      load: (key) => durable.load(key),
      async save(expectedVersion, value) {
        const saved = await durable.save(expectedVersion, value);
        const inFlightCompletion = saved.inFlightCompletion;
        if (!interrupted && inFlightCompletion !== null) {
          interrupted = true;
          throw new Error('simulated worker loss after durable reservation');
        }
        return saved;
      },
    };
    let tokenCounts = 0;
    let gatewayCalls = 0;
    const requests: CompleteRequest[] = [];
    const reservedSnapshots: number[] = [];
    const session = createSessionLoop({
      gateway: {
        async *stream(request): AsyncIterable<GatewayStreamEvent> {
          gatewayCalls += 1;
          requests.push(structuredClone(request));
          const current = await durable.load({ runId: 'run-test', taskId: 'task-test' });
          reservedSnapshots.push(current?.tokensUsed ?? -1);
          if (gatewayCalls === 1) {
            yield {
              type: 'tool-call',
              toolCallId: 'call-write-replayed',
              toolName: 'write_file',
              input: { path: 'replayed.txt', content: 'durable' },
            };
            yield { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 8 };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text-delta', text: 'Committed after replay.' };
          yield { type: 'usage', ...USAGE_ATTRIBUTION, totalTokens: 6 };
          yield { type: 'done' };
        },
      },
      tools: registry,
      transcripts: store,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens: () => {
        tokenCounts += 1;
        return 5;
      },
    });

    await expect(session.run(input())).rejects.toThrow(
      'simulated worker loss after durable reservation',
    );
    expect(gatewayCalls).toBe(0);
    const checkpoint = (await durable.load({
      runId: 'run-test',
      taskId: 'task-test',
    })) as SessionTranscript;
    expect(checkpoint.inFlightCompletion).not.toBeNull();
    const firstCompletion = structuredClone(checkpoint.inFlightCompletion);

    const result = await session.run(input());

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(firstCompletion?.request);
    expect(requests[0]?.completionId).toBe(firstCompletion?.completionId);
    expect(requests[0]?.maxOutputTokens).toBe(firstCompletion?.request.maxOutputTokens);
    expect(firstCompletion?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests[1]?.completionId).not.toBe(requests[0]?.completionId);
    expect(tokenCounts).toBe(2);
    expect(reservedSnapshots[0]).toBe(checkpoint.tokensUsed);
    expect((await durable.load(checkpoint.key))?.inFlightCompletion).toBeNull();
  });

  it('acknowledges cancellation and closes a gateway iterator whose next never settles', async () => {
    const { registry } = await memoryRegistry();
    let releaseNext: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let returnCalls = 0;
    const iterator = {
      next: () =>
        new Promise<IteratorResult<GatewayStreamEvent>>((resolve) => {
          markStarted?.();
          releaseNext = () => {
            resolve({ done: true, value: undefined });
          };
        }),
      return: () => {
        returnCalls += 1;
        return Promise.resolve({ done: true, value: undefined as never });
      },
    };
    const session = createSessionLoop({
      gateway: { stream: () => ({ [Symbol.asyncIterator]: () => iterator }) },
      tools: registry,
      transcripts: new MemoryTranscriptStore(),
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value,
      countRequestTokens,
    });
    const cancellation = new AbortController();
    const running = session.run(input(), cancellation.signal);
    await started;
    cancellation.abort(new Error('cancel blocked iterator'));
    const acknowledgement = await Promise.race([
      running.then((result) => result.status),
      new Promise<'blocked'>((resolve) =>
        setImmediate(() => {
          resolve('blocked');
        }),
      ),
    ]);

    expect(acknowledgement).toBe('cancelled');
    expect(returnCalls).toBe(1);
    releaseNext?.();
    await running;
  });

  it.each([
    {
      label: 'iterator failure',
      stream: async function* (): AsyncIterable<GatewayStreamEvent> {
        await Promise.resolve();
        throw new Error('registered-secret provider');
      },
      summary: '[REDACTED] provider',
    },
    {
      label: 'malformed event',
      stream: async function* (): AsyncIterable<GatewayStreamEvent> {
        await Promise.resolve();
        yield {
          type: 'text-delta',
          text: 'safe',
          'registered-secret-key': 'registered-secret-value',
        } as never;
      },
      summary: undefined,
    },
  ])('persists sanitized gateway failure: $label', async (testCase) => {
    const { registry } = await memoryRegistry();
    const transcripts = new MemoryTranscriptStore();
    const session = createSessionLoop({
      gateway: { stream: () => testCase.stream() },
      tools: registry,
      transcripts,
      events: { emit: () => undefined },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'builder',
        planner: 'planner',
        verifier: 'verifier',
        summarizer: 'summary',
      },
      redact: (value) => value.replaceAll('registered-secret', '[REDACTED]'),
      countRequestTokens,
    });

    const result = await session.run(input());

    expect(result.status).toBe('failed');
    if (testCase.summary !== undefined) expect(result.summary).toBe(testCase.summary);
    const saved = await transcripts.load({ runId: 'run-test', taskId: 'task-test' });
    expect(saved?.terminalStatus).toBe('failed');
    expect(JSON.stringify(saved)).not.toContain('registered-secret');
  });
});
