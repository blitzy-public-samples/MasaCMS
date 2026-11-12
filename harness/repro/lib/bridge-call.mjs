#!/usr/bin/env node
// Calls one legacy bridge endpoint with a fresh single-use bridge assertion and prints the answer.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { BRIDGE_ASSERTION_HEADER, signBridgeAssertion } from '@opt2/platform/legacy-compat';

const USAGE = `Usage: node bridge-call.mjs <file> <op> [options]

Calls <origin>/gateway/legacy-bridge/cfml/<file>.cfm?op=<op> (jobs.cfm?job=<op>) with an assertion
signed for <file>.<op>, and prints the response body (contract: gateway/legacy-bridge/README.md).

  <file>                  session | jobs | scheduler | site | files
  <op>                    the page's op, or the job name for jobs
  --site <id>             siteid query parameter, also signed as the assertion's siteId
  --query <k=v>           extra query parameter, repeatable (theTime, lastMonitored, value, since, name, ...)
  --json <body>|@<path>   JSON request body for POST (default {})
  --origin <url>          legacy origin (default LEGACY_ORIGIN, else http://127.0.0.1:\${OPT2_LEGACY_PORT:-$PORT})
  --method GET|POST       default GET for describe, list, usedSince, getCursor and get, POST otherwise
  --timeout-s <n>         request timeout in seconds (default 120)
  --help                  print this help

Key: OPT2_BRIDGE_HMAC_KEY, else \${OPT2_STATE_DIR:-$HOME/.opt2/state}/secrets/bridge-hmac-key.
files put takes a raw byte body and is not supported.
Exit status: 0 2xx answer, 1 failure, 2 usage.
`;

const OPTIONS = /** @type {const} */ ({
  site: { type: 'string' },
  query: { type: 'string', multiple: true },
  json: { type: 'string' },
  origin: { type: 'string' },
  method: { type: 'string' },
  'timeout-s': { type: 'string', default: '120' },
  help: { type: 'boolean' },
});

const FILES = new Set(['session', 'jobs', 'scheduler', 'site', 'files']);
const GET_OPS = new Set(['describe', 'list', 'usedSince', 'getCursor', 'get']);
// The URL scope is case-insensitive in ColdFusion, and these names are bound into the assertion.
const RESERVED_QUERY = new Set(['op', 'job', 'siteid']);
const KEY_FILE = 'bridge-hmac-key';
const ASSERTION_TTL_SECONDS = 60;
// Larger values overflow Node's timer and fire after 1 ms.
const MAX_TIMEOUT_SECONDS = 2_147_483;
const BODY_PREVIEW = 2000;
// No session cookies are sent, so a bot user agent keeps Masa's throwaway session to 2 s (bridge README, Conventions).
const USER_AGENT = 'opt2-legacy-bridge-bot';

/** Invalid command line or environment; exits 2. */
class UsageError extends Error {}

/** A variable's value, undefined when unset or empty. */
function envValue(env, name) {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Splits one `--query k=v` into its name and value. */
function parseQueryPair(pair) {
  const eq = pair.indexOf('=');
  const name = eq < 0 ? '' : pair.slice(0, eq);
  if (name === '') throw new UsageError(`--query needs k=v, got ${pair}`);
  if (RESERVED_QUERY.has(name.toLowerCase())) throw new UsageError(`--query ${name} is set by <op> or --site`);
  return [name, pair.slice(eq + 1)];
}

/** `--origin`, else LEGACY_ORIGIN, else the loopback origin on OPT2_LEGACY_PORT or PORT; without a trailing slash. */
function resolveOrigin(flag, env) {
  const port = envValue(env, 'OPT2_LEGACY_PORT') ?? envValue(env, 'PORT');
  const origin = flag ?? envValue(env, 'LEGACY_ORIGIN') ?? (port === undefined ? '' : `http://127.0.0.1:${port}`);
  if (origin === '') throw new UsageError('no legacy origin: pass --origin or set LEGACY_ORIGIN, OPT2_LEGACY_PORT or PORT');
  if (!URL.canParse(origin)) throw new UsageError(`invalid origin ${origin}`);
  return origin.replace(/\/+$/, '');
}

/** Parses argv into the call to make, or `{help: true}`. */
function parseCommandLine(argv, env) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { help: true };

  const [file, op, ...extra] = positionals;
  if (file === undefined || op === undefined || op === '') throw new UsageError('missing <file> or <op>');
  if (!FILES.has(file)) throw new UsageError(`unknown file ${file}`);
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  if (file === 'files' && op === 'put') throw new UsageError('files put takes a raw byte body, which this script does not send');
  if (values.site === '') throw new UsageError('--site needs a value');

  const method = (values.method ?? (GET_OPS.has(op) ? 'GET' : 'POST')).toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new UsageError('--method must be GET or POST');
  if (method === 'GET' && values.json !== undefined) throw new UsageError('--json needs POST');
  const timeoutS = Number(values['timeout-s']);
  if (!(timeoutS > 0 && timeoutS <= MAX_TIMEOUT_SECONDS)) {
    throw new UsageError(`--timeout-s must be a number in (0, ${MAX_TIMEOUT_SECONDS}]`);
  }

  return {
    file,
    op,
    siteId: values.site,
    query: (values.query ?? []).map(parseQueryPair),
    json: values.json,
    origin: resolveOrigin(values.origin, env),
    method,
    timeoutS,
  };
}

