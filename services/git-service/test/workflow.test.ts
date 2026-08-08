import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
};

type Workflow = {
  readonly env?: Readonly<Record<string, string>>;
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: boolean };
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly if?: string;
        readonly needs?: string;
        readonly environment?: string;
        readonly env?: Readonly<Record<string, string>>;
        readonly services?: Readonly<
          Record<string, { readonly env?: Readonly<Record<string, string>> }>
        >;
        readonly steps?: readonly WorkflowStep[];
      }
    >
  >;
};

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/git-backups.yml', import.meta.url),
);
const prePushHookPath = fileURLToPath(
  new URL('../../../scripts/git-hooks/pre-push.local', import.meta.url),
);
const rootPackagePath = fileURLToPath(new URL('../../../package.json', import.meta.url));
const gitServicePackagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const turboConfigPath = fileURLToPath(new URL('../../../turbo.json', import.meta.url));
const execute = promisify(execFile);

const secretEnvironment = {
  DATABASE_URL: '${{ secrets.GIT_BACKUP_DATABASE_URL }}',
  FORGEJO_URL: '${{ secrets.GIT_BACKUP_FORGEJO_URL }}',
  FORGEJO_ADMIN_TOKEN: '${{ secrets.GIT_BACKUP_FORGEJO_ADMIN_TOKEN }}',
  ARTIFACT_ENDPOINT: '${{ secrets.GIT_BACKUP_R2_ENDPOINT }}',
  ARTIFACT_KEY: '${{ secrets.GIT_BACKUP_R2_ACCESS_KEY_ID }}',
  ARTIFACT_SECRET: '${{ secrets.GIT_BACKUP_R2_SECRET_ACCESS_KEY }}',
  ARTIFACT_BUCKET: '${{ secrets.GIT_BACKUP_R2_BUCKET }}',
} as const;

function containsSecretReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes('${{ secrets.');
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretReference);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsSecretReference);
  }
  return false;
}

