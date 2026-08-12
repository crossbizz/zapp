import {
  DetectionResultSchema,
  ExecutionContractSchema,
  type DetectionContext,
  type DeploymentPlan,
  type InstrumentationPlan,
  type PackageManager,
  type ProjectAdapter,
  type ProjectContext,
  type Route,
  type TestPlan,
} from '@zapp/contracts';
import { z } from 'zod';

import { proposeManagedInstrumentation } from './managed-observability.js';

import { GenericNodeAnalysisSchema, type GenericNodeAnalysis } from './types.js';

const PackageJsonSchema = z
  .object({
    main: z.string().min(1).optional(),
    packageManager: z.string().min(1).optional(),
    scripts: z.record(z.string()).optional(),
  })
  .passthrough();

type PackageJson = z.infer<typeof PackageJsonSchema>;

const LOCKFILES: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['bun.lockb', 'bun'],
];

function normalized(paths: readonly string[]): string[] {
  return paths.map((path) => path.replaceAll('\\', '/').replace(/^\.\//u, '')).sort();
}

async function readPackageJson(ctx: DetectionContext, path: string): Promise<PackageJson> {
  return PackageJsonSchema.parse(JSON.parse(await ctx.readFile(path)));
}

function managerFrom(files: ReadonlySet<string>, manifest: PackageJson): PackageManager {
  for (const [lockfile, manager] of LOCKFILES) {
    if (files.has(lockfile)) return manager;
  }
  const declared = manifest.packageManager?.split('@')[0];
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') {
    return declared;
  }
  return 'npm';
}

function installCommand(manager: PackageManager, files: ReadonlySet<string>): string {
  switch (manager) {
    case 'npm':
      return files.has('package-lock.json') ? 'npm ci' : 'npm install';
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
  }
}

function runCommand(manager: PackageManager, script: string): string {
  return `${manager} run ${script}`;
}

function nonEmptyScript(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function portFrom(script: string | undefined): number {
  if (script === undefined) return 3000;
  const match = /(?:^|\s)(?:PORT=|--port(?:=|\s+)|-p\s+)(\d{1,5})(?:\s|$)/u.exec(script);
  if (match?.[1] === undefined) return 3000;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? port : 3000;
}

async function workspaceCandidates(
  ctx: DetectionContext,
  files: readonly string[],
): Promise<string[]> {
  const manifests = files.filter(
    (path) => path.endsWith('/package.json') && !path.includes('/node_modules/'),
  );
  const candidates: string[] = [];
  for (const path of manifests) {
    const manifest = await readPackageJson(ctx, path);
    if (
      nonEmptyScript(manifest.scripts?.dev) !== undefined ||
      nonEmptyScript(manifest.scripts?.start) !== undefined
    ) {
      candidates.push(path.slice(0, -'/package.json'.length));
    }
  }
  return candidates.sort();
}

export async function analyzeGenericNode(ctx: DetectionContext): Promise<GenericNodeAnalysis> {
  const listed = normalized(await ctx.listFiles('**/*'));
  const files = new Set(listed);
  const manifest = await readPackageJson(ctx, 'package.json');
  const scripts = manifest.scripts ?? {};
  const manager = managerFrom(files, manifest);
  const developScript =
    nonEmptyScript(scripts.dev) !== undefined
      ? 'dev'
      : nonEmptyScript(scripts.start) !== undefined
        ? 'start'
        : undefined;
  const developCommand =
    developScript === undefined
      ? `node ${manifest.main ?? '.'}`
      : runCommand(manager, developScript);
  const developSource = developScript === undefined ? undefined : scripts[developScript];
  const isMonorepo = files.has('pnpm-workspace.yaml') || files.has('turbo.json');
  const candidates = isMonorepo ? await workspaceCandidates(ctx, listed) : [];

  return GenericNodeAnalysisSchema.parse({
    contract: ExecutionContractSchema.parse({
      version: 1,
      package_manager: manager,
      workspace_root: ctx.workspaceRoot,
      install: { command: installCommand(manager, files) },
      develop: { command: developCommand, port: portFrom(developSource) },
      ...(nonEmptyScript(scripts.build) === undefined
        ? {}
        : { build: { command: runCommand(manager, 'build') } }),
      ...(nonEmptyScript(scripts.start) === undefined && manifest.main === undefined
        ? {}
        : {
            start: {
              command:
                nonEmptyScript(scripts.start) === undefined
                  ? `node ${manifest.main ?? '.'}`
                  : runCommand(manager, 'start'),
            },
          }),
      ...(nonEmptyScript(scripts.typecheck) === undefined && nonEmptyScript(scripts.tsc) === undefined
        ? {}
        : {
            typecheck: {
              command: runCommand(
                manager,
                nonEmptyScript(scripts.typecheck) === undefined ? 'tsc' : 'typecheck',
              ),
            },
          }),
      ...(nonEmptyScript(scripts.lint) === undefined
        ? {}
        : { lint: { command: runCommand(manager, 'lint') } }),
      ...(nonEmptyScript(scripts.test) === undefined
        ? {}
        : { test: { unit: runCommand(manager, 'test') } }),
    }),
    openQuestions:
      candidates.length < 2
        ? []
        : [
            {
              kind: 'workspace_target',
              candidates,
              prompt: 'Which workspace package is the application target?',
            },
          ],
  });
}

export const genericNodeAdapter: ProjectAdapter = {
  id: 'generic-node',
  async detect(ctx) {
    const files = new Set(normalized(await ctx.listFiles('**/*')));
    const evidence = ['package.json'];
    for (const [lockfile] of LOCKFILES) {
      if (files.has(lockfile)) evidence.push(lockfile);
    }
    if (files.has('pnpm-workspace.yaml')) evidence.push('pnpm-workspace.yaml');
    if (files.has('turbo.json')) evidence.push('turbo.json');
    return DetectionResultSchema.parse({ adapterId: 'generic-node', confidence: 0.25, evidence });
  },
  async deriveExecutionContract(ctx: ProjectContext) {
    return (await analyzeGenericNode(ctx)).contract;
  },
  discoverRoutes(): Promise<Route[]> {
    return Promise.resolve([]);
  },
  proposeTests(): Promise<TestPlan> {
    return Promise.resolve({ tests: [] });
  },
  proposeInstrumentation(ctx): Promise<InstrumentationPlan> {
    return proposeManagedInstrumentation(ctx, 'generic-node');
  },
  proposeDeployment(): Promise<DeploymentPlan | null> {
    return Promise.resolve(null);
  },
};
