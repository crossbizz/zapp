import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { FileQuerySchema } from '../../sandbox/workspace-agent/src/fs.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

it('rejects the lexical, absolute, percent-encoded, null-byte, and symlink corpus at the workspace-agent boundary', async () => {
  const { stdout, stderr } = await execFileAsync(
    'pnpm',
    [
      '--filter',
      '@zapp/workspace-agent',
      'exec',
      'vitest',
      'run',
      'test/agent.test.ts',
      '--no-file-parallelism',
      '-t',
      'rejects lexical, absolute, encoded, and symlink path escapes before access or spawn',
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      maxBuffer: 8 * 1_024 * 1_024,
    },
  );
  const output = `${stdout}${stderr}`;
  expect(output).toContain('1 passed');
  expect(FileQuerySchema.safeParse({ path: 'unsafe\0path' }).success).toBe(false);
}, 90_000);
