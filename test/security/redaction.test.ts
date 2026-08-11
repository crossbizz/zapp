import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

async function runGate(workspace: string, file: string, name: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'pnpm',
    ['--filter', workspace, 'exec', 'vitest', 'run', file, '--no-file-parallelism', '-t', name],
    {
      cwd: repositoryRoot,
      env: process.env,
      maxBuffer: 8 * 1_024 * 1_024,
    },
  );
  return `${stdout}${stderr}`;
}

describe('OPS-12 permanent redaction gate', () => {
  it('removes registered values from buffered and split-stream sandbox responses', async () => {
    const output = await runGate(
      '@zapp/sandbox-service',
      'test/injection.test.ts',
      'redacts every registered value and rejects forbidden sandbox environment keys',
    );
    expect(output).toContain('1 passed');
  }, 60_000);

  it('removes seeded values from model-visible tool results', async () => {
    const output = await runGate(
      '@zapp/orchestrator-worker',
      'test/session.test.ts',
      'persists a real write result and completes on the second model turn',
    );
    expect(output).toContain('1 passed');
  }, 60_000);

  it('removes model text and tool-input secrets before transcript persistence', async () => {
    const output = await runGate(
      '@zapp/orchestrator-worker',
      'test/session.test.ts',
      'redacts model text, tool-input values, and tool-input keys before persistence',
    );
    expect(output).toContain('1 passed');
  }, 60_000);
});
