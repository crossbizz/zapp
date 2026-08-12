import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId, TOOL_NAMES, type ExecutionContract } from '@zapp/contracts';
import type { CompleteRequest, GatewayStreamEvent } from '@zapp/model-gateway';
import { MemoryWorkspaceRuntime, type ExecResult } from '@zapp/workspace-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { RunBuilderSessionInputSchema } from '../src/activities/session.js';
import {
  createM1BuilderSessionRunner,
  createM1ToolRegistry,
  M1SandboxBoundaryError,
} from '../src/runtime/m1-session.js';
import {
  createM1UnavailablePorts,
  M1PortUnavailableError,
} from '../src/runtime/unavailable-ports.js';
import type { SessionEvent } from '../src/session/loop.js';
import { MemoryTranscriptStore } from '../src/session/transcript.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class RecordingRuntime extends MemoryWorkspaceRuntime {
  readonly started: ExecutionContract[] = [];
  readonly commands: { readonly cmd: string; readonly args: readonly string[] }[] = [];
  healthChecks = 0;

  override exec(input: {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    pty?: boolean;
  }): Promise<ExecResult> {
    this.commands.push({ cmd: input.cmd, args: input.args });
    return Promise.resolve({
      exitCode: 0,
      stdout: input.cmd === 'node' ? 'checked' : 'installed',
      stderr: '',
      durationMs: 1,
      truncated: false,
    });
  }

  override startDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }> {
    this.started.push(contract);
    return Promise.resolve({ port: contract.develop.port, pid: 42 });
  }

  override health(): Promise<{ ok: boolean; details: string }> {
    this.healthChecks += 1;
    return Promise.resolve({ ok: true, details: 'ready' });
  }
}

function scriptedGateway(turns: readonly (readonly GatewayStreamEvent[])[]) {
  const requests: CompleteRequest[] = [];
  return {
    requests,
    gateway: {
      async *stream(request: CompleteRequest): AsyncIterable<GatewayStreamEvent> {
        await Promise.resolve();
        requests.push(structuredClone(request));
        const turn = turns[requests.length - 1];
        if (turn === undefined) throw new Error('Unexpected model-gateway call');
        for (const event of turn) yield event;
      },
    },
  };
}

const usage = {
  type: 'usage' as const,
  provider: 'anthropic',
  model: 'claude-test',
  finishReason: 'stop',
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
};

