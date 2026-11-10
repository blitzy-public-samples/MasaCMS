// Test runner configuration for @opt2/platform.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', '**/*.d.ts'],
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
      thresholds: { statements: 90 },
    },
  },
});