describe('the Git backup workflow', () => {
  it('fails an always-running non-secret guard unless the protected default branch is executing', async () => {
    const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
    const guard = workflow.jobs?.guard;
    const guardedRun = workflow.jobs?.run;
    const script = guard?.steps?.find((step) => step.name === 'Validate protected default branch')
      ?.run;

    expect(guard, 'missing always-running workflow guard').toBeDefined();
    expect(guard?.if).toBeUndefined();
    expect(guard?.environment).toBeUndefined();
    expect(containsSecretReference(guard)).toBe(false);
    expect(script, 'missing executable guard script').toBeDefined();
    expect(guardedRun?.needs).toBe('guard');
    expect(guardedRun?.if).toBeUndefined();
    if (script === undefined) {
      return;
    }

    const guardEnvironment = {
      ...process.env,
      DEFAULT_BRANCH: 'main',
      ACTUAL_REF: 'refs/heads/main',
      REF_PROTECTED: 'true',
    };
    await expect(execute('bash', ['-c', script], { env: guardEnvironment })).resolves.toMatchObject({
      stderr: '',
    });
    await expect(
      execute('bash', ['-c', script], {
        env: { ...guardEnvironment, ACTUAL_REF: 'refs/heads/review-controlled' },
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execute('bash', ['-c', script], {
        env: { ...guardEnvironment, REF_PROTECTED: 'false' },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('allows secrets only on the protected default branch and checks out that branch explicitly', async () => {
    const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
    const job = workflow.jobs?.run;

    expect(job?.needs).toBe('guard');
    expect(job?.environment).toBe('git-backups-default-branch');
    expect(job?.steps?.find((step) => step.name === 'Checkout')).toMatchObject({
      uses: 'actions/checkout@v5',
      with: {
        ref: '${{ github.event.repository.default_branch }}',
        'persist-credentials': false,
      },
    });
  });

  it('exposes operational secrets only to the backup or restore step', async () => {
    const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
    expect(workflow.concurrency).toEqual({
      group: 'git-backups',
      'cancel-in-progress': false,
    });
    const job = workflow.jobs?.run;
    const steps = job?.steps ?? [];
    const operationIndexes = steps.flatMap((step, index) =>
      step.name === 'Run backup or restore drill' ? [index] : [],
    );
    expect(operationIndexes).toEqual([steps.length - 1]);
    const operation = steps.at(-1);
    expect(operation, 'missing backup or restore step').toBeDefined();
    expect(operation?.env).toEqual(secretEnvironment);
    expect(operation?.run).toBe(
      `if [ "\${{ github.event.schedule == '29 4 1 */3 *' && 'restore-drill' || inputs.mode || 'nightly' }}" = 'restore-drill' ]; then\n  pnpm --filter @zapp/git-service backup:restore-drill\nelse\n  pnpm --filter @zapp/git-service backup\nfi\n`,
    );

    const workflowWithoutOperation = structuredClone(workflow) as {
      jobs?: Record<string, { steps?: WorkflowStep[] }>;
    };
    workflowWithoutOperation.jobs?.run?.steps?.pop();
    expect(
      containsSecretReference(workflowWithoutOperation),
      'a non-operation workflow field receives a secret',
    ).toBe(false);
    expect(containsSecretReference({ ...operation, env: undefined })).toBe(false);
  });

  it('the local pre-push gate runs the live backup proof with pinned dependencies', async () => {
    const hook = await readFile(prePushHookPath, 'utf8');
    const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const gitServicePackage = JSON.parse(await readFile(gitServicePackagePath, 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const turboConfig = await readFile(turboConfigPath, 'utf8');
    const integrationTaskStart = turboConfig.indexOf('"test:integration"');
    const nextTaskStart = turboConfig.indexOf('"dev"', integrationTaskStart);
    const integrationTask = turboConfig.slice(integrationTaskStart, nextTaskStart);
    const verifyCommandIndex = hook.lastIndexOf('\npnpm verify\n');
    const requiredHookLines = [
      '[ -f .env.local.forgejo ] && . ./.env.local.forgejo',
      'export DATABASE_URL="postgres://zapp:zapp@localhost:${ZAPP_POSTGRES_PORT:-5432}/zapp"',
      'export CI="zapp-prepush"',
      'export GIT_BACKUP_LIVE="1"',
      'export ARTIFACT_ENDPOINT="http://localhost:${ZAPP_MINIO_PORT:-9000}"',
      'export ARTIFACT_KEY="minioadmin"',
      'export ARTIFACT_SECRET="minioadmin"',
      'export ARTIFACT_BUCKET="zapp-artifacts"',
    ] as const;

    expect(verifyCommandIndex, 'pre-push does not invoke the root verification gate').toBeGreaterThan(
      0,
    );
    for (const line of requiredHookLines) {
      const lineIndex = hook.indexOf(line);
      expect(lineIndex, `missing pre-push arm: ${line}`).toBeGreaterThanOrEqual(0);
      expect(lineIndex, `pre-push arm runs after pnpm verify: ${line}`).toBeLessThan(
        verifyCommandIndex,
      );
    }
    expect(rootPackage.scripts?.['verify']).toContain(
      'turbo run test:integration --filter=!@zapp/desktop --concurrency=1',
    );
    expect(gitServicePackage.scripts?.['test:integration']).toBe(
      'node --env-file-if-exists=../../.env.local.forgejo ./node_modules/vitest/vitest.mjs run --dir test/integration --no-file-parallelism',
    );
    expect(integrationTaskStart).toBeGreaterThanOrEqual(0);
    expect(nextTaskStart).toBeGreaterThan(integrationTaskStart);
    for (const variable of [
      'CI',
      'GIT_BACKUP_LIVE',
      'DATABASE_URL',
      'FORGEJO_URL',
      'FORGEJO_ADMIN_TOKEN',
      'ARTIFACT_ENDPOINT',
      'ARTIFACT_KEY',
      'ARTIFACT_SECRET',
      'ARTIFACT_BUCKET',
    ]) {
      expect(integrationTask, `Turbo strips ${variable} from test:integration`).toContain(
        `"${variable}"`,
      );
    }
  });
});
