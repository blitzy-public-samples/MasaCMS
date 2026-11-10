// Test runner configuration for the migration orchestrator and service.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Vitest 5 removed poolOptions; multiple forks are the forks default, so singleFork is not set.
    pool: 'forks',
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { statements: 90 },
    },
  },
});
