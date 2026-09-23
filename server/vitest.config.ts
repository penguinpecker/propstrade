import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],   // src/modules/**/*.test.ts use node:test (npm run test:modules)
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
