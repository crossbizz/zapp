import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The root aggregator for `vitest` run from the repository root. Each package
// and service still owns its own `vitest.config.ts` — this only points at them,
// and `turbo run test` never reads this file (it runs `vitest run` inside each
// package, where that package's own config is the one that resolves).
//
// This replaces the former `vitest.workspace.ts` / `defineWorkspace()`. Vitest
// 3.2 deprecates the separate workspace file in favour of `test.projects` in the
// root config and removes it in the next major; the glob list is carried over
// unchanged, so the set of projects is identical.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'security',
          include: ['test/security/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'release-transport',
          include: ['test/integration/release-transport.test.ts'],
        },
      },
      {
        resolve: {
          alias: {
            '@zapp/release-service/lifecycle': fileURLToPath(
              new URL('./services/release-service/src/lifecycle.ts', import.meta.url),
            ),
            '@zapp/release-service/records': fileURLToPath(
              new URL('./services/release-service/src/release/create.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'release-e2e',
          include: ['test/integration/release-e2e.test.ts'],
        },
      },
      'packages/*/vitest.config.ts',
      'services/*/vitest.config.ts',
      'infra/*/vitest.config.ts',
    ],
  },
});
