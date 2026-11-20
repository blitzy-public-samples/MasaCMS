import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../../src/lib/paths.js';
import { portFor } from '../../src/repro/ports.js';

interface RenderedServer {
  name?: unknown;
  env?: Record<string, unknown>;
  jvm?: { args?: unknown };
  web?: { http?: { port?: unknown } };
}

const LEGACY_START = readFileSync(repoPath('harness/repro/lib/legacy-start.sh'), 'utf8');
const LEGACY_PORT = '20180';
const RENDER_SCRIPT = 'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; eval "$2"; render_server_json';
const RESET_SCRIPT = 'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; eval "$2"; LEGACY_TMP_DIR=$3 reset_legacy_tmp';
const CAPTURED_JVM_ARGS = '--add-opens=java.base/sun.util.calendar=ALL-UNNAMED';

/** The text of shell function `name` as legacy-start.sh defines it, from its header to its closing brace. */
function shellFunction(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(LEGACY_START);
  if (match === null) throw new Error(`legacy-start.sh defines no ${name}()`);
  return match[0];
}

/** legacy-start.sh's own renderer and the capture reader it calls, run without the script's main body. */
const RENDERER = `${shellFunction('capture_value')}\n${shellFunction('render_server_json')}`;

const tempDirs: string[] = [];

/** A fresh directory under the OS temp directory, removed after the test. */
function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

/** The environment common.sh needs, rooted at `root`. */
function shellEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    OPT2_STATE_DIR: path.join(root, 'state'),
    OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
    PORT: LEGACY_PORT,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout copy holding common.sh, the template and ports.env with OPT2_PORT_GATEWAY set to `gatewayPort`. */
function checkoutWithGatewayPort(root: string, gatewayPort: string): string {
  const checkout = path.join(root, 'checkout');
  const repro = path.join(checkout, 'harness', 'repro');
  mkdirSync(path.join(repro, 'lib'), { recursive: true });
  copyFileSync(repoPath('harness/repro/server.json.template'), path.join(repro, 'server.json.template'));
  copyFileSync(repoPath('harness/repro/lib/common.sh'), path.join(repro, 'lib', 'common.sh'));
  const ports = readFileSync(repoPath('harness/repro/ports.env'), 'utf8');
  const changed = ports.replace(/^OPT2_PORT_GATEWAY=.*$/m, `OPT2_PORT_GATEWAY=${gatewayPort}`);
  writeFileSync(path.join(repro, 'ports.env'), changed);
  return checkout;
}

/**
 * Runs render_server_json from this checkout, or from a copy with another gateway port, over a minimal capture;
 * `tmpDir` is the legacy temp directory, `<root>/state/legacy-tmp` by default, and `extra` adds to the environment.
 */
function render(
  gatewayPort?: string,
  tmpDir?: string,
  extra: Record<string, string> = {},
): { result: SpawnSyncReturns<string>; serverJson: string; tmp: string } {
  const root = tempRoot('opt2-server-json-test-');
  const tmp = tmpDir ?? path.join(root, 'state', 'legacy-tmp');
  const repo = gatewayPort === undefined ? REPO_ROOT : checkoutWithGatewayPort(root, gatewayPort);
  const capture = path.join(root, 'server-capture.json');
  writeFileSync(
    capture,
    JSON.stringify({
      serverHomeDirectory: '/srv/coldfusion-home',
      cfengine: 'adobe@2023.0.26+331018',
      jvmArgs: CAPTURED_JVM_ARGS,
    }),
  );
  const serverJson = path.join(root, 'server.json');
  const result = spawnSync('bash', ['-c', RENDER_SCRIPT, 'render', repo, RENDERER], {
    encoding: 'utf8',
    env: { ...shellEnv(root), CAPTURE_FILE: capture, SERVER_JSON: serverJson, LEGACY_TMP_DIR: tmp, ...extra },
    timeout: 20_000,
  });
  return { result, serverJson, tmp };
}

/** Runs legacy-start.sh's reset_legacy_tmp on `dir`. */
function resetTmp(root: string, dir: string): SpawnSyncReturns<string> {
  return spawnSync('bash', ['-c', RESET_SCRIPT, 'reset', REPO_ROOT, shellFunction('reset_legacy_tmp'), dir], {
    encoding: 'utf8',
    env: shellEnv(root),
    timeout: 20_000,
  });
}

/** A root holding an outside directory with `keep.txt`, and the legacy temp directory path beside it. */
function tmpLayout(): { root: string; dir: string; outside: string } {
  const root = tempRoot('opt2-legacy-tmp-test-');
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  return { root, dir: path.join(root, 'legacy-tmp'), outside };
}

