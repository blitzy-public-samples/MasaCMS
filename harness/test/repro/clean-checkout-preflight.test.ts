// Unit suite for the OPT2_CLONE_PARENT preconditions of clean-checkout-proof.sh, run from a sandbox copy with a stub down.sh.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoPath } from '../../src/lib/paths.js';

const REPRO_DIR = repoPath('harness/repro');
// Variables a calling OPT-2 command may export that would point the sandbox run at another lock, port file or report.
const INHERITED = [
  'OPT2_LOCK_FLOCK_HELD',
  'OPT2_LOCK_WAIT',
  'OPT2_REPORTS_DIR',
  'OPT2_COMMON_SH_LOADED',
  'OPT2_PORTS_FILE',
];

interface Result {
  status: number | null;
  stderr: string;
}

let root: string;
let checkout: string;

beforeEach(() => {
  root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'opt2-clean-preflight-'));
  checkout = path.join(root, 'checkout');
  mkdirSync(path.join(checkout, 'harness/repro/lib'), { recursive: true });
  mkdirSync(path.join(checkout, 'opt2'));
  mkdirSync(path.join(root, 'home'));
  for (const file of ['clean-checkout-proof.sh', 'ports.env']) {
    copyFileSync(path.join(REPRO_DIR, file), path.join(checkout, 'harness/repro', file));
  }
  for (const file of readdirSync(path.join(REPRO_DIR, 'lib')).filter((name) => name.endsWith('.sh'))) {
    copyFileSync(path.join(REPRO_DIR, 'lib', file), path.join(checkout, 'harness/repro/lib', file));
  }
  copyFileSync(repoPath('opt2/source-pin.json'), path.join(checkout, 'opt2/source-pin.json'));
  const down = path.join(checkout, 'harness/repro/down.sh');
  writeFileSync(down, `#!/usr/bin/env bash\ntouch '${marker()}'\n`);
  chmodSync(down, 0o755);
  writeFileSync(path.join(root, 'parent-file'), 'fixture\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const marker = (): string => path.join(root, 'down-ran');

/** Runs the sandbox's clean-checkout-proof.sh with OPT2_CLONE_PARENT=<parent> and a private HOME, state and lock. */
function prove(parent: string): Result {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'home'),
    OPT2_STATE_DIR: path.join(root, 'state'),
    OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
    OPT2_LOCK_DIR: path.join(root, 'lock'),
    OPT2_CF_SERVER_NAME: 'opt2-preflight-test',
    OPT2_CLONE_PARENT: parent,
    // Keeps git from finding a repository above the sandbox, so the run stops at `git rev-parse` after step 1.
    GIT_CEILING_DIRECTORIES: root,
  };
  for (const name of INHERITED) delete env[name];
  const result = spawnSync('bash', [path.join(checkout, 'harness/repro/clean-checkout-proof.sh')], {
    cwd: checkout,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('clean-checkout-proof.sh OPT2_CLONE_PARENT preconditions', () => {
  it.each([
    { label: 'a relative path', parent: (): string => 'opt2-proofs', reason: (): string => 'must be an absolute path' },
    {
      label: 'a path inside the checkout',
      parent: (): string => path.join(checkout, 'proofs'),
      reason: (): string => `resolves inside the checkout ${checkout}`,
    },
    {
      label: 'a path with a directory named mura',
      parent: (): string => path.join(root, 'mura', 'proofs'),
      reason: (): string => 'resolves to a path with a directory named mura',
    },
    {
      label: 'an existing regular file',
      parent: (): string => path.join(root, 'parent-file'),
      reason: (): string => `${path.join(root, 'parent-file')} is not a writable directory`,
    },
    {
      label: 'a path below a regular file',
      parent: (): string => path.join(root, 'parent-file', 'below'),
      reason: (): string => `${path.join(root, 'parent-file')} is not a writable directory`,
    },
  ])('rejects $label before the step 1 teardown', ({ parent, reason }) => {
    const result = prove(parent());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OPT2_CLONE_PARENT');
    expect(result.stderr).toContain(reason());
    expect(result.stderr).not.toContain('step 1:');
    expect(existsSync(marker())).toBe(false);
  });

  it('reaches the step 1 teardown for a path not yet created below a writable directory', () => {
    const result = prove(path.join(root, 'proofs', 'new'));
    expect(result.stderr).toMatch(/step 1: harness\/repro\/down\.sh in the working checkout/);
    expect(existsSync(marker())).toBe(true);
  });
});
