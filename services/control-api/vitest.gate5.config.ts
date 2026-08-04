import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/gate5/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
  },
});
