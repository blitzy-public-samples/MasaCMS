import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HARNESS_KEY_FILE, HARNESS_KEY_VARIABLE } from '../../src/lib/harness-key.js';
import { repoPath } from '../../src/lib/paths.js';

const SCRIPT = repoPath('harness', 'repro', 'lib', 'seed-legacy.mjs');
// Test values assembled at run time, not secrets.
const PASSWORD = ['seed', 'legacy', 'login', 'test'].join('-');
const HARNESS_KEY = ['seed', 'legacy', 'harness', 'test'].join('-');
const STARTUP_TIME = '2026-06-30T12:00:00.000';
const DIGEST = 'seed-legacy-test-digest';
const LOGIN_FORM = `<html><body><form method="post" action="./index.cfm">
<input type="hidden" name="muraAction" value="cLogin.login">
<input type="text" name="username"><input type="password" name="password">
<input type="hidden" name="csrf_token" value="csrf-value"><input type="hidden" name="csrf_token_expires" value="csrf-expiry">
<input type="submit" value="Login">
</form></body></html>`;

/** How the fake Masa answers one login POST. */
type Answer = 'rejected' | 'notAccepted' | 'error' | 'success';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let server: Server;
let origin: string;
let seedDir: string;
let answers: Answer[];
let posts: { cookie: string | undefined }[];
let agents: (string | undefined)[];
let issued: { cookie: string | undefined; context: string | null; token: string; expires: string }[];
let seeds: { cookie: string | undefined; token: IncomingHttpHeaders[string]; expires: IncomingHttpHeaders[string]; contentType: string | undefined }[];
let seedStatuses: number[];
let events: ('login' | 'tokens' | 'seed' | 'reload' | 'status')[];
let settleKeys: (string | string[] | undefined)[];
let harnessKey: string | undefined;

/** Answers a login POST the way Masa does for `answer`. */
function answerLogin(res: ServerResponse, answer: Answer): void {
  const location = {
    rejected: './?muraAction=cLogin.main&display=login&status=failed&rememberMe=0',
    notAccepted: './?muraAction=clogin.main',
    success: './',
    error: undefined,
  }[answer];
  if (location === undefined) {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<html><body>Error</body></html>');
    return;
  }
  res.writeHead(302, { location });
  res.end();
}

beforeEach(async () => {
  answers = [];
  posts = [];
  agents = [];
  issued = [];
  seeds = [];
  seedStatuses = [];
  events = [];
  settleKeys = [];
  harnessKey = HARNESS_KEY;
  let pages = 0;
  server = createServer((req, res) => {
    agents.push(req.headers['user-agent']);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/admin/index.cfm') {
      req.resume().on('end', () => {
        posts.push({ cookie: req.headers.cookie });
        events.push('login');
        answerLogin(res, answers.shift() ?? 'error');
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/_api/json/v1/default/generateCSRFTokens') {
      const n = issued.length + 1;
      const pair = { cookie: req.headers.cookie, context: url.searchParams.get('context'), token: `token-${n}`, expires: `expires-${n}` };
      issued.push(pair);
      events.push('tokens');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ apiversion: 'v1', data: { csrf_token: pair.token, csrf_token_expires: pair.expires }, method: 'generateCSRFTokens' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/legacy-fixtures/cfml/seed.cfm') {
      req.resume().on('end', () => {
        const h = req.headers;
        seeds.push({ cookie: h.cookie, token: h['x-csrf_token'], expires: h['x-csrf_token_expires'], contentType: h['content-type'] });
        events.push('seed');
        const status = seedStatuses.shift() ?? 200;
        const outcome = status === 200 ? { data: { inserted: 1 } } : { error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } };
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ apiversion: 'v1', method: 'seed', ...outcome }));
      });
      return;
    }
    const op = url.searchParams.get('op');
    if (req.method === 'GET' && url.pathname === '/harness/legacy-baseline/cfml/startup.cfm' && (op === 'reload' || op === 'status')) {
      settleKeys.push(req.headers['x-opt2-harness-key']);
      events.push(op);
      const answer = op === 'reload' ? { reloaded: true } : { settled: true };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ op, appInitialized: true, appInitializedTime: STARTUP_TIME, settledAt: STARTUP_TIME, ...answer }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/' && url.searchParams.get('muraAction')?.toLowerCase() === 'clogin.main') {
      pages++;
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `CFID${pages}=session; Path=/` });
      res.end(LOGIN_FORM);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Masa CMS - Site Content</body></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  seedDir = await mkdtemp(path.join(os.tmpdir(), 'opt2-seed-legacy-'));
  await writeFile(path.join(seedDir, 'manifest.json'), JSON.stringify({ digest: DIGEST, businessDate: '2026-06-30', parts: [] }));
  await writeFile(path.join(seedDir, 'credentials.json'), JSON.stringify({ digest: DIGEST }));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(seedDir, { recursive: true, force: true });
});

/** Runs the script asynchronously, so the in-process fake Masa can answer it. */
function runScript(): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--origin', origin, '--fixtures', 'false', '--seed-dir', seedDir], {
      // The state directory holds no key file, so the variable is the only key.
      env: {
        PATH: process.env.PATH,
        MURA_ADMIN_PASSWORD: PASSWORD,
        OPT2_STATE_DIR: seedDir,
        ...(harnessKey === undefined ? {} : { OPT2_HARNESS_KEY: harnessKey }),
      },
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

