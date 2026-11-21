// Unit suite for harness/repro/lib/legacy-settle.mjs against a fake startup.cfm.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HARNESS_KEY_FILE, HARNESS_KEY_VARIABLE } from '../../src/lib/harness-key.js';
import { repoPath } from '../../src/lib/paths.js';

const SCRIPT = repoPath('harness', 'repro', 'lib', 'legacy-settle.mjs');
const STARTUP_PATH = '/harness/legacy-baseline/cfml/startup.cfm';
// Test value assembled at run time, not a secret.
const KEY = ['opt2', 'legacy', 'settle', 'test'].join('-');
const TIME = '2026-06-30T12:00:00.000';

/** One scripted answer of the fake startup.cfm. */
interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const RELOADED: Answer = { status: 200, body: { op: 'reload', reloaded: true, appInitialized: true, appInitializedTime: TIME, settledAt: TIME } };
const NOT_RELOADED: Answer = { status: 200, body: { op: 'reload', reloaded: false, appInitialized: true, appInitializedTime: TIME, settledAt: null } };
const SETTLED: Answer = { status: 200, body: { op: 'status', appInitialized: true, appInitializedTime: TIME, settledAt: TIME, settled: true } };
const UNSETTLED: Answer = { status: 200, body: { op: 'status', appInitialized: true, appInitializedTime: TIME, settledAt: null, settled: false } };

let server: Server;
let origin: string;
let root: string;
let answers: Record<'reload' | 'status', Answer[]>;
let requests: { path: string; op: string | null; key: string | string[] | undefined; agent: string | undefined }[];

beforeEach(async () => {
  answers = { reload: [], status: [] };
  requests = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const op = url.searchParams.get('op');
    requests.push({ path: url.pathname, op, key: req.headers['x-opt2-harness-key'], agent: req.headers['user-agent'] });
    const queue = url.pathname === STARTUP_PATH && (op === 'reload' || op === 'status') ? answers[op] : [];
    // The last scripted answer repeats; anything unscripted gets an empty 404.
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 404, body: '' };
    res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', ...answer.headers });
    res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-legacy-settle-'));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});

/** Runs the CLI with `env` over a home and state directory under the test root; `--pause-s 0` keeps retries quick. */
function runScript(env: Record<string, string>, args: string[] = ['--origin', origin, '--attempts', '3', '--pause-s', '0']): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), OPT2_STATE_DIR: path.join(root, 'state'), ...env },
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

/** The ops the fake startup.cfm was asked for, in order. */
function ops(): (string | null)[] {
  return requests.map((request) => request.op);
}

describe('legacy-settle.mjs', () => {
  it.each<[string, Answer[], Answer[], string[], string]>([
    ['settles on the first attempt', [RELOADED], [SETTLED], ['reload', 'status'], ''],
    [
      'retries after a failed reload',
      [{ status: 500, body: { error: 'reloadFailed', type: 'expression' } }, RELOADED],
      [SETTLED],
      ['reload', 'reload', 'status'],
      'legacy start-up not settled (attempt 1 of 3): op=reload: HTTP 500 reloadFailed expression\n',
    ],
    [
      'retries after a redirect, which it does not follow',
      [{ status: 302, body: '', headers: { location: '/elsewhere' } }, RELOADED],
      [SETTLED],
      ['reload', 'reload', 'status'],
      'legacy start-up not settled (attempt 1 of 3): op=reload: HTTP 302\n',
    ],
    [
      'retries after a status that is not settled',
      [RELOADED],
      [UNSETTLED, SETTLED],
      ['reload', 'status', 'reload', 'status'],
      'legacy start-up not settled (attempt 1 of 3): op=status: not settled (appInitialized true)\n',
    ],
  ])('%s, then prints the summary and exits 0', async (_label, reloads, statuses, expectedOps, stderr) => {
    answers = { reload: reloads, status: statuses };

    const run = await runScript({ OPT2_HARNESS_KEY: KEY });

    const attempts = expectedOps.filter((op) => op === 'reload').length;
    expect(run).toEqual({ code: 0, stdout: `${JSON.stringify({ attempts, appInitializedTime: TIME })}\n`, stderr });
    expect(ops()).toEqual(expectedOps);
    expect(requests.every((request) => request.path === STARTUP_PATH)).toBe(true);
  });

  it('exits 1 after the last attempt when no reload completes, naming each attempt', async () => {
    answers = { reload: [NOT_RELOADED], status: [SETTLED] };

    const run = await runScript({ OPT2_HARNESS_KEY: KEY });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(
      [1, 2, 3].map((n) => `legacy start-up not settled (attempt ${n} of 3): op=reload: start-up did not run to completion\n`).join('') +
        'legacy-settle: legacy start-up did not settle in 3 attempts\n',
    );
    expect(ops()).toEqual(['reload', 'reload', 'reload']);
  });

  it('reads the key file when OPT2_HARNESS_KEY is unset, sends it only as X-Opt2-Harness-Key and never prints it', async () => {
    await mkdir(path.join(root, 'state', 'secrets'), { recursive: true });
    await writeFile(path.join(root, 'state', 'secrets', HARNESS_KEY_FILE), `${KEY}\n`);
    answers = { reload: [{ status: 500, body: { error: 'reloadFailed', type: 'expression' } }, RELOADED], status: [SETTLED] };

    const run = await runScript({});

    expect(run.code).toBe(0);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({ key: KEY, agent: 'opt2-legacy-settle-bot' });
      expect(request.path + (request.op ?? '')).not.toContain(KEY);
    }
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });

  it('exits 1 before any request, naming OPT2_HARNESS_KEY and the key file, when neither holds a key', async () => {
    const run = await runScript({});

    const file = path.join(root, 'state', 'secrets', HARNESS_KEY_FILE);
    expect(run).toEqual({
      code: 1,
      stdout: '',
      stderr: `legacy-settle: no harness diagnostic key: ${HARNESS_KEY_VARIABLE} is unset and ${file} is missing or empty\n`,
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['no --origin', []],
    ['an origin with a path', ['--origin', 'http://127.0.0.1:1/admin']],
    ['zero attempts', ['--origin', 'http://127.0.0.1:1', '--attempts', '0']],
  ])('exits 2 with the usage text for %s and sends nothing', async (_label, args) => {
    const run = await runScript({ OPT2_HARNESS_KEY: KEY }, args);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Usage: node legacy-settle.mjs');
    expect(requests).toHaveLength(0);
  });
});
