import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoPath } from '../../src/lib/paths.js';

const SCRIPT = repoPath('harness', 'repro', 'lib', 'seed-legacy.mjs');
// Test value assembled at run time, not a secret.
const PASSWORD = ['seed', 'legacy', 'login', 'test'].join('-');
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
  let pages = 0;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/admin/index.cfm') {
      req.resume().on('end', () => {
        posts.push({ cookie: req.headers.cookie });
        answerLogin(res, answers.shift() ?? 'error');
      });
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
      env: { PATH: process.env.PATH, MURA_ADMIN_PASSWORD: PASSWORD },
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
});
