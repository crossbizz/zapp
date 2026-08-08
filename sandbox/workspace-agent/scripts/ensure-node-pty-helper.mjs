import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const nodePtyRoot = resolve(dirname(require.resolve('node-pty')), '..');
  const candidates = [
    join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
  ];
  let found = false;

  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      await chmod(candidate, metadata.mode | 0o111);
      found = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (!found) {
    throw new Error('node-pty spawn-helper is missing for macOS');
  }
}
