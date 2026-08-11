import { describe, expect, it } from 'vitest';

import {
  classifyDeploymentType,
  createDeploymentConfirmationSummary,
  DeploymentConfirmationError,
  validateDeploymentConfirmation,
} from '../src/release/types.js';

const ENVIRONMENT = 'env_01J00000000000000000000000';
const OTHER_ENVIRONMENT = 'env_01J00000000000000000000001';
const PROJECT = 'proj_01J00000000000000000000000';
const OTHER_PROJECT = 'proj_01J00000000000000000000001';

function historyEntry(input: {
  environmentId?: string;
  projectId?: string;
  repositoryLineageId?: string;
  deployedAt?: string;
} = {}) {
  return {
    environmentId: input.environmentId ?? ENVIRONMENT,
    projectId: input.projectId ?? PROJECT,
    repositoryLineageId: input.repositoryLineageId ?? 'repo-lineage-primary',
    deployedAt: input.deployedAt ?? '2026-08-11T17:00:00.000Z',
  };
}

function target(input: {
  projectId?: string;
  repositoryLineageId?: string;
  explicitUserRetarget?: boolean;
} = {}) {
  return {
    environmentId: ENVIRONMENT,
    projectId: input.projectId ?? PROJECT,
    repositoryLineageId: input.repositoryLineageId ?? 'repo-lineage-primary',
    explicitUserRetarget: input.explicitUserRetarget ?? false,
  };
}

describe('deployment type classification', () => {
  it('classifies a target with no deployment in that environment as first_deploy', () => {
    expect(
      classifyDeploymentType({
        history: [historyEntry({ environmentId: OTHER_ENVIRONMENT })],
        target: target(),
      }),
    ).toBe('first_deploy');
  });

  it('classifies the latest deployment in the same repository lineage as redeploy', () => {
    expect(
      classifyDeploymentType({
        history: [
          historyEntry({
            projectId: OTHER_PROJECT,
            repositoryLineageId: 'repo-lineage-old',
            deployedAt: '2026-08-10T17:00:00.000Z',
          }),
          historyEntry(),
        ],
        target: target(),
      }),
    ).toBe('redeploy');
  });

  it('selects the latest deployment by instant rather than ISO offset text', () => {
    expect(
      classifyDeploymentType({
        history: [
          historyEntry({
            repositoryLineageId: 'repo-lineage-replacement',
            deployedAt: '2026-08-11T18:00:00.000+02:00',
          }),
          historyEntry({ deployedAt: '2026-08-11T17:30:00.000Z' }),
        ],
        target: target(),
      }),
    ).toBe('redeploy');
  });

  it('classifies a repository lineage mismatch as replace_deployment', () => {
    expect(
      classifyDeploymentType({
        history: [historyEntry()],
        target: target({ projectId: OTHER_PROJECT, repositoryLineageId: 'repo-lineage-replacement' }),
      }),
    ).toBe('replace_deployment');
  });

  it('classifies a different project as replace_deployment even if lineage is reused', () => {
    expect(
      classifyDeploymentType({
        history: [historyEntry()],
        target: target({ projectId: OTHER_PROJECT }),
      }),
    ).toBe('replace_deployment');
  });

  it('classifies an explicit user retarget as replace_deployment even within one lineage', () => {
    expect(
      classifyDeploymentType({
        history: [historyEntry()],
        target: target({ explicitUserRetarget: true }),
      }),
    ).toBe('replace_deployment');
  });
});

