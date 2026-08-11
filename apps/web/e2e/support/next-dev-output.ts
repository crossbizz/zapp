import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const webAppDirectory = fileURLToPath(new URL('../../', import.meta.url));
export const defaultNextDevOutputDirectory = resolve(webAppDirectory, '.next');

export async function resetNextDevOutput(
  nextOutputDirectory = defaultNextDevOutputDirectory,
): Promise<void> {
  await rm(nextOutputDirectory, { recursive: true, force: true });
}
