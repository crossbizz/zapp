import {
  DeploymentPlanSchema,
  DetectionResultSchema,
  ExecutionContractSchema,
  InstrumentationPlanSchema,
  RouteSchema,
  TestPlanSchema,
  type DetectionContext,
  type DeploymentPlan,
  type InstrumentationPlan,
  type ProjectAdapter,
  type ProjectContext,
  type Route,
  type TestPlan,
} from '@zapp/contracts';
import { z } from 'zod';

import { analyzeGenericNode } from './generic-node.js';

const PackageJsonSchema = z
  .object({
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
    scripts: z.record(z.string()).optional(),
  })
  .passthrough();

export interface FrameworkAdapter extends ProjectAdapter {
  readonly buildOutput: string | null;
  readonly preservePaths: readonly string[];
  readonly supportsStoreRelease: boolean;
}

export interface FrameworkAdapterOptions {
  readonly id: string;
  readonly configPatterns?: readonly RegExp[];
  readonly dependencies?: readonly string[];
  readonly configConfidence?: number;
  readonly dependencyConfidence?: number;
  readonly defaultPort: number;
  readonly buildOutput: string | null;
  readonly deploymentProvider: 'vercel' | 'fly' | null;
  readonly preservePaths?: readonly string[];
  readonly supportsStoreRelease?: boolean;
  readonly discoverRoutes?: (ctx: ProjectContext) => Promise<Route[]>;
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

async function files(ctx: DetectionContext): Promise<string[]> {
  return (await ctx.listFiles('**/*')).map(normalize).sort();
}

async function packageJson(ctx: DetectionContext): Promise<z.infer<typeof PackageJsonSchema>> {
  return PackageJsonSchema.parse(JSON.parse(await ctx.readFile('package.json')));
}

function explicitPort(scripts: Readonly<Record<string, string>>): number | undefined {
  const command = scripts.dev ?? scripts.start;
  if (command === undefined) return undefined;
  const match = /(?:^|\s)(?:PORT=|--port(?:=|\s+)|-p\s+)(\d{1,5})(?:\s|$)/u.exec(command);
  const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : undefined;
}

export function createFrameworkAdapter(options: FrameworkAdapterOptions): FrameworkAdapter {
  const preservePaths = [...(options.preservePaths ?? [])];
  return {
    id: options.id,
    buildOutput: options.buildOutput,
    preservePaths,
    supportsStoreRelease: options.supportsStoreRelease ?? true,
    async detect(ctx) {
      const listed = await files(ctx);
      const configEvidence = listed.filter((path) =>
        (options.configPatterns ?? []).some((pattern) => pattern.test(path)),
      );
      const manifest = await packageJson(ctx);
      const declared = { ...manifest.dependencies, ...manifest.devDependencies };
      const dependencyMatch = (options.dependencies ?? []).some((name) => name in declared);
      const evidence = configEvidence.length > 0 ? configEvidence : dependencyMatch ? ['package.json'] : [];
      return DetectionResultSchema.parse({
        adapterId: options.id,
        confidence:
          configEvidence.length > 0
            ? (options.configConfidence ?? 0.95)
            : dependencyMatch
              ? (options.dependencyConfidence ?? 0.85)
              : 0,
        evidence,
      });
    },
    async deriveExecutionContract(ctx) {
      const generic = (await analyzeGenericNode(ctx)).contract;
      const manifest = await packageJson(ctx);
      return ExecutionContractSchema.parse({
        ...generic,
        develop: {
          ...generic.develop,
          port: explicitPort(manifest.scripts ?? {}) ?? options.defaultPort,
        },
        health: { path: '/' },
      });
    },
    discoverRoutes: options.discoverRoutes ?? (() => Promise.resolve([])),
    proposeTests(): Promise<TestPlan> {
      return Promise.resolve(TestPlanSchema.parse({ tests: [] }));
    },
    proposeInstrumentation(): Promise<InstrumentationPlan> {
      return Promise.resolve(InstrumentationPlanSchema.parse({ steps: [] }));
    },
    proposeDeployment(): Promise<DeploymentPlan | null> {
      if (options.deploymentProvider === null) return Promise.resolve(null);
      return Promise.resolve(
        DeploymentPlanSchema.parse({
          providerId: options.deploymentProvider,
          rationale:
            options.deploymentProvider === 'vercel'
              ? `${options.id} produces a Vercel-compatible web build.`
              : `${options.id} requires a long-lived container runtime.`,
          requiredEnvVars: [],
        }),
      );
    },
  };
}

function dynamic(path: string): boolean {
  return /\[[^\]]+\]|:[^/]+/u.test(path);
}

