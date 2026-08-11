import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

async function runGate(workspace: string, file: string, name: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'pnpm',
    [
      '--filter',
      workspace,
      'exec',
      'vitest',
      'run',
      file,
      '--no-file-parallelism',
      '--testTimeout',
      '30000',
      '--hookTimeout',
      '30000',
      '-t',
      name,
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      maxBuffer: 8 * 1_024 * 1_024,
    },
  );
  return `${stdout}${stderr}`;
}

describe('OPS-12 permanent local sandbox-abuse gate', () => {
  it('contains a process group and leaves no descendant after timeout', async () => {
    const output = await runGate(
      '@zapp/workspace-agent',
      'test/agent.test.ts',
      'times out the whole process group without leaving a descendant',
    );
    expect(output).toContain('1 passed');
  }, 90_000);

  it('retains cgroup ownership until the authoritative empty signal after a kill', async () => {
    const output = await runGate(
      '@zapp/workspace-agent',
      'test/cgroup.test.ts',
      'kills and re-observes the authoritative empty signal before cleanup ownership ends',
    );
    expect(output).toContain('1 passed');
  }, 60_000);

  it('records the strict build-test domain policy', async () => {
    const output = await runGate(
      '@zapp/sandbox-service',
      'test/injection.test.ts',
      'resolves strict domain policy and records the requested defense-in-depth profile',
    );
    expect(output).toContain('1 passed');
  }, 60_000);

  it('keeps control-plane credentials out of Modal workspace source', async () => {
    const output = await runGate(
      '@zapp/sandbox-service',
      'test/modal-source-secret.test.ts',
      'scopes the named source-read secret through partial-clone checkout and only its fetch layer',
    );
    expect(output).toContain('1 passed');
  }, 60_000);

  it('is wired as a named permanent security-suite CI job', async () => {
    const workflow = await readFile(
      new URL('../../.github/workflows/security.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('security-suite:');
    expect(workflow).toContain('pnpm exec vitest run test/security --no-file-parallelism');
    const runtimeBuild = workflow.indexOf('pnpm --filter @zapp/workspace-runtime build');
    const suiteTypecheck = workflow.indexOf(
      'pnpm exec tsc --noEmit -p test/security/tsconfig.json',
    );
    expect(runtimeBuild).toBeGreaterThan(-1);
    expect(suiteTypecheck).toBeGreaterThan(runtimeBuild);
  });
});
