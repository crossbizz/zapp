import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The include glob is deliberately root-relative rather than `test/**`:
    // `vitest run --dir test/integration` (the `test:integration` script)
    // resolves include patterns against `--dir`, so a `test/`-anchored pattern
    // would silently match nothing there. The exclude below is what keeps the
    // database-backed suite out of the plain `test` run.
    //
    // The `test:integration` script adds `--no-file-parallelism`: those suites
    // share one `*_test` database and truncate it between tests, so running two
    // files at once would have them deleting each other's fixtures.
    include: ['**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/integration/**'],
  },
});