function pagePath(segments: readonly string[]): string {
  const joined = segments.filter((segment) => segment.length > 0 && segment !== 'index').join('/');
  return joined.length === 0 ? '/' : `/${joined}`;
}

export async function discoverNextRoutes(ctx: ProjectContext): Promise<Route[]> {
  const routes: Route[] = [];
  for (const sourceFile of await files(ctx)) {
    const app = /^app\/(.*\/)?(page|route)\.[cm]?[jt]sx?$/u.exec(sourceFile);
    if (app !== null) {
      const segments = (app[1] ?? '').split('/').filter(Boolean);
      const isApi = app[2] === 'route' || segments[0] === 'api';
      const path = pagePath(segments);
      routes.push(RouteSchema.parse({ path, kind: isApi ? 'api' : 'page', dynamic: dynamic(path), sourceFile }));
      continue;
    }
    const pages = /^pages\/(.+)\.[cm]?[jt]sx?$/u.exec(sourceFile);
    if (pages !== null && !pages[1]?.startsWith('_')) {
      const segments = (pages[1] ?? '').split('/');
      const isApi = segments[0] === 'api';
      const path = pagePath(segments);
      routes.push(RouteSchema.parse({ path, kind: isApi ? 'api' : 'page', dynamic: dynamic(path), sourceFile }));
    }
  }
  return routes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function discoverSvelteKitRoutes(ctx: ProjectContext): Promise<Route[]> {
  const routes = (await files(ctx))
    .filter((path) => /^src\/routes\/(.*\/)?\+page\.(svelte|[jt]s)$/u.test(path))
    .map((sourceFile) => {
      const path = pagePath(sourceFile.slice('src/routes/'.length).split('/').slice(0, -1));
      return RouteSchema.parse({ path, kind: 'page', dynamic: dynamic(path), sourceFile });
    });
  return routes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function discoverAstroRoutes(ctx: ProjectContext): Promise<Route[]> {
  const routes = (await files(ctx))
    .filter((path) => /^src\/pages\/.+\.(astro|md|mdx|[jt]sx?)$/u.test(path))
    .map((sourceFile) => {
      const relative = sourceFile.slice('src/pages/'.length).replace(/\.(astro|md|mdx|[jt]sx?)$/u, '');
      const path = pagePath(relative.split('/'));
      return RouteSchema.parse({ path, kind: 'page', dynamic: dynamic(path), sourceFile });
    });
  return routes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function discoverNuxtRoutes(ctx: ProjectContext): Promise<Route[]> {
  const routes = (await files(ctx))
    .filter((path) => /^pages\/.+\.vue$/u.test(path))
    .map((sourceFile) => {
      const path = pagePath(sourceFile.slice('pages/'.length).replace(/\.vue$/u, '').split('/'));
      return RouteSchema.parse({ path, kind: 'page', dynamic: dynamic(path), sourceFile });
    });
  return routes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function discoverReactRouterRoutes(ctx: ProjectContext): Promise<Route[]> {
  const routes: Route[] = [];
  for (const sourceFile of (await files(ctx)).filter((path) => /\.[jt]sx$/u.test(path))) {
    const source = await ctx.readFile(sourceFile);
    const pattern = /<Route\b[^>]*\bpath\s*=\s*["']([^"']+)["']/gu;
    for (const match of source.matchAll(pattern)) {
      const path = match[1];
      if (path === undefined || !path.startsWith('/')) continue;
      routes.push(RouteSchema.parse({ path, kind: 'page', dynamic: dynamic(path), sourceFile }));
    }
  }
  return routes.sort((left, right) => left.path.localeCompare(right.path));
}
