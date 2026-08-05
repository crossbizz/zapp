import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
};

type Workflow = {
  readonly env?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly env?: Readonly<Record<string, string>>;
        readonly steps?: readonly WorkflowStep[];
      }
    >
  >;
};

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/git-backups.yml', import.meta.url),
);

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
  it('exposes operational secrets only to the backup or restore step', async () => {
    const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
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
});
