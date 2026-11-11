#!/usr/bin/env node
// Loads the generated seed dataset into legacy Masa through legacy-fixtures/cfml/seed.cfm, logged in as the admin.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';

const USAGE = `Usage: node seed-legacy.mjs --origin <url> --fixtures true|false [--seed-dir <dir>] [--timeout-s <n>]

Logs in to the legacy admin, then posts every part of <seed-dir>/manifest.json, in manifest order,
to /legacy-fixtures/cfml/seed.cfm.

  --origin <url>          legacy origin, straight to ColdFusion (e.g. http://127.0.0.1:8080)
  --fixtures true|false   whether the fixture schemas are loaded; false skips every fixtures.* part
  --seed-dir <dir>        dataset directory (default \${OPT2_STATE_DIR:-$HOME/.opt2/state}/seed)
  --timeout-s <n>         per-request timeout in seconds (default 1800)
  --help                  print this help

Environment: MURA_ADMIN_USERNAME (default admin), MURA_ADMIN_PASSWORD (required).
Exit status: 0 done, 1 failure, 2 usage.
`;

const OPTIONS = {
  origin: { type: 'string' },
  'seed-dir': { type: 'string' },
  fixtures: { type: 'string' },
  'timeout-s': { type: 'string', default: '1800' },
  help: { type: 'boolean' },
};

const LOGIN_PATH = '/admin/?muraAction=clogin.main';
const LOGIN_ACTION = '?muraAction=clogin.login';
const SEED_PATH = '/legacy-fixtures/cfml/seed.cfm';
// CSRF_FIELD_TOKEN and CSRF_FIELD_EXPIRES of platform/src/legacy-compat/csrf.ts.
const CSRF_FIELDS = ['csrf_token', 'csrf_token_expires'];
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Controls a browser submits only when clicked or chosen.
const UNSUBMITTED = new Set(['submit', 'button', 'reset', 'image', 'file']);
// Parts whose rows take secrets from the credentials.json member of the same name.
const CREDENTIAL_PARTS = new Set(['users', 'oauthClients']);

/** Failure whose message names only a step, a part or a status, never a secret. */
class SeedError extends Error {}

/** Invalid command line or environment; exits 2. */
class UsageError extends Error {}

/** Parses JSON without echoing it: Node's parse errors quote the text, which can hold secrets. */
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SeedError(`${what} is not valid JSON`);
  }
}

