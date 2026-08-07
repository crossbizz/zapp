import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  runBackupCli,
  type BackupCliOperations,
  type BackupCliProcess,
} from '../scripts/backup.js';

const ORGANIZATION_ID = 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const PROJECT_ID = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7N8';
const RESTORE_KEY =
  'org/org_01J8ME7YQZJ2V9Q0X3T5B6K7N9/project/proj_01J8ME7YQZJ2V9Q0X3T5B6K7N8/git-backups/2026-08-04.bundle';
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const entrypointPath = fileURLToPath(new URL('../scripts/backup.ts', import.meta.url));
const tsxPath = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

async function spawnEntrypoint(
  action: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxPath, entrypointPath, action], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function processDouble(
  action: string,
  environment: NodeJS.ProcessEnv = {},
): {
  readonly process: BackupCliProcess;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    process: {
      argv: ['node', 'scripts/backup.ts', action],
      env: environment,
      stdout: { write: (message) => stdout.push(message) },
      stderr: { write: (message) => stderr.push(message) },
    },
    stdout,
    stderr,
  };
}

function operationsDouble(overrides: Partial<BackupCliOperations> = {}): {
  readonly operations: BackupCliOperations;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    operations: {
      nightly: () => {
        calls.push('nightly');
        return Promise.resolve({ succeeded: 1, failed: 0, repositories: [] });
      },
      restore: (selector) => {
        calls.push(`restore:${selector.key}`);
        return Promise.resolve({
          status: 'restored',
          organizationId: selector.organizationId,
          projectId: selector.projectId,
          checkedBranches: 1,
          branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
          refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
        });
      },
      restoreDrill: () => {
        calls.push('restore-drill');
        return Promise.resolve({
          status: 'restore-drill-verified',
          projectId: PROJECT_ID,
          checkedBranches: 1,
          branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
          refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
        });
      },
      close: () => {
        calls.push('close');
        return Promise.resolve();
      },
      ...overrides,
    },
    calls,
  };
}

