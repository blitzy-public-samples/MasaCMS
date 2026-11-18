import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoPath } from '../../src/lib/paths.js';

const COMMON_SH = repoPath('harness/repro/lib/common.sh');
const PRISTINE_SH = repoPath('harness/repro/lib/pristine.sh');
const REPO = realpathSync(repoPath());
const SERVER_ID = '1DE9D3F972728E2FB5220BE96A002597';
const SEP = '\u001f';

/**
 * CommandBox stand-in: answers `server info` from STUB_INFO, `server list` from STUB_LIST and `cfconfig cfmapping list`
 * from STUB_MAPPINGS, runs `execute` as configured, records every call.
 */
const STUB_BOX = `#!/usr/bin/env bash
(IFS=$'\\x1f'; printf '%s\\n' "$*") >>"$STUB_LOG"
if [[ $1 == server && $2 == info ]]; then
  if [[ -f $STUB_INFO ]]; then cat -- "$STUB_INFO"; fi
  exit 0
fi
if [[ $1 == server && $2 == list ]]; then
  if [[ -f $STUB_LIST ]]; then cat -- "$STUB_LIST"; else printf '[]\\n'; fi
  exit 0
fi
if [[ $1 == cfconfig && $2 == cfmapping && $3 == list ]]; then
  if [[ -f $STUB_MAPPINGS ]]; then cat -- "$STUB_MAPPINGS"; else printf '{}\\n'; fi
  exit 0
fi
if [[ $1 == execute ]]; then
  file=""
  for arg in "$@"; do if [[ $arg == file=* ]]; then file=\${arg#file=}; fi; done
  if [[ -f $file ]]; then
    printf 'exists mode=%s first=%s\\n' "$(stat -c %a -- "$file")" "$(head -n 1 -- "$file")" >>"$STUB_TEMPLATES"
  else
    printf 'missing\\n' >>"$STUB_TEMPLATES"
  fi
  if [[ \${STUB_EXECUTE_CLEARS:-} == 1 ]]; then rm -f -- "$STUB_INFO"; fi
  printf '%s' "\${STUB_EXECUTE_OUTPUT:-}"
  exit "\${STUB_EXECUTE_EXIT:-0}"
fi
exit 97
`;