/** SeedError prefixing `label` to the message of a transport error. */
function failed(label, err) {
  return new SeedError(`${label}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Run options from the command line and environment; throws UsageError. */
function options(argv, env) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.help === true) return { help: true };
  const origin = URL.canParse(values.origin ?? '') ? new URL(values.origin) : undefined;
  if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search !== '') {
    throw new UsageError('--origin must be an http(s) origin without a path');
  }
  if (values.fixtures !== 'true' && values.fixtures !== 'false') throw new UsageError('--fixtures must be true or false');
  const timeoutS = Number(values['timeout-s']);
  if (!Number.isInteger(timeoutS) || timeoutS < 1) throw new UsageError('--timeout-s must be a positive integer');
  if (!env.MURA_ADMIN_PASSWORD) throw new UsageError('MURA_ADMIN_PASSWORD is required');
  const stateDir = env.OPT2_STATE_DIR || join(env.HOME || homedir(), '.opt2', 'state');
  return {
    origin: origin.origin,
    seedDir: resolve(values['seed-dir'] ?? join(stateDir, 'seed')),
    fixtures: values.fixtures === 'true',
    timeoutMs: timeoutS * 1000,
    username: env.MURA_ADMIN_USERNAME || 'admin',
    password: env.MURA_ADMIN_PASSWORD,
  };
}

/**
 * One HTTP exchange; resolves {status, headers, body} with the body as UTF-8 text.
 * node:http rather than fetch: fetch's bundled undici stops waiting for a response after 300 s, below --timeout-s,
 * and only the undici package, which this script does not depend on, can raise that limit.
 */
function exchange(url, { method, headers, body }, timeoutMs) {
  const transport = url.protocol === 'https:' ? https : http;
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((done, fail) => {
    const onError = (err) => fail(signal.aborted ? new Error(`no response within ${timeoutMs / 1000} s`) : err);
    // agent false: no kept-alive socket holds the process open once the run ends.
    const req = transport.request(url, { method, headers, signal, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', onError);
    });
    req.on('error', onError);
    req.end(body);
  });
}

/** One legacy session: a cookie jar, with redirects followed here so cookies set on them are kept. */
class Session {
  constructor(timeoutMs) {
    this.jar = new CookieJar();
    this.timeoutMs = timeoutMs;
  }

  /** Sends a request and follows up to five redirects; resolves the final response and its URL. */
  async request(url, init = {}) {
    let current = new URL(url);
    let { method = 'GET', headers = {}, body } = init;
    for (let hop = 0; ; hop++) {
      const cookie = await this.jar.getCookieString(current.href);
      const res = await exchange(current, { method, headers: cookie ? { ...headers, cookie } : headers, body }, this.timeoutMs);
      // Invalid cookies are dropped, as a browser drops them.
      for (const value of res.headers['set-cookie'] ?? []) await this.jar.setCookie(value, current.href, { ignoreError: true });
      const location = res.headers.location;
      if (!REDIRECTS.has(res.status) || !location) return { ...res, url: current };
      if (hop === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      current = new URL(location, current);
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        headers = {};
        body = undefined;
      }
    }
  }
}

/** Whether `html` holds a form with a password input, as the admin login page does. */
function isLoginPage(html) {
  return load(html)('form input[name="password"]').length > 0;
}

/** Logs `session` in as the admin by submitting the login form with its CSRF fields; throws SeedError on failure. */
async function login(session, opts) {
  let page;
  try {
    page = await session.request(new URL(LOGIN_PATH, opts.origin));
  } catch (err) {
    throw failed('admin login page', err);
  }
  const $ = load(page.body);
  const form = $('form').filter((_, el) => $(el).find('input[name="password"]').length > 0).first();
  if (page.status !== 200 || form.length === 0) throw new SeedError(`admin login page: HTTP ${page.status} without a login form`);

  const fields = new URLSearchParams();
  form.find('input[name]').each((_, el) => {
    const input = $(el);
    const type = (input.attr('type') ?? 'text').toLowerCase();
    const choice = type === 'checkbox' || type === 'radio';
    if (UNSUBMITTED.has(type) || (choice && input.attr('checked') === undefined)) return;
    fields.append(input.attr('name'), input.attr('value') ?? (choice ? 'on' : ''));
  });
  const missing = CSRF_FIELDS.filter((name) => !fields.has(name));
  if (missing.length > 0) throw new SeedError(`admin login form has no ${missing.join(' or ')} field`);
  fields.set('username', opts.username);
  fields.set('password', opts.password);

  const body = fields.toString();
  let res;
  try {
    res = await session.request(new URL(form.attr('action') || LOGIN_ACTION, page.url), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
      body,
    });
  } catch (err) {
    throw failed('admin login', err);
  }
  if (res.status !== 200 || isLoginPage(res.body)) throw new SeedError('admin login failed');
}

/** Text naming an envelope error: its type (or code) and message. */
function describeError(error) {
  return [error.type ?? error.code, error.message].filter((s) => typeof s === 'string' && s !== '').join(' ');
}

/** Posts one part; resolves {inserted}, or {failure, loggedOut} where loggedOut means a fresh login may cure it. */
async function postPart(session, url, body, label) {
  let res;
  try {
    res = await session.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) },
      body,
    });
  } catch (err) {
    throw failed(label, err);
  }
  let envelope;
  try {
    envelope = JSON.parse(res.body);
  } catch {
    const loginPage = isLoginPage(res.body);
    return { failure: `HTTP ${res.status} ${loginPage ? 'admin login page' : 'body is not JSON'}`, loggedOut: loginPage };
  }
  const error = envelope?.error;
  if (res.status < 200 || res.status > 299 || error !== undefined) {
    const detail = error && typeof error === 'object' ? describeError(error) : '';
    return { failure: `HTTP ${res.status} ${detail}`.trimEnd(), loggedOut: res.status === 401 };
  }
  // Masa moves data's members to the top level when useDataNamespaceForAPI is off.
  const data = envelope?.data ?? envelope;
  if (!Number.isInteger(data?.inserted)) return { failure: `HTTP ${res.status} without an inserted count`, loggedOut: false };
  return { inserted: data.inserted };
}

/** Runs the seed; resolves the exit status. */
async function main(argv, env) {
  const started = Date.now();
  const opts = options(argv, env);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = (line) => process.stderr.write(`${line}\n`);

  const manifest = parseJson(await readFile(join(opts.seedDir, 'manifest.json'), 'utf8'), 'manifest.json');
  if (typeof manifest?.digest !== 'string' || !Array.isArray(manifest.parts)) throw new SeedError('manifest.json has no digest or parts');
  const credentials = parseJson(await readFile(join(opts.seedDir, 'credentials.json'), 'utf8'), 'credentials.json');
  if (credentials?.digest !== manifest.digest) {
    throw new SeedError('credentials.json belongs to another dataset than manifest.json; generate the seed again');
  }

  const session = new Session(opts.timeoutMs);
  await login(session, opts);

  const inserted = {};
  let parts = 0;
  let skipped = 0;
  for (const entry of manifest.parts) {
    const range = `${entry.array} ${entry.offset}+${entry.count}`;
    if (entry.array.startsWith('fixtures.') && !opts.fixtures) {
      skipped++;
      log(`${range} skipped: fixtures unavailable`);
      continue;
    }
    const name = entry.array.startsWith('masa.') ? entry.array.slice('masa.'.length) : entry.array;
    const text = await readFile(join(opts.seedDir, entry.file), 'utf8');
    const part = parseJson(text, entry.file);
    if (part?.digest !== manifest.digest) throw new SeedError(`${entry.file} belongs to another dataset than manifest.json`);
    // Other parts go byte for byte: seed.cfm hands fixture bodies to T-SQL unparsed.
    const body = CREDENTIAL_PARTS.has(name) ? JSON.stringify({ ...part, credentials: credentials[name] }) : text;

    const url = new URL(SEED_PATH, opts.origin);
    url.search = new URLSearchParams({
      part: name,
      offset: String(entry.offset),
      limit: String(entry.count),
      businessDate: manifest.businessDate,
      fixtures: String(opts.fixtures),
    }).toString();
    const label = `seed part ${name} offset ${entry.offset}`;

    let outcome = await postPart(session, url, body, label);
    // A site created by an earlier part re-initialises Masa on the next request, which can end the admin session.
    if (outcome.loggedOut) {
      log(`${range} answered as logged out; logging in again`);
      await login(session, opts);
      outcome = await postPart(session, url, body, label);
    }
    if (outcome.failure !== undefined) throw new SeedError(`${label}: ${outcome.failure}`);

    inserted[entry.array] = (inserted[entry.array] ?? 0) + outcome.inserted;
    parts++;
    log(`${range} inserted ${outcome.inserted}`);
  }

  const durationS = Math.round((Date.now() - started) / 100) / 10;
  process.stdout.write(`${JSON.stringify({ parts, skipped, inserted, digest: manifest.digest, durationS })}\n`);
  return 0;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`seed-legacy: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof UsageError) process.stderr.write(USAGE);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);
