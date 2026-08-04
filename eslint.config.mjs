// @ts-check
import tseslint from 'typescript-eslint';

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
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'error',
      // FND-9 will register the local plugin here and turn on the rule that bans
      // importing from `src/pro` outside pro-licensed code:
      //   plugins: { zapp: zappPlugin },
      //   rules: { 'zapp/no-pro-import': 'error' },
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
