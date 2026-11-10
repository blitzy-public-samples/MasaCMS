// Test runner configuration for the OPT-2 admin front end.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'app/**/route.ts'],
      // .tsx page/layout adapters need the Next request scope; generate.ts is a build-time CLI.
      exclude: ['src/generated/**', '**/*.tsx', 'src/lib/resource-bundles/generate.ts'],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { statements: 90 },
    },
  },
});