describe('deployment confirmation contract', () => {
  it('rejects a replace deployment without an explicit data disposition', () => {
    let thrown: unknown;
    try {
      validateDeploymentConfirmation({
        deploymentType: 'replace_deployment',
        confirmation: { dataDisposition: null },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DeploymentConfirmationError);
    if (!(thrown instanceof DeploymentConfirmationError)) throw thrown;
    expect(thrown.code).toBe('data_disposition_required');
    expect(thrown.statusCode).toBe(422);
    expect(thrown.message).toBe('Replacing a deployment requires a data disposition.');
  });

  it('accepts every explicit replace disposition and null for non-replacement deploys', () => {
    for (const dataDisposition of ['preserve', 'transfer', 'reset'] as const) {
      expect(
        validateDeploymentConfirmation({
          deploymentType: 'replace_deployment',
          confirmation: { dataDisposition },
        }),
      ).toEqual({ deploymentType: 'replace_deployment', confirmation: { dataDisposition } });
    }
    expect(
      validateDeploymentConfirmation({
        deploymentType: 'redeploy',
        confirmation: { dataDisposition: null },
      }),
    ).toEqual({ deploymentType: 'redeploy', confirmation: { dataDisposition: null } });
  });

  it('rejects an explicit data disposition for a non-replacement deploy', () => {
    let thrown: unknown;
    try {
      validateDeploymentConfirmation({
        deploymentType: 'redeploy',
        confirmation: { dataDisposition: 'reset' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DeploymentConfirmationError);
    if (!(thrown instanceof DeploymentConfirmationError)) throw thrown;
    expect(thrown.code).toBe('data_disposition_not_applicable');
    expect(thrown.statusCode).toBe(422);
    expect(thrown.message).toBe('Data disposition only applies when replacing a deployment.');
  });

  it('renders first-deploy effects in user language for WEB-14', () => {
    expect(
      createDeploymentConfirmationSummary({
        deploymentType: 'first_deploy',
        dataDisposition: null,
        migration: { count: 0, reversibility: 'reversible' },
        secretChanges: {
          addedNames: ['DATABASE_URL', 'API_ORIGIN'],
          changedNames: [],
          removedNames: [],
        },
        urlEffect: 'created',
        activeUserEffect: 'zero_downtime',
      }),
    ).toMatchInlineSnapshot(`
      {
        "deploymentType": "first_deploy",
        "effects": {
          "activeUsers": "Active users: zero downtime. Traffic switches only after health checks pass.",
          "productionData": "Production data: preserved. No migrations will run.",
          "secrets": "Secrets: added API_ORIGIN, DATABASE_URL; changed none; removed none.",
          "url": "Production URL: a new permanent URL will be created.",
        },
        "requiresExplicitDataDisposition": false,
        "title": "First deploy",
      }
    `);
  });

  it('renders redeploy migration and secret effects in user language for WEB-14', () => {
    expect(
      createDeploymentConfirmationSummary({
        deploymentType: 'redeploy',
        dataDisposition: null,
        migration: { count: 2, reversibility: 'compensating' },
        secretChanges: {
          addedNames: ['NEW_API_KEY'],
          changedNames: ['DATABASE_URL'],
          removedNames: ['LEGACY_TOKEN'],
        },
        urlEffect: 'preserved',
        activeUserEffect: 'zero_downtime',
      }),
    ).toMatchInlineSnapshot(`
      {
        "deploymentType": "redeploy",
        "effects": {
          "activeUsers": "Active users: zero downtime. Traffic switches only after health checks pass.",
          "productionData": "Production data: migrated by 2 migrations. Reversibility: compensating.",
          "secrets": "Secrets: added NEW_API_KEY; changed DATABASE_URL; removed LEGACY_TOKEN.",
          "url": "Production URL: preserved.",
        },
        "requiresExplicitDataDisposition": false,
        "title": "Redeploy",
      }
    `);
  });

  it('renders an explicitly selected destructive replacement and provider interruption verbatim', () => {
    expect(
      createDeploymentConfirmationSummary({
        deploymentType: 'replace_deployment',
        dataDisposition: 'reset',
        migration: { count: 0, reversibility: 'unavailable' },
        secretChanges: {
          addedNames: [],
          changedNames: [],
          removedNames: ['OLD_DATABASE_URL'],
        },
        urlEffect: 'changed',
        activeUserEffect: 'brief_interruption',
      }),
    ).toMatchInlineSnapshot(`
      {
        "deploymentType": "replace_deployment",
        "effects": {
          "activeUsers": "Active users: a brief interruption is expected while the provider switches traffic.",
          "productionData": "Production data: reset. This destructive choice requires explicit selection.",
          "secrets": "Secrets: added none; changed none; removed OLD_DATABASE_URL.",
          "url": "Production URL: changed.",
        },
        "requiresExplicitDataDisposition": true,
        "title": "Replace deployment",
      }
    `);
  });

  it('does not infer production data behavior before a replacement selection', () => {
    const summary = createDeploymentConfirmationSummary({
      deploymentType: 'replace_deployment',
      dataDisposition: null,
      migration: { count: 0, reversibility: 'reversible' },
      secretChanges: { addedNames: [], changedNames: [], removedNames: [] },
      urlEffect: 'preserved',
      activeUserEffect: 'zero_downtime',
    });

    expect(summary.effects.productionData).toBe(
      'Production data: select Preserve, Transfer, or Reset. No choice will be inferred.',
    );
  });

  it('states transfer and migration effects together for a replacement', () => {
    const summary = createDeploymentConfirmationSummary({
      deploymentType: 'replace_deployment',
      dataDisposition: 'transfer',
      migration: { count: 1, reversibility: 'reversible' },
      secretChanges: { addedNames: [], changedNames: [], removedNames: [] },
      urlEffect: 'preserved',
      activeUserEffect: 'zero_downtime',
    });

    expect(summary.effects.productionData).toBe(
      'Production data: migrated to the replacement deployment by 1 migration. Reversibility: reversible.',
    );
  });
});
