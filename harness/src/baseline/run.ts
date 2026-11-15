// Legacy TestBox runners: calls the official Masa runner and the diagnostic runner and saves their raw responses.
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { createHttpSession } from '../lib/http.js';
import { stateDir, type EnvLike } from '../lib/paths.js';
import { stableStringify } from '../lib/report.js';

/** Untouched Masa runner; it discovers every spec bundle, so ACF fails compiling `bundleValidatorSecurity`. */
export const OFFICIAL_RUNNER_PATH = '/core/tests/runner.cfm?reporter=json';

/** Diagnostic runner with the explicit 22-bundle list. */
export const DIAGNOSTIC_RUNNER_PATH = '/harness/legacy-baseline/cfml/run.cfm?reporter=json';

/** Request deadline for both runners, above `run.cfm`'s 1,800 s `requesttimeout`. */
export const DIAGNOSTIC_TIMEOUT_MS = 35 * 60 * 1000;

const USAGE = 'usage: npm run baseline:run (takes no flags)';
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** One runner response as saved under `${OPT2_STATE_DIR}/baseline/`. */
export type SavedRunnerResponse = {
  runner: 'official' | 'diagnostic';
  url: string;
  httpStatus: number;
  contentType: string | null;
  startedAt: string;
  durationMs: number;
  bodyKind: 'json' | 'text';
  /** TestBox `totalSpecs`, or 0 when the body is not TestBox JSON. */
  specs: number;
  /** Parsed JSON when the body is JSON, else the raw text. */
  body: unknown;
};

/** Injectable process boundary; defaults are `process.env`, {@link longRequestFetch}, the system clock and {@link DIAGNOSTIC_TIMEOUT_MS}. */
export type RunDeps = {
  env?: EnvLike;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

/** Legacy ColdFusion origin: `LEGACY_ORIGIN`, else `http://127.0.0.1:${PORT}`; never the gateway. */
export function legacyOrigin(env: EnvLike): string {
  if (env.LEGACY_ORIGIN) return env.LEGACY_ORIGIN;
  if (env.PORT) return `http://127.0.0.1:${env.PORT}`;
  throw new UsageError('LEGACY_ORIGIN or PORT must name the legacy ColdFusion origin', USAGE);
}

/** Directory holding the saved runner responses, `<state>/baseline`. */
export function baselineStateDir(env: EnvLike = process.env): string {
  return join(stateDir(env), 'baseline');
}

/** Copy of `value` with every object key lower-cased at every depth; values are untouched. */
export function lowerKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key.toLowerCase(), lowerKeysDeep(child)]));
}

// Node's fetch (undici) aborts when response headers take over 300 s, and ACF sends none until a TestBox run ends.
/** Fetch-compatible client on `node:http`/`node:https` that buffers the response; only the caller's signal bounds it. */
export const longRequestFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
  const { signal } = request;
  const url = new URL(request.url);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const fail = (err: unknown): void => reject(signal.aborted ? signal.reason : err);
    const options = { method: request.method, headers: Object.fromEntries(request.headers.entries()), signal };
    const req = send(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('close', () => {
        if (!res.complete) fail(new Error(`response from ${url.origin} closed before it completed`));
      });
      res.on('end', () => {
        const headers = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const status = res.statusCode ?? 0;
        const payload = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks);
        try {
          resolve(new Response(payload, { status, statusText: res.statusMessage ?? '', headers }));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', fail);
    req.end(body);
  });
};

function totalSpecs(body: unknown): number {
  const lowered = lowerKeysDeep(body);
  if (lowered === null || typeof lowered !== 'object' || Array.isArray(lowered)) return 0;
  const total = (lowered as Record<string, unknown>).totalspecs;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

async function callRunner(
  runner: SavedRunnerResponse['runner'],
  path: string,
  file: string,
  deps: RunDeps,
): Promise<SavedRunnerResponse> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const dir = baselineStateDir(env);
  await mkdir(dir, { recursive: true });
  const session = createHttpSession({ baseUrl: legacyOrigin(env), fetch: deps.fetch ?? longRequestFetch });

  const started = now();
  // The session's own deadline is the only bound; a caller signal could not extend its 300 s default.
  const result = await session.get(path, { timeoutMs: deps.timeoutMs ?? DIAGNOSTIC_TIMEOUT_MS });
  const durationMs = now().getTime() - started.getTime();

  let parsed: Pick<SavedRunnerResponse, 'bodyKind' | 'body'>;
  try {
    parsed = { bodyKind: 'json', body: result.json() };
  } catch {
    parsed = { bodyKind: 'text', body: result.text };
  }
  const contentType = result.headers['content-type'];
  const saved: SavedRunnerResponse = {
    runner,
    url: result.url,
    httpStatus: result.status,
    contentType: typeof contentType === 'string' ? contentType : null,
    startedAt: started.toISOString(),
    durationMs,
    bodyKind: parsed.bodyKind,
    specs: parsed.bodyKind === 'json' ? totalSpecs(parsed.body) : 0,
    body: parsed.body,
  };
  await writeFile(join(dir, file), stableStringify(saved), 'utf8');
  return saved;
}

/** Calls the official runner and saves `official.json`. */
export async function runOfficial(deps: RunDeps = {}): Promise<SavedRunnerResponse> {
  return callRunner('official', OFFICIAL_RUNNER_PATH, 'official.json', deps);
}

/** Calls the diagnostic runner and saves `diagnostic.json`, or `diagnostic-rerun.json` when `rerun` is set. */
export async function runDiagnostic(opts: { rerun?: boolean } = {}, deps: RunDeps = {}): Promise<SavedRunnerResponse> {
  return callRunner('diagnostic', DIAGNOSTIC_RUNNER_PATH, opts.rerun ? 'diagnostic-rerun.json' : 'diagnostic.json', deps);
}

/** CLI entry: runs the official then the diagnostic runner; every HTTP status is a recorded result. */
export async function main(argv: string[], deps: RunDeps = {}): Promise<CliOutcome> {
  parseFlags(argv, { options: {}, usage: USAGE });
  const official = await runOfficial(deps);
  const diagnostic = await runDiagnostic({}, deps);
  return {
    code: 0,
    summary: {
      official: { httpStatus: official.httpStatus, specs: official.specs },
      diagnostic: { httpStatus: diagnostic.httpStatus, specs: diagnostic.specs, durationMs: diagnostic.durationMs },
      savedTo: baselineStateDir(deps.env ?? process.env),
    },
  };
}

if (isMainModule(import.meta.url)) void runCli(main);