describe('seed-legacy.mjs admin login', () => {
  it.each<[string, Answer]>([
    ['session not accepted', 'notAccepted'],
    ['HTTP 500', 'error'],
  ])('retries once in a new session after "%s" and then seeds', async (reason, first) => {
    answers = [first, 'success'];

    const run = await runScript();

    expect(run.code).toBe(0);
    expect(run.stderr).toBe(`admin login failed: ${reason}; retrying once\n`);
    expect(JSON.parse(run.stdout)).toMatchObject({ parts: 0, skipped: 0, inserted: {}, digest: DIGEST });
    expect(posts).toHaveLength(2);
    expect(posts[0]?.cookie).toBe('CFID1=session');
    expect(posts[1]?.cookie).not.toContain('CFID1=');
  });

  it('stops after one POST when Masa rejects the credentials, without naming them', async () => {
    answers = ['rejected'];

    const run = await runScript();

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('seed-legacy: admin login failed: credentials rejected\n');
    expect(run.stderr).not.toContain(PASSWORD);
    expect(posts).toHaveLength(1);
  });

  it('fails after two POSTs when the retry fails too', async () => {
    answers = ['error', 'notAccepted'];

    const run = await runScript();

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('admin login failed: HTTP 500; retrying once\nseed-legacy: admin login failed: session not accepted\n');
    expect(run.stderr).not.toContain(PASSWORD);
    expect(posts).toHaveLength(2);
  });

  it('names itself on every request, so Masa keeps its admin session for the configured timeout', async () => {
    answers = ['success'];

    const run = await runScript();

    expect(run.code).toBe(0);
    expect(agents.length).toBeGreaterThan(0);
    expect(new Set(agents)).toStrictEqual(new Set(['opt2-seed-legacy']));
  });
});

describe('seed-legacy.mjs seed parts', () => {
  it('sends each seed POST the opt2-seed token pair issued to its session just before it, again after a re-login', async () => {
    answers = ['success', 'success'];
    seedStatuses = [401, 200];
    await writeFile(path.join(seedDir, 'dataset-0001.json'), JSON.stringify({ digest: DIGEST, array: 'masa.sites', offset: 0, rows: [{ siteID: 'umbrella' }] }));
    const parts = [{ file: 'dataset-0001.json', array: 'masa.sites', offset: 0, count: 1 }];
    await writeFile(path.join(seedDir, 'manifest.json'), JSON.stringify({ digest: DIGEST, businessDate: '2026-06-30', parts }));

    const run = await runScript();

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ parts: 1, skipped: 0, inserted: { 'masa.sites': 1 }, digest: DIGEST });
    expect(run.stderr).toBe(
      'masa.sites 0+1 answered as logged out; logging in again\nmasa.sites 0+1 inserted 1\nmasa.sites 0+1 legacy start-up settled in 1 attempt(s)\n',
    );
    expect(events).toStrictEqual(['login', 'tokens', 'seed', 'login', 'tokens', 'seed', 'reload', 'status']);
    expect(issued.map((pair) => pair.context)).toStrictEqual(['opt2-seed', 'opt2-seed']);
    expect(seeds).toStrictEqual(
      issued.map((pair) => ({ cookie: pair.cookie, token: pair.token, expires: pair.expires, contentType: 'application/json; charset=utf-8' })),
    );
    expect(seeds[1]?.cookie).toContain('CFID2=session');
  });

  it('settles legacy start-up with the harness key after the sites part, before the next part', async () => {
    answers = ['success'];
    const parts = [
      { file: 'dataset-0001.json', array: 'masa.sites', offset: 0, count: 1 },
      { file: 'dataset-0002.json', array: 'masa.groups', offset: 0, count: 1 },
    ];
    for (const part of parts) {
      await writeFile(path.join(seedDir, part.file), JSON.stringify({ digest: DIGEST, array: part.array, offset: 0, rows: [{}] }));
    }
    await writeFile(path.join(seedDir, 'manifest.json'), JSON.stringify({ digest: DIGEST, businessDate: '2026-06-30', parts }));

    const run = await runScript();

    expect(run.code).toBe(0);
    expect(events).toStrictEqual(['login', 'tokens', 'seed', 'reload', 'status', 'tokens', 'seed']);
    expect(settleKeys).toStrictEqual([HARNESS_KEY, HARNESS_KEY]);
    expect(run.stdout + run.stderr).not.toContain(HARNESS_KEY);
  });

  it('stops before logging in when a sites part is due and no harness key is configured', async () => {
    harnessKey = undefined;
    answers = ['success'];
    await writeFile(path.join(seedDir, 'dataset-0001.json'), JSON.stringify({ digest: DIGEST, array: 'masa.sites', offset: 0, rows: [{}] }));
    const parts = [{ file: 'dataset-0001.json', array: 'masa.sites', offset: 0, count: 1 }];
    await writeFile(path.join(seedDir, 'manifest.json'), JSON.stringify({ digest: DIGEST, businessDate: '2026-06-30', parts }));

    const run = await runScript();

    const file = path.join(seedDir, 'secrets', HARNESS_KEY_FILE);
    expect(run).toEqual({
      code: 1,
      stdout: '',
      stderr: `seed-legacy: no harness diagnostic key: ${HARNESS_KEY_VARIABLE} is unset and ${file} is missing or empty\n`,
    });
    expect(events).toStrictEqual([]);
  });
});
