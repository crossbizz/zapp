import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
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

    expect(containsSecretReference(workflow.env)).toBe(false);
    expect(containsSecretReference(job?.env)).toBe(false);

    const setupStepNames = ['Checkout', 'Enable corepack', 'Setup Node', 'Install dependencies'];
    for (const stepName of setupStepNames) {
      const step = job?.steps?.find((candidate) => candidate.name === stepName);
      expect(step, `missing workflow step ${stepName}`).toBeDefined();
      expect(containsSecretReference(step), `${stepName} receives a secret`).toBe(false);
    }

    const operation = job?.steps?.find(
      (candidate) => candidate.name === 'Run backup or restore drill',
    );
    expect(operation, 'missing backup or restore step').toBeDefined();
    expect(operation?.env).toMatchObject(secretEnvironment);
  });
});
