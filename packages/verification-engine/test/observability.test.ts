import type { ExecutionContract } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import {
  createObservabilityCheckGate,
  createRedactingArtifactSink,
  type GateContext,
} from '../src/index.js';

const CONTRACT = {
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install', timeout_seconds: 60 },
  develop: { command: 'pnpm dev', port: 3000 },
} satisfies ExecutionContract;

function runtime(exec: WorkspaceRuntime['exec']): WorkspaceRuntime {
  const unavailable = (): Promise<never> => Promise.reject(new Error('unused_runtime_method'));
  return {
    kind: 'cloud',
    exec,
    execStream: () => ({
      [Symbol.asyncIterator]: async function* () {
        await Promise.resolve();
      },
    }),
    readFile: unavailable,
    readFileForUpdate: unavailable,
    writeFile: unavailable,
    writeFilesAtomically: unavailable,
    search: unavailable,
    listFiles: unavailable,
    stat: unavailable,
    delete: unavailable,
    deleteFile: unavailable,
    renameFile: unavailable,
    git: unavailable,
    startDevServer: unavailable,
    restartDevServer: unavailable,
    health: unavailable,
  };
}

function context(exec: WorkspaceRuntime['exec']): GateContext {
  return {
    runtime: runtime(exec),
    contract: CONTRACT,
    routes: [],
    baseCommit: '1'.repeat(40),
    commit: '2'.repeat(40),
    criteria: [],
    fullSecretScan: false,
    artifacts: createRedactingArtifactSink(
      { store: () => Promise.resolve('art_observability') },
      { redact: (value) => value },
    ),
  };
}

describe('OPS-10 Managed observability gate', () => {
  test('passes only when the structural checker reports every generated capability', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({ missing: [], checked: 9 }),
      stderr: '',
      durationMs: 17,
      truncated: false,
    }));

    await expect(createObservabilityCheckGate().run(context(exec))).resolves.toMatchObject({
      status: 'passed',
      details: { missing: [], checked: 9 },
    });
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'sh',
      args: [
        '-lc',
        expect.stringMatching(/@grafana\/faro-web-sdk.*@opentelemetry\/sdk-node.*ZAPP_PROJECT_OTLP_TOKEN/su),
      ],
    }));
  });

  test('fails closed and preserves the missing capability inventory as evidence', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 1,
      stdout: JSON.stringify({ missing: ['frontend_errors', 'project_telemetry_isolation'], checked: 9 }),
      stderr: '',
      durationMs: 11,
      truncated: false,
    }));

    await expect(createObservabilityCheckGate().run(context(exec))).resolves.toMatchObject({
      status: 'failed',
      details: {
        missing: ['frontend_errors', 'project_telemetry_isolation'],
        checked: 9,
      },
    });
  });

  test('executes against the generated templates and rejects a shared OTLP credential name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-ops10-observability-'));
    const template = async (name: string) =>
      await readFile(new URL(`../../../templates/observability/${name}.ts.hbs`, import.meta.url), 'utf8');
    try {
      await Promise.all([
        mkdir(join(root, 'src/observability'), { recursive: true }),
        mkdir(join(root, 'app/api/health'), { recursive: true }),
      ]);
      const [faro, otel, logging, health] = await Promise.all([
        template('faro-web'),
        template('otel-node'),
        template('logging'),
        template('health-endpoint'),
      ]);
      await Promise.all([
        writeFile(
          join(root, 'package.json'),
          JSON.stringify({
            dependencies: {
              '@grafana/faro-web-sdk': '1.0.0',
              '@opentelemetry/sdk-node': '1.0.0',
              pino: '1.0.0',
            },
          }),
        ),
        writeFile(join(root, 'src/observability/faro-web.ts'), faro),
        writeFile(join(root, 'src/observability/otel-node.ts'), otel),
        writeFile(join(root, 'src/observability/logging.ts'), logging),
        writeFile(join(root, 'app/api/health/route.ts'), health),
      ]);
      const exec: WorkspaceRuntime['exec'] = (input) => {
        const startedAt = Date.now();
        const result = spawnSync(input.cmd, input.args, {
          cwd: input.cwd,
          encoding: 'utf8',
        });
        return Promise.resolve({
          exitCode: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - startedAt,
          truncated: false,
        });
      };
      const fixture = {
        ...context(exec),
        contract: { ...CONTRACT, workspace_root: root },
      };

      await expect(createObservabilityCheckGate().run(fixture)).resolves.toMatchObject({
        status: 'passed',
        details: { missing: [], checked: 9 },
      });

      await writeFile(
        join(root, 'src/observability/otel-node.ts'),
        otel.replaceAll('ZAPP_PROJECT_OTLP_TOKEN', 'GRAFANA_OTLP_TOKEN'),
      );
      const failed = await createObservabilityCheckGate().run(fixture);
      expect(failed).toMatchObject({
        status: 'failed',
        details: { checked: 9 },
      });
      expect(failed.details['missing']).toEqual(
        expect.arrayContaining(['otel_project_isolation', 'project_telemetry_isolation']),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
