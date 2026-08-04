// @ts-check
import tseslint from 'typescript-eslint';

// Imported by relative path, not by package name: a flat config is loaded before any
// workspace linking matters, and this file is linted without type information anyway.
import noDyadProImports from './packages/eslint-rules/src/no-dyad-pro-imports.mjs';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**'],
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
    // Config files sit outside every package's tsconfig `include`, so the project
    // service cannot type them. Lint them without type information instead.
    files: ['**/*.{js,cjs,mjs}', '**/*.config.{ts,mts,cts}', 'vitest.workspace.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
  },
);