describe('M1 builder session composition', () => {
  it('builds through registered tools, starts a healthy preview, and resumes for a follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-m1-session-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.js' }, dependencies: {} }),
    );
    const runtime = new RecordingRuntime(root);
    Object.defineProperty(runtime, 'kind', { value: 'cloud' });
    const scripted = scriptedGateway([
      [
        {
          type: 'tool-call',
          toolCallId: 'inspect-repository',
          toolName: 'list_files',
          input: { path: '.', maxDepth: 4 },
        },
        usage,
        { type: 'done' },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'write-page',
          toolName: 'write_file',
          input: { path: 'index.html', content: '<h1>Local M1 works</h1>' },
        },
        usage,
        { type: 'done' },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'install-package',
          toolName: 'install_dependency',
          input: { packageManager: 'pnpm', packages: ['vite'], dev: true },
        },
        usage,
        { type: 'done' },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'run-check',
          toolName: 'run_command',
          input: { cmd: 'node', args: ['-e', 'process.stdout.write("checked")'] },
        },
        usage,
        { type: 'done' },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'start-preview',
          toolName: 'run_dev_server',
          input: {},
        },
        usage,
        { type: 'done' },
      ],
      [{ type: 'text-delta', text: 'Built and previewed locally.' }, usage, { type: 'done' }],
      [
        {
          type: 'tool-call',
          toolCallId: 'write-follow-up',
          toolName: 'write_file',
          input: { path: 'index.html', content: '<h1>Welcome to local M1</h1>' },
        },
        usage,
        { type: 'done' },
      ],
      [{ type: 'text-delta', text: 'Applied the follow-up.' }, usage, { type: 'done' }],
    ]);
    const events: SessionEvent[] = [];
    const runner = createM1BuilderSessionRunner({
      gateway: scripted.gateway,
      runtime,
      events: { emit: (event) => void events.push(event) },
      approvals: { status: () => Promise.resolve('pending') },
      prompts: {
        builder: 'Use only the registered tools and finish with a concise summary.',
        planner: 'Plan.',
        verifier: 'Verify.',
        summarizer: 'Summarize.',
      },
      redactor: { redact: (value) => value },
      tokenCounter: { countRequestTokens: () => 20 },
    });
    const transcripts = new MemoryTranscriptStore();
    const runId = newId('run');
    const input = RunBuilderSessionInputSchema.parse({
      runId,
      organizationId: newId('org'),
      projectId: newId('proj'),
      workspaceId: newId('ws'),
      mode: 'build',
      model: null,
      prompt: 'Create a small landing page and start its preview.',
      allowedTools: [
        'list_files',
        'write_file',
        'install_dependency',
        'run_command',
        'run_dev_server',
      ],
      modeInstructions: 'Keep the application runnable and report the result.',
      budget: { maxCredits: 100 },
      idempotencyKey: 'm1-session-test',
    });
    const context = {
      resumeCheckpoint: undefined,
      transcripts,
      signal: new AbortController().signal,
      events: { emit: () => Promise.resolve() },
    };

    await expect(runner.run(input, context)).resolves.toMatchObject({
      status: 'completed',
      summary: 'Built and previewed locally.',
    });
    await expect(transcripts.load({ runId, taskId: 'm1-builder' })).resolves.toMatchObject({
      successfulToolNames: [
        'list_files',
        'write_file',
        'install_dependency',
        'run_command',
        'run_dev_server',
      ],
    });
    await expect(readFile(join(root, 'index.html'), 'utf8')).resolves.toBe(
      '<h1>Local M1 works</h1>',
    );
    expect(runtime.started).toHaveLength(1);
    expect(runtime.started[0]?.develop.port).toBe(3000);
    expect(runtime.healthChecks).toBe(1);
    expect(runtime.commands).toEqual([
      { cmd: 'pnpm', args: ['add', '--save-dev', '--', 'vite'] },
      { cmd: 'node', args: ['-e', 'process.stdout.write("checked")'] },
    ]);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(5);
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(5);
    expect(scripted.requests[0]?.messages[1]).toEqual({
      role: 'user',
      content: '[currentTask]\nCreate a small landing page and start its preview.',
    });

    await expect(
      runner.run(
        {
          ...input,
          control: {
            yieldAfterTool: false,
            redirect: null,
            message: {
              operationKey: `op_${'b'.repeat(64)}`,
              messageId: 'msg_01J00000000000000000000001',
              content: 'Make the heading friendlier.',
              attachments: [],
              source: 'web',
            },
          },
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      summary: 'Applied the follow-up.',
      messageApplied: true,
    });
    await expect(readFile(join(root, 'index.html'), 'utf8')).resolves.toBe(
      '<h1>Welcome to local M1</h1>',
    );
    await expect(transcripts.load({ runId, taskId: 'm1-builder' })).resolves.toMatchObject({
      successfulToolNames: [
        'list_files',
        'write_file',
        'install_dependency',
        'run_command',
        'run_dev_server',
      ],
    });
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(6);
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(6);
    expect(scripted.requests[6]?.messages).toContainEqual({
      role: 'user',
      content: 'Make the heading friendlier.',
    });
  });

  it('registers the exact contract tools and fails closed for out-of-scope ports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-m1-registry-'));
    roots.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node app.js' } }));
    const registry = createM1ToolRegistry(new RecordingRuntime(root), {
      redact: (value) => value,
    });

    expect(registry.names()).toEqual(TOOL_NAMES);
    const unavailable = createM1UnavailablePorts();
    await expect(unavailable.release.getReadiness('release-test')).rejects.toBeInstanceOf(
      M1PortUnavailableError,
    );
    expect(() =>
      createM1BuilderSessionRunner({
        gateway: scriptedGateway([]).gateway,
        runtime: new RecordingRuntime(root),
        events: { emit: () => undefined },
        approvals: { status: () => Promise.resolve('pending') },
        prompts: { builder: 'Build.', planner: 'Plan.', verifier: 'Verify.', summarizer: 'Summarize.' },
        redactor: { redact: (value) => value },
        tokenCounter: { countRequestTokens: () => 1 },
      }),
    ).toThrow(M1SandboxBoundaryError);
  });
});
