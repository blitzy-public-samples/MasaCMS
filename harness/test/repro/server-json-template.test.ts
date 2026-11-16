import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../../src/lib/paths.js';
import { portFor } from '../../src/repro/ports.js';

interface RenderedServer {
  env?: Record<string, unknown>;
  web?: { http?: { port?: unknown } };
}

const LEGACY_START = readFileSync(repoPath('harness/repro/lib/legacy-start.sh'), 'utf8');
const LEGACY_PORT = '20180';
const RENDER_SCRIPT = 'set -euo pipefail; source "$1/harness/repro/lib/common.sh"; eval "$2"; render_server_json';

/** The text of shell function `name` as legacy-start.sh defines it, from its header to its closing brace. */
function shellFunction(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(LEGACY_START);
  if (match === null) throw new Error(`legacy-start.sh defines no ${name}()`);
  return match[0];
}

/** legacy-start.sh's own renderer and the capture reader it calls, run without the script's main body. */
const RENDERER = `${shellFunction('capture_value')}\n${shellFunction('render_server_json')}`;

const tempDirs: string[] = [];

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

/** Runs render_server_json from this checkout, or from a copy with another gateway port, over a minimal capture. */
function render(gatewayPort?: string): { result: SpawnSyncReturns<string>; serverJson: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opt2-server-json-test-'));
  tempDirs.push(root);
  const repo = gatewayPort === undefined ? REPO_ROOT : checkoutWithGatewayPort(root, gatewayPort);
  const capture = path.join(root, 'server-capture.json');
  writeFileSync(
    capture,
    JSON.stringify({
      serverHomeDirectory: '/srv/coldfusion-home',
      cfengine: 'adobe@2023.0.26+331018',
      jvmArgs: '--add-opens=java.base/sun.util.calendar=ALL-UNNAMED',
    }),
  );
  const serverJson = path.join(root, 'server.json');
  const result = spawnSync('bash', ['-c', RENDER_SCRIPT, 'render', repo, RENDERER], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      OPT2_STATE_DIR: path.join(root, 'state'),
      OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
      PORT: LEGACY_PORT,
      CAPTURE_FILE: capture,
      SERVER_JSON: serverJson,
    },
    timeout: 20_000,
  });
  return { result, serverJson };
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
});
