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
      GIT_RESTORE_KEY: RESTORE_KEY,
    });
    const fake = operationsDouble();

    await runBackupCli(cli.process, () => Promise.resolve(fake.operations));

    expect(fake.calls).toEqual([`restore:${RESTORE_KEY}`, 'close']);
    expect(cli.process.exitCode).toBeUndefined();
    expect(JSON.parse(cli.stdout.join(''))).toMatchObject({
      status: 'restored',
      projectId: PROJECT_ID,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    });
  });

  it('rejects an impossible restore date before creating operational clients', async () => {
    const cli = processDouble('restore', {
      GIT_RESTORE_ORGANIZATION_ID: ORGANIZATION_ID,
      GIT_RESTORE_PROJECT_ID: PROJECT_ID,
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
