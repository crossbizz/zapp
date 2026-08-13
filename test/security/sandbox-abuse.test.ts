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
  const hasModalCredentials =
    typeof process.env.MODAL_TOKEN_ID === 'string' &&
    process.env.MODAL_TOKEN_ID !== '' &&
    typeof process.env.MODAL_TOKEN_SECRET === 'string' &&
    process.env.MODAL_TOKEN_SECRET !== '';

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

  it('maps OOM and unexpected termination to checkpoint recovery with an abnormal terminal record', async () => {
    const output = await runGate(
      '@zapp/sandbox-service',
      'test/lifecycle.test.ts',
      'defines a closed recovery action for every PRD failure case',
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
    expect(workflow).toContain(
      'pnpm turbo run build --filter=@zapp/workspace-agent --filter=@zapp/sandbox-service --filter=@zapp/orchestrator-worker --filter=@zapp/control-api',
    );
    expect(workflow).toContain('pnpm exec vitest run test/security --no-file-parallelism');
  });

  it.skipIf(!hasModalCredentials)(
    'runs provider-enforced egress, process-fanout, and memory-exhaustion containment on Modal [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
    async () => {
      const output = await runGate(
        '@zapp/sandbox-service',
        'test/integration/modal-e2e.test.ts',
        'blocks non-allowlisted egress and survives bounded process and memory exhaustion',
      );
      expect(output).toContain('1 passed');
    },
    240_000,
  );
});