interface Sandbox {
  root: string;
  stateDir: string;
  pristineDir: string;
  serverHome: string;
  info: string;
  list: string;
  mappings: string;
  log: string;
  templates: string;
  env: Record<string, string>;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let sandbox: Sandbox;

beforeEach(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opt2-legacy-identity-'));
  const bin = path.join(root, 'bin');
  const stateDir = path.join(root, 'state');
  const pristineDir = path.join(root, 'pristine');
  const serverHome = path.join(root, 'server', 'adobe-2023');
  for (const dir of [bin, stateDir, pristineDir, serverHome, path.join(root, 'home')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(bin, 'box'), STUB_BOX);
  chmodSync(path.join(bin, 'box'), 0o755);
  const capture = {
    name: 'masacms-original',
    serverHomeDirectory: serverHome,
    cfconfigTarget: path.join(serverHome, 'WEB-INF', 'cfusion'),
    cfconfigFormat: 'adobe@2023',
  };
  writeFileSync(path.join(pristineDir, 'server-capture.json'), `${JSON.stringify(capture)}\n`);
  const info = path.join(root, 'info.json');
  const list = path.join(root, 'list.json');
  const mappings = path.join(root, 'mappings.json');
  const log = path.join(root, 'box.log');
  const templates = path.join(root, 'templates.log');
  sandbox = {
    root,
    stateDir,
    pristineDir,
    serverHome,
    info,
    list,
    mappings,
    log,
    templates,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: path.join(root, 'home'),
      OPT2_STATE_DIR: stateDir,
      OPT2_PRISTINE_DIR: pristineDir,
      STUB_INFO: info,
      STUB_LIST: list,
      STUB_MAPPINGS: mappings,
      STUB_LOG: log,
      STUB_TEMPLATES: templates,
    },
  };
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

/** Runs common.sh function `fn` with `args` in a bash that sourced common.sh, the stub box first on PATH. */
function runCommon(fn: string, args: string[], extraEnv: Record<string, string> = {}): Run {
  const result = spawnSync('bash', ['-c', 'source "$0" && "$@"', COMMON_SH, fn, ...args], {
    encoding: 'utf8',
    env: { ...sandbox.env, ...extraEnv },
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs pristine.sh function `fn` with `args` in a bash that sourced common.sh and pristine.sh, the stub box first on PATH. */
function runPristine(fn: string, args: string[], extraEnv: Record<string, string> = {}): Run {
  const result = spawnSync('bash', ['-c', 'source "$0" && source "$1" && "${@:2}"', COMMON_SH, PRISTINE_SH, fn, ...args], {
    encoding: 'utf8',
    env: { ...sandbox.env, ...extraEnv },
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Makes the stub's `box server info name=opt2-legacy --json` print `text`. */
function registerInfo(text: string): void {
  writeFileSync(sandbox.info, text);
}

/** The pretty JSON `box server info --json` prints for an opt2-legacy entry. */
function infoJson(webroot: string, home: string, name = 'opt2-legacy'): string {
  const entry = { id: SERVER_ID, name, status: 'stopped', webroot, serverHomeDirectory: home, port: 26280 };
  return `${JSON.stringify(entry, null, 4)}\n`;
}

/** Every recorded stub call, as its argument list. */
function boxCalls(): string[][] {
  if (!existsSync(sandbox.log)) return [];
  return readFileSync(sandbox.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(SEP));
}

const INFO_CALL = ['server', 'info', 'name=opt2-legacy', '--json'];

type Registration =
  | 'ours'
  | 'ours, after a banner'
  | 'foreign webroot'
  | 'foreign home'
  | 'unregistered'
  | 'empty registry';

/** `box server info` output for each registration state. */
const infoFor = (registration: Registration): string | undefined => {
  switch (registration) {
    case 'ours':
      return infoJson(`${REPO}/`, sandbox.serverHome, 'OPT2-LEGACY');
    case 'ours, after a banner':
      return `CommandBox update available\n${infoJson(`${REPO}/`, `${sandbox.serverHome}/`)}`;
    case 'foreign webroot':
      return infoJson(`${path.join(sandbox.root, 'other-checkout')}/`, sandbox.serverHome);
    case 'foreign home':
      return infoJson(`${REPO}/`, path.join(sandbox.root, 'server', 'other-agent'));
    case 'unregistered':
      return undefined;
    case 'empty registry':
      return 'No server configurations found!\n';
  }
};

const registrations: Registration[] = [
  'ours',
  'ours, after a banner',
  'foreign webroot',
  'foreign home',
  'unregistered',
  'empty registry',
];

describe('legacy_record_ours and legacy_record_home_ours', () => {
  it.each(registrations)('%s', (registration) => {
    const text = infoFor(registration);
    if (text !== undefined) registerInfo(text);
    const ours = registration.startsWith('ours');
    const checks = [
      { fn: 'legacy_record_ours', expected: ours },
      { fn: 'legacy_record_home_ours', expected: ours || registration === 'foreign webroot' },
    ];
    for (const { fn, expected } of checks) {
      const run = runCommon('eval', [`${fn} "$(legacy_registration)"`]);
      expect(run.stderr).toBe('');
      expect({ fn, status: run.status }).toEqual({ fn, status: expected ? 0 : 1 });
    }
    expect(boxCalls()).toEqual([INFO_CALL, INFO_CALL]);
  });
});

describe('cfconfig_target', () => {
  const cases = registrations.flatMap((registration) => (['from', 'to'] as const).map((dir) => ({ registration, dir })));

  it.each(cases)('$registration, direction $dir', ({ registration, dir }) => {
    const text = infoFor(registration);
    if (text !== undefined) registerInfo(text);
    const run = runCommon('cfconfig_target', [dir]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const cfusion = path.join(sandbox.serverHome, 'WEB-INF', 'cfusion');
    const expected = registration.startsWith('ours') ? ['opt2-legacy'] : [cfusion, `${dir}Format=adobe@2023`];
    expect(run.stdout).toBe(`${expected.join('\n')}\n`);
    expect(boxCalls()).toEqual([INFO_CALL]);
  });
});

describe('legacy_unregister', () => {
  it.each(['', 'abc', SERVER_ID.slice(1), `${SERVER_ID}0`, `${SERVER_ID.slice(2)}..`, `${SERVER_ID}\n`, '../../servers.json'])(
    'rejects the id %j without calling box',
    (id) => {
      const run = runCommon('legacy_unregister', [id]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('is not a CommandBox server id');
      expect(boxCalls()).toEqual([]);
    },
  );

  it.each([
    { outcome: 'removed', output: 'removed', clears: true, exit: 0, status: 0, stdout: 'removed\n', stderr: '' },
    { outcome: 'absent', output: 'absent', clears: true, exit: 0, status: 0, stdout: 'absent\n', stderr: '' },
    { outcome: 'box failing', output: 'ERROR entry is server x', clears: false, exit: 1, status: 1, stdout: '', stderr: '(exit 1)' },
    { outcome: 'entry still reported', output: 'removed', clears: false, exit: 0, status: 1, stdout: '', stderr: 'still reports' },
  ])('runs a 0600 template in the state commandbox directory, then deletes it: $outcome', (row) => {
    const { output, clears, exit, status, stdout, stderr } = row;
    registerInfo(infoJson(`${REPO}/`, sandbox.serverHome));
    const run = runCommon('legacy_unregister', [SERVER_ID], {
      STUB_EXECUTE_OUTPUT: output,
      STUB_EXECUTE_CLEARS: clears ? '1' : '0',
      STUB_EXECUTE_EXIT: String(exit),
    });
    expect(run.status).toBe(status);
    expect(run.stdout).toBe(stdout);
    expect(run.stderr).toContain(stderr);

    const calls = boxCalls();
    const execute = calls.find((call) => call[0] === 'execute');
    expect(execute).toBeDefined();
    const [, fileArg, ...rest] = execute ?? [];
    expect(rest).toEqual([`id=${SERVER_ID}`, 'name=opt2-legacy']);
    const template = (fileArg ?? '').replace(/^file=/, '');
    expect(path.dirname(template)).toBe(path.join(sandbox.stateDir, 'commandbox'));
    expect(path.basename(template)).toMatch(/^unregister\.[A-Za-z0-9]{6}\.cfm$/);
    expect(readFileSync(sandbox.templates, 'utf8')).toBe('exists mode=600 first=<cfscript>\n');
    expect(existsSync(template)).toBe(false);
    expect(readdirSync(path.join(sandbox.stateDir, 'commandbox'))).toEqual([]);
    expect(calls.filter((call) => call[0] !== 'execute')).toEqual(exit === 0 ? [INFO_CALL] : []);
  });
});

describe('OPT2_CF_SERVER_NAME', () => {
  it.each<{ label: string; env: Record<string, string>; name: string }>([
    { label: 'unset', env: {}, name: 'opt2-legacy' },
    { label: 'opt2-legacy-c25', env: { OPT2_CF_SERVER_NAME: 'opt2-legacy-c25' }, name: 'opt2-legacy-c25' },
  ])('names the server of every CommandBox call when $label', ({ env, name }) => {
    registerInfo(infoJson(`${REPO}/`, sandbox.serverHome, name));
    const target = runCommon('cfconfig_target', ['to'], env);
    expect(target.stderr).toBe('');
    expect(target.stdout).toBe(`${name}\n`);
    const unregister = runCommon('legacy_unregister', [SERVER_ID], {
      ...env,
      STUB_EXECUTE_OUTPUT: 'removed',
      STUB_EXECUTE_CLEARS: '1',
    });
    expect(unregister.status, unregister.stderr).toBe(0);
    expect(unregister.stdout).toBe('removed\n');
    const info = ['server', 'info', `name=${name}`, '--json'];
    expect(boxCalls().filter((call) => call[0] !== 'execute')).toEqual([info, info]);
    expect(boxCalls().find((call) => call[0] === 'execute')?.slice(2)).toEqual([`id=${SERVER_ID}`, `name=${name}`]);
  });
});

describe('capture_server', () => {
  const ADOBE = 'adobe@2023.0.26+331018';
  const JVM_ARGS = '--add-opens=java.base/java.lang=ALL-UNNAMED';
  const cfusion = (home: string): string => path.join(home, 'WEB-INF', 'cfusion');
  const originalHome = (s: Sandbox): string => path.join(s.root, 'server', 'original');
  const overrides = (home: string, engine = ADOBE): Record<string, string> => ({
    OPT2_CF_SERVER_HOME: home,
    OPT2_CF_ENGINE: engine,
    OPT2_CF_JVM_ARGS: JVM_ARGS,
  });

  /** `box server list --json`: another agent's server, OPT-2's own and, when `found`, this checkout's original server. */
  const listing = (s: Sandbox, found: boolean): object[] => [
    {
      name: 'other-agent',
      status: 'running',
      webroot: path.join(s.root, 'other-checkout'),
      port: 26180,
      cfengine: ADOBE,
      serverHomeDirectory: path.join(s.root, 'server', 'other-agent'),
    },
    { name: 'opt2-legacy', status: 'stopped', webroot: `${REPO}/`, port: 26280, cfengine: ADOBE, serverHomeDirectory: s.serverHome },
    ...(found
      ? [
          {
            name: 'masacms-original',
            status: 'running',
            webroot: `${REPO}/`,
            port: 26380,
            cfengine: ADOBE,
            JVMargs: JVM_ARGS,
            serverHomeDirectory: originalHome(s),
          },
        ]
      : []),
  ];

  const cases: {
    title: string;
    found: boolean;
    env: (s: Sandbox) => Record<string, string>;
    home: (s: Sandbox) => string;
    target: (s: Sandbox) => string;
    format: string;
  }[] = [
    {
      title: 'no server found, Adobe home overridden',
      found: false,
      env: (s) => overrides(s.serverHome),
      home: (s) => s.serverHome,
      target: (s) => cfusion(s.serverHome),
      format: 'adobe@2023',
    },
    {
      title: 'no server found, Adobe home overridden with a trailing slash',
      found: false,
      env: (s) => overrides(`${s.serverHome}/`),
      home: (s) => `${s.serverHome}/`,
      target: (s) => cfusion(s.serverHome),
      format: 'adobe@2023',
    },
    {
      title: 'no server found, override already the cfusion directory',
      found: false,
      env: (s) => overrides(cfusion(s.serverHome)),
      home: (s) => cfusion(s.serverHome),
      target: (s) => cfusion(s.serverHome),
      format: 'adobe@2023',
    },
    {
      title: 'no server found, Lucee home overridden',
      found: false,
      env: (s) => overrides(s.serverHome, 'lucee@5.4.6+9'),
      home: (s) => s.serverHome,
      target: (s) => s.serverHome,
      format: 'lucee@5',
    },
    {
      title: 'server found, home overridden',
      found: true,
      env: (s) => ({ OPT2_CF_SERVER_HOME: s.serverHome }),
      home: (s) => s.serverHome,
      target: (s) => cfusion(s.serverHome),
      format: 'adobe@2023',
    },
    {
      title: 'server found, no override',
      found: true,
      env: () => ({}),
      home: originalHome,
      target: () => 'masacms-original',
      format: 'adobe@2023',
    },
  ];

  it.each(cases)('$title', ({ found, env, home, target, format }) => {
    const out = path.join(sandbox.pristineDir, 'server-capture.json');
    rmSync(out);
    writeFileSync(sandbox.list, `${JSON.stringify(listing(sandbox, found), null, 4)}\n`);
    writeFileSync(sandbox.mappings, `${JSON.stringify({ '/muraWRM': { PHYSICAL: '/srv/original-checkout' } })}\n`);
    const run = runPristine('capture_server', [], env(sandbox));
    const expectedTarget = target(sandbox);
    expect(run.stderr).toBe(`opt2: captured legacy server ${expectedTarget} in ${out}\n`);
    expect(run.status).toBe(0);

    const capture = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(capture)).toEqual([
      'name',
      'wasRunning',
      'serverHomeDirectory',
      'cfengine',
      'jvmArgs',
      'serverConfigFile',
      'webroot',
      'port',
      'muraWRMMapping',
      'cfconfigTarget',
      'cfconfigFormat',
      'capturedAt',
    ]);
    expect(capture).toMatchObject({
      name: found ? 'masacms-original' : null,
      serverHomeDirectory: home(sandbox),
      jvmArgs: JVM_ARGS,
      muraWRMMapping: '/srv/original-checkout',
      cfconfigTarget: expectedTarget,
      cfconfigFormat: format,
    });
    // A server-home target carries its engine format; a CommandBox server name does not.
    const fromFormat = expectedTarget.startsWith('/') ? [`fromFormat=${format}`] : [];
    expect(boxCalls()).toEqual([
      ['server', 'list', '--json'],
      ['cfconfig', 'cfmapping', 'list', `from=${expectedTarget}`, ...fromFormat, '--json'],
    ]);
  });
});
