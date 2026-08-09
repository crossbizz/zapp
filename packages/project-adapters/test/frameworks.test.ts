import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DetectionContext, ProjectContext } from '@zapp/contracts';
import { describe, expect, test } from 'vitest';

import {
  astroAdapter,
  capacitorAdapter,
  expressFastifyAdapter,
  nestAdapter,
  nextAdapter,
  nuxtAdapter,
  reactAdapter,
  svelteKitAdapter,
  viteAdapter,
} from '../src/frameworks.js';
import { detectProject } from '../src/detect.js';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

async function allFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? await allFiles(root, path) : [relative(root, path)];
    }),
  );
  return nested.flat().sort();
}

function context(name: string): DetectionContext {
  const root = join(fixtures, name);
  return {
    workspaceRoot: '.',
    listFiles: async () => await allFiles(root),
    readFile: async (path) => await readFile(join(root, path), 'utf8'),
  };
}

async function projectContext(
  fixture: string,
  adapter: { readonly id: string; detect(ctx: DetectionContext): Promise<unknown> },
): Promise<ProjectContext> {
  const ctx = context(fixture);
  return {
    ...ctx,
    detection: (await adapter.detect(ctx)) as ProjectContext['detection'],
  };
}

describe('VF-2 P0 framework adapters', () => {
  test.each([
    { fixture: 'framework-vite', adapter: viteAdapter, port: 5173, output: 'dist', provider: 'vercel' },
    { fixture: 'framework-react', adapter: reactAdapter, port: 3000, output: 'build', provider: 'vercel' },
    { fixture: 'framework-next', adapter: nextAdapter, port: 3000, output: '.next', provider: 'vercel' },
    { fixture: 'framework-nuxt', adapter: nuxtAdapter, port: 3000, output: '.output', provider: 'fly' },
    { fixture: 'framework-sveltekit', adapter: svelteKitAdapter, port: 5173, output: '.svelte-kit/output', provider: 'vercel' },
    { fixture: 'framework-astro', adapter: astroAdapter, port: 4321, output: 'dist', provider: 'vercel' },
    { fixture: 'framework-express', adapter: expressFastifyAdapter, port: 3000, output: null, provider: 'fly' },
    { fixture: 'framework-fastify', adapter: expressFastifyAdapter, port: 3000, output: null, provider: 'fly' },
    { fixture: 'framework-nest', adapter: nestAdapter, port: 3000, output: 'dist', provider: 'fly' },
  ])('derives $adapter.id fields from $fixture', async ({ fixture, adapter, port, output, provider }) => {
    const ctx = await projectContext(fixture, adapter);
    const detection = await adapter.detect(ctx);
    const contract = await adapter.deriveExecutionContract(ctx);

    expect(detection).toMatchObject({ adapterId: adapter.id });
    expect(detection.confidence).toBeGreaterThan(0);
    expect(contract.develop.port).toBe(port);
    expect(contract.health?.path).toBe('/');
    expect(adapter.buildOutput).toBe(output);
    await expect(adapter.proposeDeployment(ctx)).resolves.toMatchObject({ providerId: provider });
  });

  test.each([
    { fixture: 'framework-next', adapter: nextAdapter, expected: ['/', '/about', '/projects/[id]'] },
    { fixture: 'framework-sveltekit', adapter: svelteKitAdapter, expected: ['/', '/about', '/blog/[slug]'] },
    { fixture: 'framework-astro', adapter: astroAdapter, expected: ['/', '/about', '/posts/[slug]'] },
  ])('discovers framework routes for $fixture', async ({ fixture, adapter, expected }) => {
    const ctx = await projectContext(fixture, adapter);
    const routes = await adapter.discoverRoutes(ctx);

    expect(routes.filter(({ kind }) => kind === 'page').map(({ path }) => path)).toEqual(expected);
  });

  test('discovers static React Router paths without evaluating application code', async () => {
    const ctx = await projectContext('framework-vite', viteAdapter);
    await expect(viteAdapter.discoverRoutes(ctx)).resolves.toEqual([
      { path: '/', kind: 'page', dynamic: false, sourceFile: 'src/routes.tsx' },
      { path: '/settings', kind: 'page', dynamic: false, sourceFile: 'src/routes.tsx' },
    ]);
  });

  test.each([
    { fixture: 'framework-vite', winner: 'vite', outranks: 'react' },
    { fixture: 'framework-nest', winner: 'nest', outranks: 'express-fastify' },
  ])('ranks specialized $winner detection ahead of $outranks', async ({ fixture, winner, outranks }) => {
    const detections = await detectProject(context(fixture));
    const ids = detections.map(({ adapterId }) => adapterId);

    expect(ids.indexOf(winner)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(winner)).toBeLessThan(ids.indexOf(outranks));
  });

  test('preserves Next app-router and pages-router API paths', async () => {
    const ctx = await projectContext('framework-next', nextAdapter);
    const apiRoutes = (await nextAdapter.discoverRoutes(ctx)).filter(({ kind }) => kind === 'api');

    expect(apiRoutes).toEqual([
      { path: '/api/health', kind: 'api', dynamic: false, sourceFile: 'app/api/health/route.ts' },
      {
        path: '/api/users/[id]',
        kind: 'api',
        dynamic: true,
        sourceFile: 'pages/api/users/[id].ts',
      },
    ]);
  });

  test('detects Capacitor while preserving native folders and refusing store release support', async () => {
    const ctx = await projectContext('framework-capacitor', capacitorAdapter);

    await expect(capacitorAdapter.detect(ctx)).resolves.toMatchObject({
      adapterId: 'capacitor',
      confidence: 0.95,
      evidence: ['capacitor.config.ts'],
    });
    expect(capacitorAdapter.preservePaths).toEqual(['android', 'ios']);
    expect(capacitorAdapter.supportsStoreRelease).toBe(false);
    await expect(capacitorAdapter.proposeDeployment(ctx)).resolves.toBeNull();
  });
});
