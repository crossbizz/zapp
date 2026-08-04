import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Rules are plain `.mjs` (ESLint loads them from the flat config, which is not
    // compiled), so the tests are `.mjs` too.
    include: ['test/**/*.test.mjs'],
  },
});
