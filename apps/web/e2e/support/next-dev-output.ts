import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const webAppDirectory = fileURLToPath(new URL('../../', import.meta.url));
export const defaultNextDevOutputDirectory = resolve(webAppDirectory, '.next');

export function nextDevWatchEnvironment(): { readonly WATCHPACK_POLLING: 'true' } {
  return { WATCHPACK_POLLING: 'true' };
}

export function createNextDevOutputName(appPort: number): string {
  return `.next-e2e-${String(appPort)}-${randomUUID()}`;
}

export function nextE2ECommands(
  port: number,
): readonly [readonly ['build'], readonly ['start', '--port', string]] {
  return [['build'], ['start', '--port', String(port)]];
}

export async function resetNextDevOutput(
  nextOutputDirectory = defaultNextDevOutputDirectory,
): Promise<void> {
  await rm(nextOutputDirectory, { recursive: true, force: true });
}

export async function preserveNextGeneratedFiles(
  paths: readonly string[],
): Promise<() => Promise<void>> {
  const snapshots = await Promise.all(
    paths.map(async (path) => ({ path, contents: await readFile(path) })),
  );

  return async () => {
    await Promise.all(
      snapshots.map(async ({ path, contents }) => {
        await writeFile(path, contents);
      }),
    );
  };
}

interface PrepareNextGeneratedFilesInput {
  readonly nextEnvPath: string;
  readonly outputName: string;
  readonly tsconfigPath: string;
}

/**
 * Next rewrites next-env.d.ts and tsconfig.json when a non-default distDir is
 * first observed. Stage those generated references before the isolated E2E
 * build, then restore the tracked files during shutdown.
 */
export async function prepareNextGeneratedFiles(
  input: PrepareNextGeneratedFilesInput,
): Promise<() => Promise<void>> {
  const restore = await preserveNextGeneratedFiles([input.nextEnvPath, input.tsconfigPath]);
  const [nextEnv, tsconfigSource] = await Promise.all([
    readFile(input.nextEnvPath, 'utf8'),
    readFile(input.tsconfigPath, 'utf8'),
  ]);

  const routeReference = `/// <reference path="./${input.outputName}/types/routes.d.ts" />`;
  const nextEnvRoutePattern = /^\/\/\/ <reference path="\.\/\.next[^"]*\/types\/routes\.d\.ts" \/>$/mu;
  const preparedNextEnv = nextEnvRoutePattern.test(nextEnv)
    ? nextEnv.replace(nextEnvRoutePattern, routeReference)
    : `${nextEnv.trimEnd()}\n${routeReference}\n`;

  const parsed = JSON.parse(tsconfigSource) as { include?: unknown; [key: string]: unknown };
  const include = Array.isArray(parsed.include)
    ? parsed.include.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const sourceEntries = include.filter(
    (entry) => entry !== 'next-env.d.ts' && !/^\.next[^/]*\/types\/\*\*\/\*\.ts$/u.test(entry),
  );
  parsed.include = [
    ...sourceEntries,
    '.next-dev/types/**/*.ts',
    '.next/types/**/*.ts',
    'next-env.d.ts',
    `${input.outputName}/types/**/*.ts`,
  ];

  await Promise.all([
    writeFile(input.nextEnvPath, preparedNextEnv, 'utf8'),
    writeFile(input.tsconfigPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8'),
  ]);

  return restore;
}
