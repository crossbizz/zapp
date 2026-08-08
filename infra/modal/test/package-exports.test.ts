import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const modalInfraRoot = resolve(testDirectory, '..');
const sandboxServiceRoot = resolve(testDirectory, '../../../services/sandbox-service');

const ExportTargetSchema = z.object({
  types: z.string().startsWith('./'),
  default: z.string().startsWith('./'),
});
const PackageSchema = z.object({
  exports: z.record(ExportTargetSchema),
});

describe('sandbox-service package exports', () => {
  it('resolves every declared target and both public imports after a clean dependency build', async () => {
    const packageJson = PackageSchema.parse(
      JSON.parse(await readFile(resolve(sandboxServiceRoot, 'package.json'), 'utf8')),
    );
    expect(Object.keys(packageJson.exports)).toEqual(
      expect.arrayContaining(['./provider/modal', './provider-types']),
    );
    const targets = Object.values(packageJson.exports).flatMap((entry) => [
      entry.types,
      entry.default,
    ]);

    await Promise.all(
      targets.map(async (target) => access(resolve(sandboxServiceRoot, target))),
    );

    const probe = [
      "const modal = await import('@zapp/sandbox-service/provider/modal');",
      "const types = await import('@zapp/sandbox-service/provider-types');",
      "if (typeof modal.createModalImagePublisher !== 'function') process.exit(2);",
      "if (typeof types.ImageRecipeSchema?.parse !== 'function') process.exit(3);",
    ].join('\n');
    await expect(
      execFileAsync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: modalInfraRoot,
      }),
    ).resolves.toMatchObject({ stderr: '' });
  });
});
