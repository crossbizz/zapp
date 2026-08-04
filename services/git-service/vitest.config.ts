import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root-relative rather than `test/**`, for the same reason as @zapp/db and
    // @zapp/control-api: `vitest run --dir test/integration` (the
    // `test:integration` script) resolves include patterns against `--dir`, so a
    // `test/`-anchored pattern would silently match nothing there. The exclude is
    // what keeps the Forgejo-gated suites out of the default run.
    include: ['**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/integration/**'],
  },
});
