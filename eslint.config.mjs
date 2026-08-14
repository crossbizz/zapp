// @ts-check
import tseslint from 'typescript-eslint';

// Imported by relative path, not by package name: a flat config is loaded before any
// workspace linking matters, and this file is linted without type information anyway.
import noDyadProImports from './packages/eslint-rules/src/no-dyad-pro-imports.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.next-e2e-*/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Playwright owns and replaces these directories while E2E tests run;
      // lint must not race generated artifacts in the parallel Turbo DAG.
      '**/test-results/**',
      '**/playwright-report/**',
      // The OpenAPI generator owns this artifact; its source Zod schema is linted.
      'packages/api-client/src/generated.ts',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Local rules live in @zapp/eslint-rules and are registered as an inline plugin
    // object -- flat config needs no plugin package, and the rules stay unit-tested
    // (packages/eslint-rules/test) rather than being trusted by inspection.
    plugins: {
      zapp: {
        rules: {
          'no-dyad-pro-imports': noDyadProImports,
        },
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'error',
      // Master plan global constraint 17: no zapp code imports Dyad `src/pro`, which
      // is FSL-1.1 rather than Apache-2.0 (NOTICE, docs/adr/0002-dyad-fork.md).
      // This covers everything the root config lints; the vendored `apps/desktop` tree
      // is not in the root lint graph, so the `license-boundary` job in
      // .github/workflows/security.yml greps it instead. Both halves are required.
      'zapp/no-dyad-pro-imports': 'error',
    },
  },
  {
    // Tenant isolation is enforced by the request-scoped `ctx.db` handle from
    // CP-4's tenant plugin, which puts `organization_id` in every WHERE clause
    // itself. A route module that reaches for the raw db handle or the unscoped
    // schema bypasses that entirely, so the import is banned rather than left to
    // per-handler discipline. This is the recursive, resolver-aware half of the
    // guard; services/control-api/test/route-isolation.test.ts is the belt that
    // also covers dynamic imports.
    files: ['services/*/src/routes/**/*.ts', 'services/*/src/events/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@zapp/db',
              message:
                'Route modules must query through the request-scoped ctx.db (tenant plugin), never the raw db handle. See CP-4.',
            },
          ],
        },
      ],
    },
  },
  {
    // Config files sit outside every package's tsconfig `include`, so the project
    // service cannot type them. Lint them without type information instead.
    files: ['**/*.{js,cjs,mjs}', '**/*.config.{ts,mts,cts}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
  },
);
