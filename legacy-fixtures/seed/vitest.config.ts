// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { statements: 90 },
    },
  },
});
