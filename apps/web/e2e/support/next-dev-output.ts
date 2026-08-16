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