/** The POST body: `--json` text or the file after `@`, checked to be JSON; `{}` without `--json`. */
function readBody(json) {
  if (json === undefined) return '{}';
  if (!json.startsWith('@')) {
    // The parse error is not echoed: a body can carry session secrets.
    if (parseJson(json) === undefined) throw new UsageError('--json is not valid JSON');
    return json;
  }
  const file = json.slice(1);
  let text;
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  if (parseJson(text) === undefined) throw new Error(`${file} is not valid JSON`);
  return text;
}

/** Parsed JSON, or undefined when `text` is not JSON. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The bridge key from OPT2_BRIDGE_HMAC_KEY or the local secrets file; the error names the file, never a value. */
function readKey(env) {
  const fromEnv = envValue(env, 'OPT2_BRIDGE_HMAC_KEY');
  if (fromEnv !== undefined) return fromEnv;
  const stateDir = envValue(env, 'OPT2_STATE_DIR') ?? join(envValue(env, 'HOME') ?? homedir(), '.opt2', 'state');
  const file = join(stateDir, 'secrets', KEY_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`no bridge key: OPT2_BRIDGE_HMAC_KEY is unset and ${file} cannot be read (${error.code ?? error.message})`);
  }
  const key = text.trim();
  if (key === '') throw new Error(`no bridge key: ${file} is empty`);
  return key;
}

/** Pretty JSON for a JSON answer; the raw bytes otherwise, and always for files get, whose bytes must pass unchanged. */
function render(bytes, contentType) {
  if (!/^application\/octet-stream\b/i.test(contentType ?? '')) {
    const value = parseJson(bytes.toString('utf8'));
    if (value !== undefined) return `${JSON.stringify(value, null, 2)}\n`;
  }
  return bytes;
}

/** Sends the signed request and reports the answer; returns the exit status. */
async function call(cmd, body, key) {
  const label = `${cmd.file}.${cmd.op}`;
  const url = new URL(`${cmd.origin}/gateway/legacy-bridge/cfml/${cmd.file}.cfm`);
  url.searchParams.append(cmd.file === 'jobs' ? 'job' : 'op', cmd.op);
  if (cmd.siteId !== undefined) url.searchParams.append('siteid', cmd.siteId);
  for (const [name, value] of cmd.query) url.searchParams.append(name, value);

  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (cmd.method === 'POST') headers['Content-Type'] = 'application/json';
  headers[BRIDGE_ASSERTION_HEADER] = signBridgeAssertion(
    { op: label, siteId: cmd.siteId, ttlSeconds: ASSERTION_TTL_SECONDS },
    key,
  );

  let response;
  let bytes;
  try {
    // A followed redirect would resend the single-use assertion, which the bridge refuses as a replay.
    response = await fetch(url, {
      method: cmd.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.ceil(cmd.timeoutS * 1000)),
    });
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `timed out after ${cmd.timeoutS} s` : (error?.cause?.message ?? error?.message);
    process.stderr.write(`bridge ${label}: ${reason ?? String(error)}\n`);
    return 1;
  }

  if (response.status >= 200 && response.status < 300) {
    process.stdout.write(render(bytes, response.headers.get('content-type')));
    return 0;
  }
  process.stderr.write(`bridge ${label}: HTTP ${response.status}\n`);
  const location = response.headers.get('location');
  if (location !== null) process.stderr.write(`location: ${location}\n`);
  const preview = bytes.toString('utf8').slice(0, BODY_PREVIEW);
  if (preview !== '') process.stderr.write(`${preview}\n`);
  return 1;
}

/** Entry point; returns the exit status. */
async function main(argv, env) {
  const cmd = parseCommandLine(argv, env);
  if (cmd.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const body = cmd.method === 'POST' ? readBody(cmd.json) : undefined;
  return call(cmd, body, readKey(env));
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`bridge-call: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
