// Unit suite for the Mailpit settings legacy-start.sh start_server and up.sh load_fixtures take from the port file,
// driven by bash with a stub `box` and a stub load-fixtures.sh.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../../src/lib/paths.js';

const LEGACY_START = readFileSync(repoPath('harness/repro/lib/legacy-start.sh'), 'utf8');
const UP = readFileSync(repoPath('harness/repro/up.sh'), 'utf8');
const COMMITTED_PORTS = readFileSync(repoPath('harness/repro/ports.env'), 'utf8');
const LEGACY_PORT = '20180';
// $1 checkout, $2 start_server's source.
const START_SCRIPT = 'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; eval "$2"; start_server';
// $1 checkout, $2 load_fixtures's source, $3 the fake checkout holding the stub load-fixtures.sh.
const LOAD_FIXTURES_SCRIPT =
  'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; REPO=$3; eval "$2"; load_fixtures --check-only';
const COMMUNICATIONS_ENV_SCRIPT =
  'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; source "$1/harness/repro/lib/processes.sh"; process_env communications';
const MAIL_VARIABLES = ['SMTP_HOST', 'SMTP_PORT', 'MAILPIT_API_URL'] as const;

/** Synthetic value for `label`, assembled at run time so no credential-shaped literal sits in the source. */
const synthetic = (label: string): string => ['synthetic', label, 'value'].join('-');

// Appends the argv and environment of each call as one JSON line; serves as `box` and as load-fixtures.sh.
const RECORDER = `
const fs = require("fs");
fs.appendFileSync(process.env.RECORDER_LOG, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n");
`;

/** Port files, as edits of the committed ports.env, with the Mailpit ports each must yield. */
const PORT_FILES = [
  { label: 'the committed ports.env', edit: undefined, smtpPort: '1025', apiUrl: 'http://127.0.0.1:8025' },
  {
    label: 'a port file that moves the Mailpit ports',
    edit: (text: string): string =>
      text
        .replace(/^OPT2_TOOL_PORT_MAILPIT_SMTP=.*$/m, 'OPT2_TOOL_PORT_MAILPIT_SMTP=21025')
        .replace(/^OPT2_TOOL_PORT_MAILPIT_HTTP=.*$/m, 'OPT2_TOOL_PORT_MAILPIT_HTTP=21026'),
    smtpPort: '21025',
    apiUrl: 'http://127.0.0.1:21026',
  },
  {
    label: 'a port file without the tooling ports',
    edit: (text: string): string => text.replace(/^OPT2_TOOL_PORT_\w+=.*\n/gm, ''),
    smtpPort: '1025',
    apiUrl: 'http://127.0.0.1:8025',
  },
];

interface Call {
  args: string[];
  env: Record<string, string>;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opt2-legacy-start-env-'));
  for (const dir of ['bin', 'home', 'pristine', 'state/secrets', 'fake/legacy-fixtures']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  const recorder = path.join(root, 'bin', 'recorder.cjs');
  writeFileSync(recorder, RECORDER);
  for (const file of [path.join(root, 'bin', 'box'), path.join(root, 'fake', 'legacy-fixtures', 'load-fixtures.sh')]) {
    writeFileSync(file, `#!/usr/bin/env bash\nexec node "${recorder}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  for (const name of ['bridge-hmac-key', 'harness-diagnostic-key', 'db-communications-app']) {
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

/** Writes the committed ports.env through `edit` to a port file under the test directory; undefined keeps it. */
function portsFile(edit: ((text: string) => string) | undefined): string | undefined {
  if (edit === undefined) return undefined;
  const file = path.join(root, 'ports.env');
  writeFileSync(file, edit(COMMITTED_PORTS));
  return file;
}

/** Runs `script` in bash with the environment common.sh needs, the port file `ports` when given, and `extra`. */
function bash(script: string, args: string[], ports: string | undefined, extra: Record<string, string>): string {
  const env: Record<string, string> = {
    PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: path.join(root, 'home'),
    TZ: 'UTC',
    OPT2_STATE_DIR: path.join(root, 'state'),
    OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
    RECORDER_LOG: path.join(root, 'calls.log'),
    ...(ports === undefined ? {} : { OPT2_PORTS_FILE: ports }),
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

/** The one recorded call of the stub `box` or load-fixtures.sh. */
function onlyCall(): Call {
  const calls = readFileSync(path.join(root, 'calls.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Call);
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
}

/** The KEY=value lines process_env communications prints for the port file `ports`, as a map. */
function communicationsEnv(ports: string | undefined): Record<string, string> {
  const stdout = bash(COMMUNICATIONS_ENV_SCRIPT, [], ports, {
    PORT: LEGACY_PORT,
    OPT2_SERVICE_URLS: '{}',
    PG_HOST: '127.0.0.1',
    PG_PORT: '15432',
    PG_DATABASE: 'synthetic_services',
  });
  const lines: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) lines[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return lines;
}

describe('legacy-start.sh start_server', () => {
  it.each(PORT_FILES)(
    'gives ColdFusion the Mailpit of $label (SMTP $smtpPort, API $apiUrl) on the start command, as target communications gets it',
    ({ edit, smtpPort, apiUrl }) => {
      const ports = portsFile(edit);
      const serverJson = path.join(root, 'state', 'commandbox', 'server.json');
      bash(START_SCRIPT, [shellFunction(LEGACY_START, 'start_server')], ports, {
        // The migration service's own PORT, with legacy's handed over as OPT2_LEGACY_PORT.
        PORT: '8102',
        OPT2_LEGACY_PORT: LEGACY_PORT,
        SERVER_JSON: serverJson,
        // Stale values an inherited or legacy-env environment may carry; the start command must replace them.
        SMTP_HOST: '192.0.2.10',
        SMTP_PORT: '2525',
        MAILPIT_API_URL: 'http://192.0.2.10:9025',
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
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: smtpPort,
        MAILPIT_API_URL: apiUrl,
      });
      const communications = communicationsEnv(ports);
      for (const name of MAIL_VARIABLES) expect(env[name], name).toBe(communications[name]);
    },
  );
});

describe('up.sh load_fixtures', () => {
  it.each(PORT_FILES)(
    'has load-fixtures.sh check the Mailpit of $label (SMTP $smtpPort, API $apiUrl) when the caller sets none',
    ({ edit, smtpPort, apiUrl }) => {
      const ports = portsFile(edit);
      bash(LOAD_FIXTURES_SCRIPT, [shellFunction(UP, 'load_fixtures'), path.join(root, 'fake')], ports, {
        CFPM_CMD: '/usr/bin/true',
      });
      const { args, env } = onlyCall();

      expect(args).toEqual(['--check-only']);
      expect(env).toMatchObject({ SMTP_HOST: '127.0.0.1', SMTP_PORT: smtpPort, MAILPIT_API_URL: apiUrl });
    },
  );
});
