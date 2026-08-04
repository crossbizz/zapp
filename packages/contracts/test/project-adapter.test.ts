import { describe, expect, it } from 'vitest';
import {
  DeploymentPlanSchema,
  DetectionResultSchema,
  InstrumentationPlanSchema,
  ProposedTestSchema,
  RouteSchema,
  TestPlanSchema,
  type ProjectAdapter,
  type ProjectContext,
} from '../src/project-adapter.js';

// Round-trips only: `kind`, `capability` and provider ids are v1 shapes rather than
// PRD-fixed lists, so plan 05 can still widen them without breaking a pin here.

const detection = {
  adapterId: 'generic-node',
  confidence: 0.4,
  evidence: ['package.json', 'pnpm-lock.yaml'],
};

describe('project adapter schemas', () => {
  it('round-trips detection, routes, and the three proposals', () => {
    expect(DetectionResultSchema.parse(detection)).toEqual(detection);

    const route = {
      path: '/projects/[id]',
      kind: 'page',
      dynamic: true,
      sourceFile: 'app/projects/[id]/page.tsx',
    };
    expect(RouteSchema.parse(route)).toEqual(route);

    const proposedTest = {
      id: 'smoke-home',
      kind: 'browser',
      title: 'home page renders without console errors',
      targetPath: 'tests/smoke/home.spec.ts',
      rationale: 'discovered route with no existing coverage',
    };
    expect(ProposedTestSchema.parse(proposedTest)).toEqual(proposedTest);
    expect(TestPlanSchema.parse({ tests: [proposedTest] })).toEqual({ tests: [proposedTest] });

    const instrumentationPlan = {
      steps: [
        {
          id: 'health-endpoint',
          capability: 'health_endpoint',
          targetPath: 'app/api/health/route.ts',
          rationale: 'no health path detected in the execution contract',
          alreadyPresent: false,
        },
      ],
    };
    expect(InstrumentationPlanSchema.parse(instrumentationPlan)).toEqual(instrumentationPlan);

    const deploymentPlan = {
      providerId: 'vercel',
      rationale: 'next.config.ts present and no custom server',
      requiredEnvVars: ['DATABASE_URL'],
    };
    expect(DeploymentPlanSchema.parse(deploymentPlan)).toEqual(deploymentPlan);
  });
});

describe('ProjectAdapter', () => {
  // Implementing the interface is the test: `deriveExecutionContract` has to satisfy
  // the execution contract schema's inferred type without a cast.
  const adapter: ProjectAdapter = {
    id: 'generic-node',
    detect: (ctx) =>
      Promise.resolve({
        adapterId: 'generic-node',
        confidence: 0.4,
        evidence: [ctx.workspaceRoot],
      }),
    deriveExecutionContract: (ctx) =>
      Promise.resolve({
        version: 1,
        package_manager: 'npm',
        workspace_root: ctx.workspaceRoot,
        install: { command: 'npm ci' },
        develop: { command: 'npm run dev', port: 3000 },
      }),
    discoverRoutes: () => Promise.resolve([]),
    proposeTests: () => Promise.resolve({ tests: [] }),
    proposeInstrumentation: () => Promise.resolve({ steps: [] }),
    proposeDeployment: () => Promise.resolve(null),
  };

  const ctx: ProjectContext = {
    workspaceRoot: 'apps/web',
    listFiles: () => Promise.resolve(['package.json']),
    readFile: () => Promise.resolve('{"name":"web"}'),
    detection,
  };

  it('detects from the context it is handed', async () => {
    expect(await adapter.detect(ctx)).toEqual({
      adapterId: 'generic-node',
      confidence: 0.4,
      evidence: ['apps/web'],
    });
  });

  it('derives a contract the execution contract schema accepts', async () => {
    const contract = await adapter.deriveExecutionContract(ctx);
    expect(contract.workspace_root).toBe('apps/web');
    expect(await adapter.proposeDeployment(ctx)).toBeNull();
  });
});
