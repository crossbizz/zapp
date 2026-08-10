import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newId, type DetectionContext } from '@zapp/contracts';
import { describe, expect, test } from 'vitest';

import {
  CapabilityScanInputSchema,
  capabilityScanActivityIdempotencyKey,
  scanProjectCapabilities,
} from '../../src/scan.js';

const fixture = fileURLToPath(new URL('../fixtures/scan-next-supabase', import.meta.url));

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

function fixtureContext(): DetectionContext {
  return {
    workspaceRoot: '.',
    listFiles: async () => await allFiles(fixture),
    readFile: async (path) => await readFile(join(fixture, path), 'utf8'),
  };
}

describe('VF-3 capability scan activity', () => {
  test('derives the activity fence from type and tenant scope instead of the caller key', () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const branchId = newId('br');
    const scanId = 'same-client-key-0001';
    const input = {
      scanId,
      idempotencyKey: capabilityScanActivityIdempotencyKey({
        organizationId,
        projectId,
        scanId,
      }),
      organizationId,
      projectId,
      branchId,
      branchName: 'main',
      workspaceId: newId('ws'),
      runId: newId('run'),
      taskId: newId('task'),
      workspaceCreatedAt: '2026-08-10T00:00:00.000Z',
    };

    expect(CapabilityScanInputSchema.parse(input).idempotencyKey).toBe(
      `capability-scan:${organizationId}:${projectId}:${scanId}`,
    );
    expect(
      capabilityScanActivityIdempotencyKey({
        organizationId: newId('org'),
        projectId,
        scanId,
      }),
    ).not.toBe(input.idempotencyKey);
    expect(
      CapabilityScanInputSchema.safeParse({ ...input, idempotencyKey: scanId }).success,
    ).toBe(false);
  });

  test('derives a Next + Supabase contract and a support report from workspace evidence', async () => {
    const result = await scanProjectCapabilities(fixtureContext());

    expect(result).toMatchObject({
      supportLevel: 'compatible',
      verifiedEligible: true,
      detectedFramework: 'next',
      database: { provider: 'supabase' },
      auth: { provider: 'supabase' },
      deployment: { provider: 'vercel' },
      tests: { unit: true, integration: true, browser: true },
      observability: ['posthog', 'sentry'],
      reportCard: {
        missingCapabilities: [],
        hardenProjectInput: [],
      },
    });
    expect(result.contract).toMatchObject({
      version: 1,
      package_manager: 'pnpm',
      workspace_root: '.',
      develop: { command: 'pnpm run dev', port: 3000 },
      build: { command: 'pnpm run build' },
      typecheck: { command: 'pnpm run typecheck' },
      test: {
        unit: 'pnpm run test',
        integration: 'pnpm run test:integration',
        browser: 'pnpm run test:browser',
      },
    });
    expect(result.detections[0]).toMatchObject({ adapterId: 'next' });
    expect(result.reportCard.evidence).toEqual(
      expect.arrayContaining([
        'next.config.mjs',
        'supabase/config.toml',
        'vercel.json',
        'package.json#scripts.test:integration',
      ]),
    );
  });

  test.each([
    ['npm', 'package-lock.json', 'npm run'],
    ['bun', 'bun.lockb', 'bun run'],
  ] as const)('emits valid %s commands for named test scripts', async (manager, lock, prefix) => {
    const manifest = JSON.stringify({
      name: `${manager}-fixture`,
      scripts: {
        build: 'build',
        typecheck: 'tsc --noEmit',
        test: 'unit',
        'test:integration': 'integration',
        'test:browser': 'browser',
      },
    });
    const files = new Set(['package.json', lock]);
    const result = await scanProjectCapabilities({
      workspaceRoot: '.',
      listFiles: () => Promise.resolve([...files]),
      readFile: (path) => Promise.resolve(path === 'package.json' ? manifest : ''),
    });

    expect(result.contract.test).toEqual({
      unit: `${prefix} test`,
      integration: `${prefix} test:integration`,
      browser: `${prefix} test:browser`,
    });
  });
});
