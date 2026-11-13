// Test runner configuration for the OPT-2 admin front end.
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // `unit` needs no network; `integration` holds the loopback transport tests.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/integration/**'],
        },
      },
      { extends: true, test: { name: 'integration', include: ['test/integration/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'app/**/route.ts'],
      // generate.ts is a build-time CLI.
      exclude: ['src/generated/**', 'src/lib/resource-bundles/generate.ts'],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { statements: 90 },
    },
  },
});
