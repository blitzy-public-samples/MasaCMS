import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { repoPath } from '../../src/lib/paths.js';

/** Physical checkout root, as common.sh resolves REPO with `pwd -P`. */
const REPO = realpathSync(repoPath());
/** Sources the real libraries and runs `_ck_restore <args…>`. */
const RESTORE =
  'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; source "$1/harness/repro/lib/processes.sh"; ' +
  'source "$1/harness/repro/lib/checkpoint.sh"; _ck_restore "${@:2}"';
/** Stand-in pg_restore: `-l` prints toc.txt; a restore logs its argv and fails with error.txt while it is within `fails`. */
const FAKE_PG_RESTORE = [
  '#!/usr/bin/env bash',
  'dir=${0%/*}',
  'if [[ $1 == -l ]]; then exec cat -- "$dir/toc.txt"; fi',
  'printf "%s\\n" "$*" >>"$dir/restores.log"',
  'if (($(wc -l <"$dir/restores.log") <= $(cat -- "$dir/fails"))); then cat -- "$dir/error.txt" >&2; exit 1; fi',
  '',
].join('\n');
/** Stand-in sleep: logs its argument and returns at once. */
const FAKE_SLEEP = ['#!/usr/bin/env bash', 'printf "%s\\n" "$1" >>"${0%/*}/sleeps.log"', ''].join('\n');
/** `pg_restore -l` of a gateway-schema dump. */
const TOC = [
  ';',
  '; Archive created at 2026-11-17 13:30:00 UTC',
  ';',
  '6; 2615 30193733 SCHEMA - gateway synthetic_user',
  '216; 1259 30193734 TABLE gateway cutover_state synthetic_user',
  '217; 1259 30193741 TABLE gateway instance synthetic_user',
  '3454; 0 30193734 TABLE DATA gateway cutover_state synthetic_user',
  '3455; 0 30193741 TABLE DATA gateway instance synthetic_user',
  '3307; 2606 30193740 CONSTRAINT gateway cutover_state cutover_state_pkey synthetic_user',
  '3310; 2606 30193747 CONSTRAINT gateway instance instance_pkey synthetic_user',
  '3308; 1259 30193748 INDEX gateway instance_heartbeat_idx synthetic_user',
  '',
].join('\n');
/** PostgreSQL 16 pg_restore output when the gateway heartbeat's lock cycle aborts the --clean restore. */
const DEADLOCK = [
  'pg_restore: connecting to database for restore',
  'pg_restore: dropping INDEX instance_heartbeat_idx',
  'pg_restore: dropping CONSTRAINT instance instance_pkey',
  'pg_restore: dropping CONSTRAINT cutover_state cutover_state_pkey',
  'pg_restore: while PROCESSING TOC:',
  'pg_restore: from TOC entry 3307; 2606 30193740 CONSTRAINT cutover_state cutover_state_pkey synthetic_user',
  'pg_restore: error: could not execute query: ERROR:  deadlock detected',
  'DETAIL:  Process 2938834 waits for AccessExclusiveLock on relation 30193734 of database 30193732; blocked by process 2938831.',
  'Process 2938831 waits for RowExclusiveLock on relation 30193741 of database 30193732; blocked by process 2938834.',
  'HINT:  See server log for query details.',
  'Command was: ALTER TABLE IF EXISTS ONLY gateway.cutover_state DROP CONSTRAINT IF EXISTS cutover_state_pkey;',
  '',
].join('\n');
/** PostgreSQL 16 pg_restore output when a restored row collides with one already present. */
const UNIQUE_VIOLATION = [
  'pg_restore: processing data for table "gateway.instance"',
  'pg_restore: while PROCESSING TOC:',
  'pg_restore: from TOC entry 3455; 0 30193741 TABLE DATA instance synthetic_user',
  'pg_restore: error: COPY failed for table "instance": ERROR:  duplicate key value violates unique constraint "instance_pkey"',
  'DETAIL:  Key (instance_id)=(synthetic-instance) already exists.',
  'CONTEXT:  COPY instance, line 1',
  '',
].join('\n');
const SINGLE = ['--clean', '--if-exists', '--single-transaction', '--exit-on-error'];
const RUN_TIMEOUT_MS = 20_000;

