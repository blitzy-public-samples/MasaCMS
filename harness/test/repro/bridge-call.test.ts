import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRIDGE_ASSERTION_HEADER, MemoryNonceStore, verifyBridgeAssertion } from '@opt2/platform/legacy-compat';

import { repoPath } from '../../src/lib/paths.js';

const SCRIPT = repoPath('harness', 'repro', 'lib', 'bridge-call.mjs');
// Test value assembled at run time, not a secret.
const KEY = ['opt2', 'bridge', 'call', 'test'].join('-');
const ANSWER = { ping: false, siteMonitorTask: 'task', tasks: [], serverTime: '2026-01-01T00:00:00.000Z' };

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let server: Server;
let origin: string;
let requests: Recorded[];

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(ANSWER));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

/** Runs the script asynchronously, so the in-process recording server can answer it. */
function runScript(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, '--origin', origin], {
      env: { PATH: process.env.PATH, OPT2_BRIDGE_HMAC_KEY: KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('bridge-call.mjs', () => {
  it.each(['describe', 'hydrate', 'markUsed', 'usedSince', 'end'])(
    'rejects session %s locally with usage guidance naming the gateway session client',
    async (op) => {
      const run = await runScript(['session', op]);

      expect(run.code).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('gateway/src/session/bridge-client.ts');
      expect(run.stderr).toContain('Usage: node bridge-call.mjs');
      expect(requests).toHaveLength(0);
    },
  );

  it('sends one signed GET with the bot user agent for scheduler describe and prints the JSON answer', async () => {
    const run = await runScript(['scheduler', 'describe']);

    expect(run).toEqual({ code: 0, stdout: `${JSON.stringify(ANSWER, null, 2)}\n`, stderr: '' });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('/gateway/legacy-bridge/cfml/scheduler.cfm?op=describe');
    expect(request?.headers['user-agent']).toBe('opt2-legacy-bridge-bot');
    const assertion = request?.headers[BRIDGE_ASSERTION_HEADER.toLowerCase()];
    expect(typeof assertion).toBe('string');
    const header = String(assertion);
    const payload: unknown = JSON.parse(Buffer.from(header.split('.')[0] ?? '', 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ aud: 'legacy-bridge', op: 'scheduler.describe', sid: '', sub: '', siteId: '' });
    expect(verifyBridgeAssertion(header, KEY, new MemoryNonceStore()).ok).toBe(true);
  });
});
