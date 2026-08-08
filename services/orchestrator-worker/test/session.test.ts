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
import { MemoryTranscriptStore } from '../src/session/transcript.js';

const roots: string[] = [];

afterEach(async () => {
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
        { type: 'usage', inputTokens: 40, outputTokens: 20, totalTokens: 60 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'Implemented and verified.' },
        { type: 'usage', inputTokens: 30, outputTokens: 10, totalTokens: 40 },
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
    });

    const result = await session.run(input());

    expect(result).toEqual({
      status: 'completed',
      commits: [],
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
    expect(saved?.tokensUsed).toBe(100);
    expect(saved?.completedToolCallIds).toEqual(['call-write']);
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
        { type: 'usage', totalTokens: 10 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'I cannot modify files in Ask mode.' },
        { type: 'usage', totalTokens: 10 },
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
        { type: 'usage', totalTokens: 12 },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', text: 'Migration completed.' },
        { type: 'usage', totalTokens: 8 },
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
        { type: 'usage', totalTokens: 10 },
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
        { type: 'usage', totalTokens: 10 },
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
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-over-token-budget',
          toolName: 'write_file',
          input: { path: 'over-budget.txt', content: 'must not be written' },
        },
        { type: 'usage', inputTokens: 8, outputTokens: 8, totalTokens: 1 },
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
    });

    const result = await session.run({
      ...input(),
      budgets: { maxTurns: 4, maxTokens: 10, maxWallClockMs: 30_000 },
    });

    expect(result.status).toBe('budget_exhausted');
    expect(scripted.requests).toHaveLength(1);
    await expect(readFile(join(root, 'over-budget.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

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

  it('does not replay a mutation with an ambiguous post-execution checkpoint', async () => {
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
      summary: '',
      terminalStatus: null,
    });
    const events: SessionEvent[] = [];
    const scripted = scriptedGateway([
      [
        { type: 'text-delta', text: 'Recovered without replay.' },
        { type: 'usage', totalTokens: 5 },
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
    });

    const result = await session.run(input());

    expect(result.status).toBe('completed');
    expect(await readFile(join(root, 'resume.txt'), 'utf8')).toBe('completed mutation result');
    expect(scripted.requests).toHaveLength(1);
    expect(scripted.requests[0]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [
        {
          output: {
            type: 'error-text',
            value: 'Tool outcome unknown; execution was not replayed.',
          },
        },
      ],
    });
    expect(events.map((event) => event.type)).toEqual(['tool.failed']);
    expect(events[0]?.payload).toMatchObject({ code: 'tool_outcome_unknown' });
  });
});
