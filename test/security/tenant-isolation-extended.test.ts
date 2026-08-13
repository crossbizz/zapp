import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

interface VitestJsonSummary {
  readonly numFailedTests: number;
  readonly numPassedTests: number;
  readonly numPendingTests: number;
  readonly numTotalTests: number;
  readonly success: boolean;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseVitestJsonSummary(stdout: string): VitestJsonSummary {
  const value = JSON.parse(stdout) as unknown;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Vitest JSON summary must be an object.');
  }
  const summary = value as Record<string, unknown>;
  if (
    !isNonnegativeInteger(summary.numFailedTests) ||
    !isNonnegativeInteger(summary.numPassedTests) ||
    !isNonnegativeInteger(summary.numPendingTests) ||
    !isNonnegativeInteger(summary.numTotalTests) ||
    typeof summary.success !== 'boolean'
  ) {
    throw new Error('Vitest JSON summary is missing required counters.');
  }
  return {
    numFailedTests: summary.numFailedTests,
    numPassedTests: summary.numPassedTests,
    numPendingTests: summary.numPendingTests,
    numTotalTests: summary.numTotalTests,
    success: summary.success,
  };
}

async function runControlApiGate(file: string, name?: string): Promise<string> {
  const arguments_ = [
    '--filter',
    '@zapp/control-api',
    'exec',
    'vitest',
    'run',
    file,
    '--no-file-parallelism',
    ...(name === undefined ? [] : ['-t', name]),
  ];
  const { stdout, stderr } = await execFileAsync('pnpm', arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 8 * 1_024 * 1_024,
  });
  return `${stdout}${stderr}`;
}

describe('OPS-12 permanent tenant isolation gate', () => {
  it('runs the two-tenant project, run, event, secret, and audit matrix against PostgreSQL', async () => {
    const { stdout, stderr } = await execFileAsync(
      'pnpm',
      [
        '--filter',
        '@zapp/control-api',
        'exec',
        'vitest',
        'run',
        '--dir',
        'test/integration',
        '--no-file-parallelism',
        'tenant-isolation',
        '--reporter=json',
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        maxBuffer: 8 * 1_024 * 1_024,
      },
    );
    const summary = parseVitestJsonSummary(stdout);
    expect(summary.success).toBe(true);
    expect(summary.numPassedTests).toBeGreaterThanOrEqual(54);
    expect(summary.numFailedTests).toBe(0);
    expect(summary.numPendingTests).toBe(0);
    expect(summary.numTotalTests).toBe(summary.numPassedTests);
    expect(`${stdout}${stderr}`).not.toContain('integration tests skipped: DATABASE_URL');
  }, 120_000);

  it('returns tenant-hidden 404s for foreign releases and their evidence', async () => {
    const output = await runControlApiGate(
      'test/releases.test.ts',
      'returns a tenant-hidden 404 before Viewer RBAC for a foreign release',
    );
    expect(output).toContain('1 passed');
  }, 60_000);

  it('rejects artifact receipts outside the tenant and project storage prefix', async () => {
    const output = await runControlApiGate(
      'test/projects.test.ts',
      'rejects an artifact receipt outside the tenant and project prefix',
    );
    expect(output).toContain('1 passed');
  }, 60_000);
});
