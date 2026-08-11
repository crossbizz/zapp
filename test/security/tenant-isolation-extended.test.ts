import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function parseVitestSummary(
  output: string,
): { passed: number; skipped: number; total: number } | undefined {
  const summary = stripVTControlCharacters(output).match(
    /Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?\s*\((\d+)\)/u,
  );
  if (summary === null) return undefined;
  return {
    passed: Number(summary[1] ?? 0),
    skipped: Number(summary[2] ?? 0),
    total: Number(summary[3] ?? 0),
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
      ['--filter', '@zapp/control-api', 'run', 'test:isolation'],
      {
        cwd: repositoryRoot,
        env: process.env,
        maxBuffer: 8 * 1_024 * 1_024,
      },
    );
    const output = `${stdout}${stderr}`;
    const summary = parseVitestSummary(output);
    expect(summary, output).toBeDefined();
    expect(summary?.passed).toBeGreaterThanOrEqual(54);
    expect(summary?.skipped).toBe(0);
    expect(summary?.total).toBe(summary?.passed);
    expect(output).not.toContain('integration tests skipped: DATABASE_URL');
  }, 120_000);

  it('parses the colored Vitest summary emitted by GitHub runners', () => {
    const output =
      '\u001B[2m Tests \u001B[22m \u001B[1m\u001B[32m54 passed\u001B[39m\u001B[22m\u001B[90m (54)\u001B[39m';
    expect(parseVitestSummary(output)).toEqual({ passed: 54, skipped: 0, total: 54 });
  });

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
