// Unit suite for the opt2-legacy stop guards of up.sh, down.sh and legacy-start.sh --original, driven by bash with a stub `box`.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoPath } from '../../src/lib/paths.js';

const REPRO_DIR = repoPath('harness/repro');
// $1 repro directory, $2 fake checkout, $3 script.
const PRELUDE = 'set -euo pipefail; source "$1/lib/common.sh"; REPO=$2; eval "$3"';
const LEGACY_PORT = '18999';
const SERVER_HOME = '/srv/cf/home';

// Serves `server info name=X --json` from the registry file, applies `server stop` to it, logs each call.
const BOX_STUB = `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BOX_STUB_LOG, JSON.stringify(args) + "\\n");
const file = process.env.BOX_STUB_REGISTRY;
const registry = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const named = (prefix) => (args.find((arg) => arg.startsWith(prefix)) ?? "").slice(prefix.length);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
if (args[0] === "server" && args[1] === "info") {
  const entry = registry.find((e) => same(e.name, named("name=")));
  if (entry !== undefined) process.stdout.write(JSON.stringify(entry, null, 4) + "\\n");
} else if (args[0] === "server" && args[1] === "stop") {
  for (const e of registry) if (same(e.name, named("name="))) e.status = "stopped";
  fs.writeFileSync(file, JSON.stringify(registry));
}
`;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Entry {
  id: string;
  name: string;
  webroot: string;
  serverHomeDirectory: string;
  status: string;
  port: number;
}

let root: string;
let checkout: string;
let other: string;

beforeEach(() => {
  root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'opt2-legacy-name-'));
  checkout = path.join(root, 'checkout');
  other = path.join(root, 'other-checkout');
  for (const dir of [checkout, other, 'home', 'bin', 'pristine']) mkdirSync(path.resolve(root, dir), { recursive: true });
  const stub = path.join(root, 'bin', 'box-stub.cjs');
  writeFileSync(stub, BOX_STUB);
  writeFileSync(path.join(root, 'bin', 'box'), `#!/usr/bin/env bash\nexec node "${stub}" "$@"\n`);
  chmodSync(path.join(root, 'bin', 'box'), 0o755);
  const capture = { name: 'masacms-orig', wasRunning: true, port: Number(LEGACY_PORT), serverHomeDirectory: SERVER_HOME };
  writeFileSync(captureFile(), JSON.stringify(capture));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const captureFile = (): string => path.join(root, 'pristine', 'server-capture.json');
const registryFile = (): string => path.join(root, 'registry.json');
const registry = (): Entry[] => JSON.parse(readFileSync(registryFile(), 'utf8')) as Entry[];

/** Every recorded `box` call, as its argument list. */
function boxCalls(): string[][] {
  const log = path.join(root, 'box.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

/** Runs <script> in bash after common.sh with REPO set to the fake checkout and the stub box first on PATH. */
function run(script: string, entries: Entry[]): Result {
  writeFileSync(registryFile(), JSON.stringify(entries));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: path.join(root, 'home'),
    OPT2_STATE_DIR: path.join(root, 'state'),
    OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
    OPT2_LEGACY_PORT: LEGACY_PORT,
    BOX_STUB_LOG: path.join(root, 'box.log'),
    BOX_STUB_REGISTRY: registryFile(),
  };
  delete env.OPT2_COMMON_SH_LOADED;
  delete env.OPT2_CF_SERVER_HOME;
  const result = spawnSync('bash', ['-c', PRELUDE, '_', REPRO_DIR, checkout, script], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The source of each named top-level function of a harness/repro script. */
function functions(script: string, names: string[]): string {
  const text = readFileSync(path.join(REPRO_DIR, script), 'utf8');
  return names
    .map((name) => {
      const found = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n(?=\\n|$)`, 'm').exec(text);
      if (found === null) throw new Error(`${script} defines no function ${name}`);
      return found[0];
    })
    .join('\n');
}

describe('stop guards', () => {
  const overrides = 'legacy_listening() { true; }; wait_port_closed() { :; }; wait_http() { :; }';
  const sites: Record<string, string[]> = {
    'up.sh stop_coldfusion': [functions('up.sh', ['stop_coldfusion']), overrides, 'stop_coldfusion'],
    'down.sh stop_coldfusion': [
      functions('down.sh', ['capture_value', 'cf_server_state', 'stop_coldfusion']),
      functions('lib/processes.sh', ['join_or_none']),
      overrides,
      'stop_coldfusion',
    ],
    'legacy-start.sh --original': [
      functions('lib/legacy-start.sh', ['capture_value', 'server_state', 'box_cmd', 'run_original']),
      overrides,
      'print_summary() { :; }; START_TIMEOUT_S=1',
      'run_original',
    ],
  };

  it.each(
    Object.keys(sites).flatMap((site) => [
      { site, where: 'this checkout and server home', home: SERVER_HOME, stops: true },
      { site, where: 'another checkout and server home', home: '/srv/cf/other-home', stops: false },
    ]),
  )('$site with opt2-legacy registered to $where stops it: $stops', ({ site, home, stops }) => {
    const legacy: Entry = {
      id: '1DE9D3F972728E2FB5220BE96A002597',
      name: 'opt2-legacy',
      webroot: `${stops ? checkout : other}/`,
      serverHomeDirectory: home,
      status: 'running',
      port: Number(LEGACY_PORT),
    };
    const original: Entry = {
      id: '7EF39727592DDA95BB10DF9B0829ACC1',
      name: 'masacms-orig',
      webroot: `${checkout}/`,
      serverHomeDirectory: SERVER_HOME,
      status: 'stopped',
      port: Number(LEGACY_PORT),
    };
    const script = [`CAPTURE_FILE=${JSON.stringify(captureFile())}`, ...(sites[site] ?? [])].join('\n');
    const result = run(script, [legacy, original]);
    expect(result.status, result.stderr).toBe(0);
    const stopped = boxCalls()
      .filter((call) => call[0] === 'server' && call[1] === 'stop')
      .map((call) => call.find((arg) => arg.startsWith('name=')));
    expect(stopped.includes('name=opt2-legacy')).toBe(stops);
    expect(boxCalls().some((call) => call.includes('forget'))).toBe(false);
    expect(registry().find((entry) => entry.name === 'opt2-legacy')?.status).toBe(stops ? 'stopped' : 'running');
  });
});
