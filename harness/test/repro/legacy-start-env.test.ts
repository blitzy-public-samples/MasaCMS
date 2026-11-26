// Unit suite for the start command of legacy-start.sh start_server, driven by bash with a stub `box`.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../../src/lib/paths.js';

const LEGACY_START = readFileSync(repoPath('harness/repro/lib/legacy-start.sh'), 'utf8');
const LEGACY_PORT = '20180';
// $1 checkout, $2 start_server's source.
const START_SCRIPT = 'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; eval "$2"; start_server';

/** Synthetic value for `label`, assembled at run time so no credential-shaped literal sits in the source. */
const synthetic = (label: string): string => ['synthetic', label, 'value'].join('-');

// Appends the argv and environment of each call as one JSON line; serves as `box`.
const RECORDER = `
const fs = require("fs");
fs.appendFileSync(process.env.RECORDER_LOG, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n");
`;

interface Call {
  args: string[];
  env: Record<string, string>;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opt2-legacy-start-env-'));
  for (const dir of ['bin', 'home', 'pristine', 'state/secrets']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  const recorder = path.join(root, 'bin', 'recorder.cjs');
  writeFileSync(recorder, RECORDER);
  const box = path.join(root, 'bin', 'box');
  writeFileSync(box, `#!/usr/bin/env bash\nexec node "${recorder}" "$@"\n`);
  chmodSync(box, 0o755);
  for (const name of ['bridge-hmac-key', 'harness-diagnostic-key']) {
    writeFileSync(path.join(root, 'state', 'secrets', name), synthetic(name));
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The text of shell function `name` as `script` defines it, from its header to its closing brace. */
function shellFunction(script: string, name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(script);
  if (match === null) throw new Error(`no ${name}() defined`);
  return match[0];
}

/** Runs `script` in bash with the environment common.sh needs and `extra`. */
function bash(script: string, args: string[], extra: Record<string, string>): string {
  const env: Record<string, string> = {
    PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: path.join(root, 'home'),
    TZ: 'UTC',
    OPT2_STATE_DIR: path.join(root, 'state'),
    OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
    RECORDER_LOG: path.join(root, 'calls.log'),
    ...extra,
  };
  const result = spawnSync('bash', ['-c', script, 'legacy-start-env', REPO_ROOT, ...args], {
    encoding: 'utf8',
    env,
    timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** The one recorded call of the stub `box`. */
function onlyCall(): Call {
  const calls = readFileSync(path.join(root, 'calls.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Call);
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
}

describe('legacy-start.sh start_server', () => {
  it('starts ColdFusion with the OPT-2 start variables on the start command', () => {
    const serverJson = path.join(root, 'state', 'commandbox', 'server.json');
    bash(START_SCRIPT, [shellFunction(LEGACY_START, 'start_server')], {
      // The migration service's own PORT, with legacy's handed over as OPT2_LEGACY_PORT.
      PORT: '8102',
      OPT2_LEGACY_PORT: LEGACY_PORT,
      SERVER_JSON: serverJson,
    });
    const { args, env } = onlyCall();

    expect(args).toEqual(['server', 'start', `serverConfigFile=${serverJson}`, '--noSaveSettings']);
    expect(env).toMatchObject({
      PORT: LEGACY_PORT,
      MURA_PING: 'false',
      MURA_AUTODISCOVERPLUGINS: 'false',
      MURA_APPLYDBUPDATES: 'false',
      MURA_BROADCASTCLUSTERCOMMANDS: 'false',
      OPT2_BRIDGE_HMAC_KEY: synthetic('bridge-hmac-key'),
      OPT2_HARNESS_KEY: synthetic('harness-diagnostic-key'),
      OPT2_GATEWAY_ORIGIN: 'http://127.0.0.1:8100',
    });
  });
});
