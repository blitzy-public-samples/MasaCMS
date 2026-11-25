// Unit suite for the OPT2_CLONE_PARENT preconditions and the report of clean-checkout-proof.sh, run from a sandbox copy
// with stub up.sh, test-all.sh and down.sh.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

/** Writes an executable script at `rel` under the sandbox checkout. */
function script(rel: string, body: string): void {
  const file = path.join(checkout, rel);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}`);
  chmodSync(file, 0o755);
}

/** Runs git in the sandbox checkout with a fixed identity and no repository above the sandbox. */
function git(...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=opt2-test', '-c', 'user.email=opt2-test@example.invalid', ...args], {
    cwd: checkout,
    env: { ...process.env, HOME: path.join(root, 'home'), GIT_CEILING_DIRECTORIES: root },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('clean-checkout-proof.sh report', () => {
  it('records the clone, its state and the pristine directory as labels, never as host paths', () => {
    // The clone's stub up.sh reports fixtures unavailable and its test-all.sh exits 2, which is a passing proof.
    script(
      'harness/repro/up.sh',
      `mkdir -p "$OPT2_STATE_DIR"\nprintf '{"available":false,"reason":"stub"}\\n' >"$OPT2_STATE_DIR/fixtures.json"\n`,
    );
    script('harness/repro/test-all.sh', `printf '{"exitCode":2}\\n' >opt2/reports/test-all.json\nexit 2\n`);
    mkdirSync(path.join(checkout, 'opt2/reports'));
    writeFileSync(path.join(checkout, 'opt2/reports/test-all.json'), '{}\n');
    git('init', '--quiet');
    git('add', '--all');
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'sandbox');
    const commit = git('rev-parse', 'HEAD');

    const result = prove(path.join(root, 'proofs'));

    expect(result.status, result.stderr).toBe(0);
    const report = readFileSync(path.join(checkout, 'opt2/reports/reproducibility.md'), 'utf8');
    const table = report.slice(report.indexOf('## Result'), report.indexOf('## Procedure'));
    // `| <field> | <value> |` rows of the Result table, by field.
    const values = new Map(
      table
        .split('\n')
        .filter((line) => line.startsWith('| ') && !line.startsWith('| Field '))
        .map((line) => line.slice(2, -2).split(' | ') as [string, string]),
    );
    const value = (prefix: string): string | undefined =>
      [...values].find(([field]) => field.startsWith(prefix))?.[1];
    const clone = value('Clone path');
    expect(clone).toMatch(/^`\$OPT2_CLONE_PARENT\/opt2-clean-\d{8}T\d{6}Z`$/);
    expect(value('`OPT2_STATE_DIR`')).toBe(`${clone?.slice(0, -1) ?? ''}.state\``);
    expect(value('`OPT2_PRISTINE_DIR`')).toBe('`$OPT2_PRISTINE_DIR`');
    expect(value('Commit')).toBe(`\`${commit}\``);
    expect(value('`sha256`')).toMatch(/^`[0-9a-f]{64}`$/);
    expect([...values.values()].filter((cell) => cell.startsWith('`/'))).toStrictEqual([]);
    expect(report).toContain('Status: pass');
    expect(report).not.toContain(root);
  });
});