interface Restore {
  status: number | null;
  stderr: string;
  /** The argv of each restore the fake pg_restore ran. */
  restores: string[];
  /** The argument of each sleep. */
  sleeps: string[];
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Lines of <file>; empty when it does not exist. */
function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n') : [];
}

/** Runs `_ck_restore - <dump> <args…>` with a fake pg_restore whose first `fails` restores print `error`. */
function restore(error: string, fails: number, args: string[]): Restore & { dump: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opt2-checkpoint-restore-test-'));
  tempDirs.push(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [
    ['pg_restore', FAKE_PG_RESTORE],
    ['sleep', FAKE_SLEEP],
  ] as const) {
    writeFileSync(path.join(bin, name), text);
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(path.join(bin, 'toc.txt'), TOC);
  writeFileSync(path.join(bin, 'error.txt'), error);
  writeFileSync(path.join(bin, 'fails'), `${fails}\n`);
  const dump = path.join(root, 'state', 'checkpoint', 'target.dump');
  const run = spawnSync('bash', ['-c', RESTORE, 'checkpoint-restore-test', REPO, '-', dump, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: path.join(root, 'home'),
      OPT2_STATE_DIR: path.join(root, 'state'),
      OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
      PG_HOST: '127.0.0.1',
      PG_PORT: '15432',
      PG_USER: 'synthetic_user',
      PG_PASSWORD: ['synthetic', 'pg', 'value'].join('-'),
      PG_DATABASE: 'synthetic_services',
    },
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return {
    status: run.status,
    stderr: run.stderr,
    restores: lines(path.join(bin, 'restores.log')),
    sleeps: lines(path.join(bin, 'sleeps.log')),
    dump,
  };
}

/** The line _ck_restore prints before attempt <next> of 5, after a <delay>-second backoff. */
const retryLine = (dump: string, next: number, delay: number): string =>
  `opt2: pg_restore of ${dump} rolled back after a deadlock (sqlstate 40P01); attempt ${next} of 5 in ${delay}s`;

describe('_ck_restore (harness/repro/lib/checkpoint.sh)', () => {
  it('repeats a single-transaction restore a deadlock aborted, reporting each retry, until an attempt succeeds', () => {
    const run = restore(DEADLOCK, 2, SINGLE);

    expect(run.status, run.stderr).toBe(0);
    const argv = `-h 127.0.0.1 -p 15432 -U synthetic_user -d synthetic_services --verbose ${SINGLE.join(' ')} ${run.dump}`;
    expect(run.restores).toEqual([argv, argv, argv]);
    expect(run.sleeps).toEqual(['1', '2']);
    expect(run.stderr.trimEnd().split('\n')).toEqual([retryLine(run.dump, 2, 1), retryLine(run.dump, 3, 2)]);
  });

  it('gives up after the fifth deadlocked attempt, naming sqlstate 40P01 and the failing entry', () => {
    const run = restore(DEADLOCK, 99, SINGLE);

    expect(run.status).toBe(1);
    expect(run.restores).toHaveLength(5);
    expect(run.sleeps).toEqual(['1', '2', '4', '8']);
    expect(run.stderr.trimEnd().split('\n')).toEqual([
      retryLine(run.dump, 2, 1),
      retryLine(run.dump, 3, 2),
      retryLine(run.dump, 4, 4),
      retryLine(run.dump, 5, 8),
      `opt2: pg_restore of ${run.dump} failed (exit 1), CONSTRAINT gateway.cutover_state cutover_state_pkey, sqlstate 40P01`,
    ]);
  });

  it.each<[string, string, string[], string]>([
    ['a unique violation', UNIQUE_VIOLATION, SINGLE, 'TABLE DATA gateway.instance, sqlstate 23505'],
    [
      'a deadlock outside a single transaction',
      DEADLOCK,
      ['--clean', '--if-exists', '--exit-on-error'],
      'CONSTRAINT gateway.cutover_state cutover_state_pkey, sqlstate 40P01',
    ],
  ])('dies at once on %s, without a retry or any row of the error', (_label, error, args, named) => {
    const run = restore(error, 99, args);

    expect(run.status).toBe(1);
    expect(run.restores).toHaveLength(1);
    expect(run.sleeps).toEqual([]);
    expect(run.stderr).toBe(`opt2: pg_restore of ${run.dump} failed (exit 1), ${named}\n`);
  });
});
