import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function desktopWorkflow(): Promise<string> {
  return readFile(resolve(repositoryRoot, '.github/workflows/desktop.yml'), 'utf8');
}

describe('desktop CI workflow', () => {
  it('runs the complete desktop unit and Playwright suites for pull requests', async () => {
    const workflow = await desktopWorkflow();

    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).toMatch(/^\s*desktop-unit:\s*$/m);
    expect(workflow).toMatch(/^\s*desktop-e2e:\s*$/m);
    expect(workflow).toContain('pnpm --filter @zapp/desktop run test:unit');
    expect(workflow).toContain('shard: [1/4, 2/4, 3/4, 4/4]');
    const shardCommand = 'pnpm --filter @zapp/desktop run e2e:shard ${{ matrix.shard }}';
    expect(workflow).toContain(shardCommand);
    expect(
      ['1/4', '2/4', '3/4', '4/4'].map((shard) =>
        shardCommand.replace('${{ matrix.shard }}', shard),
      ),
    ).toEqual([
      'pnpm --filter @zapp/desktop run e2e:shard 1/4',
      'pnpm --filter @zapp/desktop run e2e:shard 2/4',
      'pnpm --filter @zapp/desktop run e2e:shard 3/4',
      'pnpm --filter @zapp/desktop run e2e:shard 4/4',
    ]);
    expect(workflow).toContain("PLAYWRIGHT_RETRIES: '0'");
    expect(workflow).not.toContain('run test:preserve\n');
  });

  it('keeps release packaging and failure reports alongside the PR suites', async () => {
    const workflow = await desktopWorkflow();

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toMatch(/^\s*package-macos:\s*$/m);
    expect(workflow).toContain('ZAPP_MACOS_SIGN');
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain('actions/upload-artifact@v5');
  });
});
