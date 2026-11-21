// Oracle and full-stack suites under e2e/, run serially against the one running stack; results go to the state dir.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const stateDir = path.resolve(process.env.OPT2_STATE_DIR || path.join(os.homedir(), '.opt2', 'state'));
if (stateDir === repoRoot || stateDir.startsWith(repoRoot + path.sep)) {
  throw new Error(`OPT2_STATE_DIR must be outside the repository checkout ${repoRoot}, got ${stateDir}`);
}

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts', 'e2e/**/*.e2e.ts'],
    exclude: ['test/**', 'node_modules/**'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    coverage: { enabled: false },
    reporters: ['default', 'json'],
    outputFile: { json: path.join(stateDir, 'e2e', 'results.json') },
  },
});
