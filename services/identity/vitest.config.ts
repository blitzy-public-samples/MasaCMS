// Test runner configuration for the identity service.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/throwaway-sweep.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
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