describe('server.json.template rendered by legacy-start.sh render_server_json', () => {
  it.each([
    ['the committed ports.env', undefined, String(portFor('gateway'))],
    ['a ports.env with another gateway port', '18100', '18100'],
  ])('sets MURA_PORT and MURA_PROXYPORT to the gateway port of %s', (_label, gatewayPort, expected) => {
    const { result, serverJson } = render(gatewayPort);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const text = readFileSync(serverJson, 'utf8');
    expect(text).not.toMatch(/@[A-Z_]+@/);
    const doc = JSON.parse(text) as RenderedServer;
    expect(doc.env).toEqual({ MURA_PORT: expected, MURA_PROXYPORT: expected });
    expect(doc.web?.http?.port).toBe(Number(LEGACY_PORT));
  });

  it('dies without writing server.json when ports.env holds no gateway port number', () => {
    const { result, serverJson } = render('gateway');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^opt2: gateway port 'gateway' from .*\/ports\.env is not a port number\n$/);
    expect(existsSync(serverJson)).toBe(false);
  });

  it.each<[string, Record<string, string>, string]>([
    ['unset', {}, 'opt2-legacy'],
    ['opt2-legacy-c25', { OPT2_CF_SERVER_NAME: 'opt2-legacy-c25' }, 'opt2-legacy-c25'],
  ])('names the server after OPT2_CF_SERVER_NAME when it is %s', (_label, extra, expected) => {
    const { result, serverJson } = render(undefined, undefined, extra);
    expect(result.status, result.stderr).toBe(0);
    expect((JSON.parse(readFileSync(serverJson, 'utf8')) as RenderedServer).name).toBe(expected);
  });

  it('takes the gateway port from OPT2_PORTS_FILE, and names that file when it holds no port number', () => {
    const file = path.join(tempRoot('opt2-ports-file-test-'), 'c25-ports.env');
    const ports = readFileSync(repoPath('harness/repro/ports.env'), 'utf8');
    writeFileSync(file, ports.replace(/^OPT2_PORT_GATEWAY=.*$/m, 'OPT2_PORT_GATEWAY=20100'));
    const moved = render(undefined, undefined, { OPT2_PORTS_FILE: file });
    expect(moved.result.status, moved.result.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(moved.serverJson, 'utf8')) as RenderedServer;
    expect(doc.env).toEqual({ MURA_PORT: '20100', MURA_PROXYPORT: '20100' });

    writeFileSync(file, ports.replace(/^OPT2_PORT_GATEWAY=.*$/m, 'OPT2_PORT_GATEWAY=gateway'));
    const broken = render(undefined, undefined, { OPT2_PORTS_FILE: file });
    expect(broken.result.status).toBe(1);
    expect(broken.result.stderr).toBe(`opt2: gateway port 'gateway' from ${file} is not a port number\n`);
    expect(existsSync(broken.serverJson)).toBe(false);
  });

  it('appends the JDK-only PNG codec pin and java.io.tmpdir, set to the legacy temp directory, to the JVM arguments', () => {
    const { result, serverJson, tmp } = render();
    expect(result.status, result.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(serverJson, 'utf8')) as RenderedServer;
    expect(doc.jvm?.args).toBe(`${CAPTURED_JVM_ARGS} -Dcom.sun.media.imageio.disableCodecLib=true -Djava.io.tmpdir=${tmp}`);
  });

  it.each([' ', '"', "'", '\\'])('refuses a legacy temp directory holding %j and writes no server.json', (char) => {
    const bad = path.join(os.tmpdir(), `opt2-legacy-tmp${char}x`);
    const { result, serverJson } = render(undefined, bad);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`opt2: ${bad} holds whitespace, a quote or a backslash`);
    expect(existsSync(serverJson)).toBe(false);
  });
});

describe('legacy-start.sh reset_legacy_tmp', () => {
  it.each<[string, (at: { dir: string; outside: string }) => void]>([
    ['absent', () => undefined],
    [
      'a 0755 directory holding files, a subdirectory and links out of it',
      ({ dir, outside }) => {
        mkdirSync(path.join(dir, 'sub'), { recursive: true });
        chmodSync(dir, 0o755);
        writeFileSync(path.join(dir, 'masa-baseline.json'), '{}');
        writeFileSync(path.join(dir, 'sub', 'form.json'), '{}');
        symlinkSync(outside, path.join(dir, 'outside-dir'));
        symlinkSync(path.join(outside, 'keep.txt'), path.join(dir, 'sub', 'outside-file'));
      },
    ],
    ['a symbolic link to an outside directory', ({ dir, outside }) => symlinkSync(outside, dir)],
    ['a regular file', ({ dir }) => writeFileSync(dir, 'x')],
  ])('leaves an empty owner-only directory when it was %s', (_label, arrange) => {
    const at = tmpLayout();
    arrange(at);
    const run = resetTmp(at.root, at.dir);
    expect(run.status, run.stderr).toBe(0);
    const stat = lstatSync(at.dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(readdirSync(at.dir)).toEqual([]);
    expect(readdirSync(at.outside)).toEqual(['keep.txt']);
    expect(readFileSync(path.join(at.outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('dies naming the directory when it cannot be created', () => {
    const at = tmpLayout();
    writeFileSync(path.join(at.root, 'file'), '');
    const dir = path.join(at.root, 'file', 'legacy-tmp');
    const run = resetTmp(at.root, dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`opt2: cannot create the legacy temp directory ${dir}\n`);
  });
});

describe('server.json.template directory rule', () => {
  const template = JSON.parse(readFileSync(repoPath('harness/repro/server.json.template'), 'utf8')) as { web: { rules: string[] } };
  const [rule = ''] = template.web.rules;
  // Undertow's regex predicate with case-sensitive=false.
  const directory = new RegExp(/pattern='([^']*)'/.exec(rule)?.[1] ?? '(?!)', 'i');

  it('answers a bodiless 404 for a matched directory', () => {
    expect(rule).toMatch(/ and is-directory\(\) -> \{ error-file\( file='\/dev\/null', response-codes=\{ 404 \} \); response-code\( 404 \) \}$/);
  });

  it.each([
    '/gateway/',
    '/legacy-fixtures',
    '/harness/legacy-baseline/',
    '/services/identity/',
    '/migration/',
    '/platform/',
    '/infra/terraform/',
    '/web/',
    '//OPT2/reports/',
    '/.github/workflows/',
  ])('matches the OPT-2 folder directory %s', (dir) => {
    expect(directory.test(dir)).toBe(true);
  });

  it.each(['/', '/admin/', '/core/', '/sites/', '/.github/', '/.github/ISSUE_TEMPLATE/', '/webx/', '/opt2x/'])(
    'leaves the directory %s to legacy',
    (dir) => {
      expect(directory.test(dir)).toBe(false);
    },
  );
});