describe('the backup CLI entrypoint', () => {
  it('executes the real entrypoint and rejects an invalid action', async () => {
    await expect(spawnEntrypoint('not-a-backup-action')).resolves.toEqual({
      code: 1,
      stdout: '',
      stderr: 'Git backup operation failed\n',
    });
  }, 15_000);

  it('executes the real entrypoint and rejects an invalid restore selector', async () => {
    await expect(
      spawnEntrypoint('restore', {
        GIT_RESTORE_ORGANIZATION_ID: ORGANIZATION_ID,
        GIT_RESTORE_PROJECT_ID: PROJECT_ID,
        GIT_RESTORE_IDEMPOTENCY_KEY: 'incident-invalid-date',
        GIT_RESTORE_KEY:
          'org/org_01J8ME7YQZJ2V9Q0X3T5B6K7N9/project/proj_01J8ME7YQZJ2V9Q0X3T5B6K7N8/git-backups/2026-13-01.bundle',
      }),
    ).resolves.toEqual({
      code: 1,
      stdout: '',
      stderr: 'Git backup operation failed\n',
    });
  });

  it('keeps every package backup script wired to the real entrypoint and action', async () => {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(packageJson.scripts?.['backup']).toBe(
      'tsx --env-file-if-exists=../../.env.local.forgejo scripts/backup.ts nightly',
    );
    expect(packageJson.scripts?.['backup:restore']).toBe(
      'tsx --env-file-if-exists=../../.env.local.forgejo scripts/backup.ts restore',
    );
    expect(packageJson.scripts?.['backup:restore-drill']).toBe(
      'tsx --env-file-if-exists=../../.env.local.forgejo scripts/backup.ts restore-drill',
    );
  });

  it('dispatches nightly and exits nonzero when any repository failed', async () => {
    const cli = processDouble('nightly');
    const fake = operationsDouble({
      nightly: () => {
        fake.calls.push('nightly');
        return Promise.resolve({ succeeded: 1, failed: 1, repositories: [] });
      },
    });

    await runBackupCli(cli.process, () => Promise.resolve(fake.operations));

    expect(fake.calls).toEqual(['nightly', 'close']);
    expect(cli.process.exitCode).toBe(1);
    expect(JSON.parse(cli.stdout.join(''))).toMatchObject({ succeeded: 1, failed: 1 });
    expect(cli.stderr).toEqual([]);
  });

  it('dispatches restore with the validated selector', async () => {
    const cli = processDouble('restore', {
      GIT_RESTORE_ORGANIZATION_ID: ORGANIZATION_ID,
      GIT_RESTORE_PROJECT_ID: PROJECT_ID,
      GIT_RESTORE_IDEMPOTENCY_KEY: 'incident-valid-dispatch',
      GIT_RESTORE_KEY: RESTORE_KEY,
    });
    const fake = operationsDouble();

    await runBackupCli(cli.process, () => Promise.resolve(fake.operations));

    expect(fake.calls).toEqual([`restore:${RESTORE_KEY}`, 'close']);
    expect(cli.process.exitCode).toBeUndefined();
    expect(JSON.parse(cli.stdout.join(''))).toMatchObject({
      status: 'restored',
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    });
  });

  it('rejects an impossible restore date before creating operational clients', async () => {
    const cli = processDouble('restore', {
      GIT_RESTORE_ORGANIZATION_ID: ORGANIZATION_ID,
      GIT_RESTORE_PROJECT_ID: PROJECT_ID,
      GIT_RESTORE_IDEMPOTENCY_KEY: 'incident-impossible-date',
      GIT_RESTORE_KEY:
        'org/org_01J8ME7YQZJ2V9Q0X3T5B6K7N9/project/proj_01J8ME7YQZJ2V9Q0X3T5B6K7N8/git-backups/2026-02-30.bundle',
    });
    let factories = 0;

    await runBackupCli(cli.process, () => {
      factories += 1;
      return Promise.resolve(operationsDouble().operations);
    });

    expect(factories).toBe(0);
    expect(cli.process.exitCode).toBe(1);
    expect(cli.stdout).toEqual([]);
    expect(cli.stderr).toEqual(['Git backup operation failed\n']);
  });

  it('requires a durable manual idempotency key before creating operational clients', async () => {
    const cli = processDouble('restore', {
      GIT_RESTORE_ORGANIZATION_ID: ORGANIZATION_ID,
      GIT_RESTORE_PROJECT_ID: PROJECT_ID,
      GIT_RESTORE_KEY: RESTORE_KEY,
    });
    let factories = 0;

    await runBackupCli(cli.process, () => {
      factories += 1;
      return Promise.resolve(operationsDouble().operations);
    });

    expect(factories).toBe(0);
    expect(cli.process.exitCode).toBe(1);
    expect(cli.stdout).toEqual([]);
    expect(cli.stderr).toEqual(['Git backup operation failed\n']);
  });

  it('has no standalone restore cleanup action or repository deletion selector', async () => {
    const cli = processDouble('restore-cleanup', {
      GIT_RESTORE_ORGANIZATION_ID: ORGANIZATION_ID,
      GIT_RESTORE_PROJECT_ID: PROJECT_ID,
      GIT_RESTORE_KEY: RESTORE_KEY,
    });
    let factories = 0;

    await runBackupCli(cli.process, () => {
      factories += 1;
      return Promise.resolve(operationsDouble().operations);
    });

    expect(factories).toBe(0);
    expect(cli.process.exitCode).toBe(1);
    expect(cli.stdout).toEqual([]);
    expect(cli.stderr).toEqual(['Git backup operation failed\n']);
  });

  it('dispatches the quarterly drill and exits nonzero when it fails', async () => {
    const cli = processDouble('restore-drill');
    const fake = operationsDouble({
      restoreDrill: () => {
        fake.calls.push('restore-drill');
        return Promise.reject(new Error('synthetic drill failure'));
      },
    });

    await runBackupCli(cli.process, () => Promise.resolve(fake.operations));

    expect(fake.calls).toEqual(['restore-drill', 'close']);
    expect(cli.process.exitCode).toBe(1);
    expect(cli.stdout).toEqual([]);
    expect(cli.stderr).toEqual(['Git backup operation failed\n']);
  });
});
