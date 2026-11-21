#!/usr/bin/env node
// Reloads legacy Masa through harness/legacy-baseline/cfml/startup.cfm until one application start-up has run to completion.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node legacy-settle.mjs --origin <url> [--attempts <n>] [--pause-s <n>] [--timeout-s <n>]

Asks <origin>/harness/legacy-baseline/cfml/startup.cfm to re-initialise Masa (op=reload), then whether that
start-up completed (op=status), retrying until it has.

  --origin <url>      legacy origin, straight to ColdFusion (e.g. http://127.0.0.1:8080)
  --attempts <n>      reload attempts before giving up (default 5)
  --pause-s <n>       pause between attempts in seconds (default 3)
  --timeout-s <n>     per-request timeout in seconds (default 900)
  --help              print this help

Key: OPT2_HARNESS_KEY, else \${OPT2_STATE_DIR:-$HOME/.opt2/state}/secrets/harness-diagnostic-key,
sent only as the X-Opt2-Harness-Key header.
Prints one JSON summary line on success. Exit status: 0 settled, 1 failure, 2 usage.
`;

const OPTIONS = {
  origin: { type: 'string' },
  attempts: { type: 'string', default: '5' },
  'pause-s': { type: 'string', default: '3' },
  'timeout-s': { type: 'string', default: '900' },
  help: { type: 'boolean' },
};

const STARTUP_PATH = '/harness/legacy-baseline/cfml/startup.cfm';
// Names, not values; named so the secret scan does not read them as keys.
const HEADER_NAME = 'X-Opt2-Harness-Key';
const VARIABLE_NAME = 'OPT2_HARNESS_KEY';
const KEY_FILE = 'harness-diagnostic-key';
// Matches Masa's bot pattern, so the cookie-less requests get a 2 s session (core/appcfc/applicationSettings.cfm:240-315).
const USER_AGENT = 'opt2-legacy-settle-bot';

/** Failure whose message names only a step, a status or a file, never the key. */
export class SettleError extends Error {}

/** Invalid command line; exits 2. */
class UsageError extends Error {}

/** OPT2_HARNESS_KEY, else the trimmed key file; throws SettleError naming both, never a value, when neither holds a key. */
export function readHarnessKey(env = process.env) {
  if (env[VARIABLE_NAME]) return env[VARIABLE_NAME];
  const file = join(env.OPT2_STATE_DIR || join(env.HOME || homedir(), '.opt2', 'state'), 'secrets', KEY_FILE);
  let key = '';
  try {
    key = readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new SettleError(`cannot read ${file}: ${err?.code ?? err?.message}`);
  }
  if (key === '') throw new SettleError(`no harness diagnostic key: ${VARIABLE_NAME} is unset and ${file} is missing or empty`);
  return key;
}

/**
 * GETs startup.cfm?op=<op> without following redirects; resolves {status, body}.
 * node:http rather than fetch: fetch's bundled undici stops waiting for a response after 300 s.
 */
function get(origin, op, key, timeoutMs) {
  const url = new URL(STARTUP_PATH, origin);
  url.search = new URLSearchParams({ op }).toString();
  const transport = url.protocol === 'https:' ? https : http;
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((done, fail) => {
    const onError = (err) => fail(signal.aborted ? new Error(`no response within ${timeoutMs / 1000} s`) : err);
    const headers = { accept: 'application/json', 'user-agent': USER_AGENT, [HEADER_NAME]: key };
    const req = transport.request(url, { method: 'GET', headers, signal, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', onError);
    });
    req.on('error', onError);
    req.end();
  });
}

/** Resolves {answer} for a 200 JSON answer to op, else {reason}; the body is never echoed. */
async function ask(opts, op) {
  let res;
  try {
    res = await get(opts.origin, op, opts.key, opts.timeoutMs);
  } catch (err) {
    return { reason: `op=${op}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let answer;
  try {
    answer = JSON.parse(res.body);
  } catch {
    answer = undefined;
  }
  if (res.status !== 200) {
    // startup.cfm and Application.cfc answer {error[, type]}; Masa's own error pages are not JSON.
    const detail = [answer?.error, answer?.type].filter((s) => typeof s === 'string' && s !== '').join(' ');
    return { reason: `op=${op}: HTTP ${res.status}${detail === '' ? '' : ` ${detail}`}` };
  }
  if (answer === undefined) return { reason: `op=${op}: HTTP 200 body is not JSON` };
  return { answer };
}

/** One reload followed by a status check; resolves {settled: true, appInitializedTime} or {reason}. */
async function attempt(opts) {
  const reload = await ask(opts, 'reload');
  if (reload.reason !== undefined) return reload;
  if (reload.answer?.reloaded !== true) return { reason: 'op=reload: start-up did not run to completion' };
  const status = await ask(opts, 'status');
  if (status.reason !== undefined) return status;
  if (status.answer?.settled !== true) {
    return { reason: `op=status: not settled (appInitialized ${String(status.answer?.appInitialized)})` };
  }
  return { settled: true, appInitializedTime: status.answer.appInitializedTime ?? null };
}

/**
 * Reloads Masa until a start-up completes; resolves {attempts, appInitializedTime}, throws SettleError after the last attempt.
 * `log` receives one line per unsettled attempt.
 */
export async function settleLegacyStartup({ origin, key, attempts = 5, pauseMs = 3000, timeoutMs = 900_000, log }) {
  for (let n = 1; ; n++) {
    const outcome = await attempt({ origin, key, timeoutMs });
    if (outcome.settled) return { attempts: n, appInitializedTime: outcome.appInitializedTime };
    log?.(`legacy start-up not settled (attempt ${n} of ${attempts}): ${outcome.reason}`);
    if (n >= attempts) throw new SettleError(`legacy start-up did not settle in ${attempts} attempts`);
    await sleep(pauseMs);
  }
}

/** Parses argv into the run options, or {help: true}; throws UsageError. */
function options(argv) {
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
  const [attempts, pauseS, timeoutS] = [values.attempts, values['pause-s'], values['timeout-s']].map(Number);
  if (!Number.isInteger(attempts) || attempts < 1) throw new UsageError('--attempts must be a positive integer');
  if (!Number.isInteger(pauseS) || pauseS < 0) throw new UsageError('--pause-s must be a non-negative integer');
  if (!Number.isInteger(timeoutS) || timeoutS < 1) throw new UsageError('--timeout-s must be a positive integer');
  return { origin: origin.origin, attempts, pauseMs: pauseS * 1000, timeoutMs: timeoutS * 1000 };
}

/** Runs the CLI; resolves the exit status. */
async function main(argv, env) {
  const opts = options(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = (line) => process.stderr.write(`${line}\n`);
  const summary = await settleLegacyStartup({ ...opts, key: readHarnessKey(env), log });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`legacy-settle: ${err instanceof Error ? err.message : String(err)}\n`);
      if (err instanceof UsageError) process.stderr.write(USAGE);
      process.exitCode = err instanceof UsageError ? 2 : 1;
    },
  );
}
