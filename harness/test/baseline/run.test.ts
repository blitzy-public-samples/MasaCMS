import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  DIAGNOSTIC_RUNNER_PATH,
  DIAGNOSTIC_TIMEOUT_MS,
  OFFICIAL_RUNNER_PATH,
  baselineStateDir,
  legacyOrigin,
  longRequestFetch,
  lowerKeysDeep,
  main,
  runDiagnostic,
  runOfficial,
  type RunDeps,
  type SavedRunnerResponse,
} from '../../src/baseline/run.js';
import { UsageError, runCli } from '../../src/lib/cli.js';
import { HARNESS_KEY_VARIABLE } from '../../src/lib/harness-key.js';
import { HttpRequestError } from '../../src/lib/http.js';
import { REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import { stableStringify } from '../../src/lib/report.js';

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, request: vi.fn() };
});

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn() };
});

const LEGACY = 'http://legacy.test';
const COMMAND = 'harness/src/baseline/run.ts';
const USAGE = 'usage: npm run baseline:run (takes no flags)';
const OFFICIAL_FIXTURE = JSON.parse(
  await fs.readFile(new URL('../fixtures/testbox/official-500.json', import.meta.url), 'utf8'),
) as SavedRunnerResponse;
const DIAGNOSTIC_TEXT = await fs.readFile(new URL('../fixtures/testbox/diagnostic-match.json', import.meta.url), 'utf8');
const DIAGNOSTIC_BODY = JSON.parse(DIAGNOSTIC_TEXT) as Record<string, unknown>;
// Test value assembled at run time, not a secret.
const KEY = ['opt2', 'harness', 'run', 'test'].join('-');

interface Sent {
  url: string;
  method: string | undefined;
  /** The X-Opt2-Harness-Key header sent, if any. */
  key: string | undefined;
}

interface FakeFetch {
  fetch: Mock<typeof fetch>;
  sent: Sent[];
}

/** One request the in-memory `node:http`/`node:https` transport received. */
interface Exchange {
  transport: 'http' | 'https';
  method: string | undefined;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** IncomingMessage stand-in: a body stream with the status line, raw headers and `complete`. */
class FakeResponse extends PassThrough {
  complete = false;

  constructor(
    readonly statusCode: number,
    readonly statusMessage: string,
    readonly rawHeaders: string[],
  ) {
    super();
  }

  /** Ends the body and marks the message complete, as node does before 'end'. */
  finish(body = ''): void {
    this.complete = true;
    this.end(body);
  }
}

/** Answers one exchange by passing a response to `respond`, or by emitting 'error' on `req`. */
type Script = (exchange: Exchange, respond: (res: FakeResponse) => void, req: EventEmitter) => void;

let tmp: string;
let env: EnvLike;
let exchanges: Exchange[];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-baseline-run-'));
  env = { OPT2_STATE_DIR: tmp, LEGACY_ORIGIN: LEGACY, OPT2_HARNESS_KEY: KEY };
  exchanges = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(httpRequest).mockReset();
  vi.mocked(httpsRequest).mockReset();
  await fs.rm(tmp, { recursive: true, force: true });
});

function officialResponse(): Response {
  return new Response(OFFICIAL_FIXTURE.body as string, {
    status: 500,
    headers: { 'content-type': OFFICIAL_FIXTURE.contentType ?? 'text/html' },
  });
}

function diagnosticResponse(text: string = DIAGNOSTIC_TEXT, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

/** Fake fetch recording each URL, method and harness key; `answer` builds the response for a URL. */
function recordingFetch(answer: (url: string) => Response | Promise<Response>): FakeFetch {
  const sent: Sent[] = [];
  const fetchFake = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, method: init?.method, key: new Headers(init?.headers).get('x-opt2-harness-key') ?? undefined });
    return answer(url);
  });
  return { fetch: fetchFake, sent };
}

/** Serves the official fixture on the official path and the diagnostic fixture on any other. */
function routedFetch(): FakeFetch {
  return recordingFetch((url) => (url.endsWith(OFFICIAL_RUNNER_PATH) ? officialResponse() : diagnosticResponse()));
}

/** Clock returning `startIso` first and `stepMs` later on every further call. */
function tickingClock(startIso: string, stepMs: number): () => Date {
  const start = Date.parse(startIso);
  let calls = 0;
  return () => new Date(start + stepMs * calls++);
}

/** `request` stand-in for `transport`: records each exchange on `end` and runs `script` on a later turn. */
function fakeRequest(transport: Exchange['transport'], script: Script) {
  return (url: URL, options: RequestOptions, onResponse: (res: FakeResponse) => void): EventEmitter => {
    const req = new EventEmitter();
    const { signal } = options;
    const abort = (): void => {
      req.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    };
    if (signal?.aborted) queueMicrotask(abort);
    else signal?.addEventListener('abort', abort, { once: true });
    return Object.assign(req, {
      end(body?: Buffer): void {
        const exchange: Exchange = {
          transport,
          method: options.method,
          url: url.href,
          headers: { ...(options.headers as Record<string, string>) },
          body: body?.toString('utf8') ?? '',
        };
        exchanges.push(exchange);
        setImmediate(() => script(exchange, onResponse, req));
      },
    });
  };
}

/** Routes `node:http` and `node:https` requests to `script`. */
function serve(script: Script): void {
  vi.mocked(httpRequest).mockImplementation(fakeRequest('http', script) as unknown as typeof httpRequest);
  vi.mocked(httpsRequest).mockImplementation(fakeRequest('https', script) as unknown as typeof httpsRequest);
}

async function readSaved(file: string): Promise<{ text: string; saved: SavedRunnerResponse }> {
  const text = await fs.readFile(path.join(tmp, 'baseline', file), 'utf8');
  return { text, saved: JSON.parse(text) as SavedRunnerResponse };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

describe('runner constants', () => {
  it('names the untouched official runner and the diagnostic runner with the JSON reporter', () => {
    expect(OFFICIAL_RUNNER_PATH).toBe('/core/tests/runner.cfm?reporter=json');
    expect(DIAGNOSTIC_RUNNER_PATH).toBe('/harness/legacy-baseline/cfml/run.cfm?reporter=json');
  });

  it('allows a positive request deadline above the 1,800 s diagnostic request timeout', () => {
    expect(DIAGNOSTIC_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DIAGNOSTIC_TIMEOUT_MS).toBeGreaterThan(1_800_000);
  });
});

// legacy-start.sh turns schema management off; the specs' ORM test entities recurse to a StackOverflowError without it.
describe('run.cfm applyDbUpdates handling', () => {
  const RUN_CFM = path.join(REPO_ROOT, 'harness', 'legacy-baseline', 'cfml', 'run.cfm');
  const TESTBOX_BRANCH = /<cfif\s+not\s+structKeyExists\s*\(\s*url\s*,\s*(["'])info\1\s*\)\s*>/i;
  const INFO_BRANCH = /<cfelseif\s+url\.info\s+eq\s+(["'])1\1\s*>/i;
  const READ = /<cfset\s+(\w+)\s*=[^>]*?\b(?:configValue|getValue)\s*\(\s*(?:property\s*=\s*)?(["'])applyDbUpdates\2/gi;
  const WRITE =
    /\.set(?:Value)?\s*\(\s*(?:property\s*=\s*)?(["'])applyDbUpdates\1\s*,\s*(?:propertyValue\s*=\s*)?([^)]*?)\s*\)|\.setApplyDbUpdates\s*\(\s*([^)]*?)\s*\)/gi;

  interface Span {
    open: number;
    close: number;
  }

  function offsetOf(text: string, pattern: RegExp): number {
    const offset = text.search(pattern);
    expect(offset, `run.cfm lacks ${pattern}`).toBeGreaterThanOrEqual(0);
    return offset;
  }

  function tagSpans(text: string, tag: string): Span[] {
    const spans: Span[] = [];
    const opens: number[] = [];
    for (const m of text.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi'))) {
      if (m[1] === '') {
        opens.push(m.index);
        continue;
      }
      const open = opens.pop();
      if (open === undefined) throw new Error(`unmatched </${tag}> at offset ${m.index}`);
      spans.push({ open, close: m.index + m[0].length });
    }
    if (opens.length > 0) throw new Error(`unclosed <${tag}> at offset ${opens.join(', ')}`);
    return spans;
  }

  function writes(text: string): { offset: number; value: string }[] {
    return [...text.matchAll(WRITE)].map((m) => ({
      offset: m.index,
      value: (m[2] ?? m[3] ?? '').replace(/^(["'])(.*)\1$/, '$2').toLowerCase(),
    }));
  }

  async function testboxRun(): Promise<{ cfm: string; start: number; branch: string; run: number; cftry: Span; cffinally: Span }> {
    const cfm = (await fs.readFile(RUN_CFM, 'utf8')).replace(/<!---[\s\S]*?--->/g, (comment) => ' '.repeat(comment.length));
    const start = offsetOf(cfm, TESTBOX_BRANCH);
    const branch = cfm.slice(start, offsetOf(cfm, INFO_BRANCH));
    const run = offsetOf(branch, /\b\w+\.run\s*\(/i);
    const tries = tagSpans(branch, 'cftry');
    const [cftry] = tries.filter((span) => span.open < run && run < span.close).sort((a, b) => b.open - a.open);
    if (cftry === undefined) throw new Error('r.run( is not inside a <cftry>');
    const nested = tries.filter((span) => cftry.open < span.open && span.close < cftry.close);
    const finallies = tagSpans(branch, 'cffinally').filter(
      (span) =>
        cftry.open < span.open &&
        span.close < cftry.close &&
        !nested.some((inner) => inner.open < span.open && span.close < inner.close),
    );
    const [cffinally] = finallies;
    if (cffinally === undefined || finallies.length > 1) {
      throw new Error(`the <cftry> around r.run( has ${finallies.length} <cffinally> of its own, not 1`);
    }
    return { cfm, start, branch, run, cftry, cffinally };
  }

  it("turns schema management on for the TestBox run and restores the value read before it in that cftry's cffinally", async () => {
    const { branch, run, cftry, cffinally } = await testboxRun();
    const prior = [...branch.slice(0, cftry.open).matchAll(READ)].at(-1)?.[1];
    const place = (offset: number): string =>
      offset < run ? 'before r.run(' : cffinally.open < offset && offset < cffinally.close ? 'cffinally' : 'after r.run(';

    expect(prior, 'applyDbUpdates is saved before the <cftry>').toBeDefined();
    expect(
      writes(branch)
        .filter(({ offset }) => cftry.open < offset && offset < cftry.close)
        .map(({ offset, value }) => ({ place: place(offset), value })),
    ).toEqual([
      { place: 'before r.run(', value: 'true' },
      { place: 'cffinally', value: prior?.toLowerCase() },
    ]);
  });

  it('changes applyDbUpdates nowhere outside that cftry, so the info=1 probe reports it as configured', async () => {
    const { cfm, start, cftry } = await testboxRun();

    expect(writes(cfm).filter(({ offset }) => offset < start + cftry.open || start + cftry.close < offset)).toEqual([]);
  });
});

// A start-up that requests interrupt stays flagged initialised; the settle stamps only a reload that ran to completion.
describe('Application.cfc and startup.cfm start-up settling', () => {
  const CFML_DIR = path.join(REPO_ROOT, 'harness', 'legacy-baseline', 'cfml');
  const LOCK = (type: string): RegExp => new RegExp(`\\block\\s+name\\s*=\\s*"appInitBlock#application\\.instanceID#"\\s+type\\s*=\\s*"${type}"`, 'i');
  const STAMP = /\bapplication\.opt2StartupSettledAt\s*=(?!=)/gi;

  /** The file's text with CFML and script comments blanked, so offsets are kept. */
  async function source(file: string): Promise<string> {
    const text = await fs.readFile(path.join(CFML_DIR, file), 'utf8');
    return text.replace(/<!---[\s\S]*?--->|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
  }

  /** The brace-delimited block after the first match of `head` in `text`, with the offset of its `{`. */
  function block(text: string, head: RegExp): { open: number; body: string } {
    const match = head.exec(text);
    if (match === null) throw new Error(`no ${head}`);
    const open = text.indexOf('{', match.index + match[0].length);
    let depth = 0;
    for (let i = open; i >= 0 && i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}' && --depth === 0) return { open, body: text.slice(open, i + 1) };
    }
    throw new Error(`no closed block after ${head}`);
  }

  /** Offset of `pattern` in `text`, failing the test when it is absent. */
  function offsetIn(text: string, pattern: RegExp): number {
    const offset = text.search(pattern);
    expect(offset, `missing ${pattern}`).toBeGreaterThanOrEqual(0);
    return offset;
  }

  it('reloads only for startup.cfm?op=reload; every other admitted request keeps reloads blocked', async () => {
    const { body } = block(await source('Application.cfc'), /boolean\s+function\s+onRequestStart\s*\(/i);

    expect(body).toMatch(/!listFindNoCase\s*\(\s*"run\.cfm,startup\.cfm"\s*,\s*page\s*\)/i);
    const branch = offsetIn(
      body,
      /if\s*\(\s*compareNoCase\s*\(\s*page\s*,\s*"startup\.cfm"\s*\)\s*==\s*0\s*&&\s*structKeyExists\s*\(\s*url\s*,\s*"op"\s*\)\s*&&\s*url\.op\s*==\s*"reload"\s*\)\s*\{\s*return\s+reloadMasa\s*\(\s*\)\s*;/i,
    );
    expect(offsetIn(body, /request\.muraAppreloaded\s*=\s*true/i)).toBeGreaterThan(branch);
  });

  it('stamps a reload inside an exclusive appInitBlock lock, after super.onRequestStart() returns, and nowhere else', async () => {
    const cfc = await source('Application.cfc');
    const reload = block(cfc, /private\s+boolean\s+function\s+reloadMasa\s*\(/i);
    const lock = block(reload.body, LOCK('exclusive'));
    const cleared = offsetIn(lock.body, /structDelete\s*\(\s*application\s*,\s*"opt2StartupSettledAt"\s*\)/i);
    const triggered = offsetIn(lock.body, /application\.appInitialized\s*=\s*false/i);
    const started = offsetIn(lock.body, /super\.onRequestStart\s*\(\s*\)/i);
    const stamped = offsetIn(lock.body, STAMP);

    expect([cleared < triggered, triggered < started, started < stamped]).toEqual([true, true, true]);
    expect(lock.body.slice(started, stamped)).toMatch(/if\s*\(\s*application\.appInitialized\s*&&\s*after\s*>\s*before\s*\)/i);
    expect([...cfc.matchAll(STAMP)].map((m) => m.index)).toEqual([reload.open + lock.open + stamped]);
    expect([...(await source('startup.cfm')).matchAll(STAMP)]).toEqual([]);
  });

  it('answers op=status from values read under a readonly appInitBlock lock, comparing epoch ms rather than dates', async () => {
    const cfm = await source('startup.cfm');
    const status = cfm.slice(offsetIn(cfm, /<cfelseif\s+url\.op\s+eq\s+"status"\s*>/i));
    const lock = block(status, LOCK('readonly'));

    expect(lock.body).toMatch(/\binitializedAt\s*=\s*initializedMs\s*\(\s*\)/i);
    expect(lock.body).toMatch(/\bsettledAt\s*=\s*settledMs\s*\(\s*\)/i);
    expect(block(cfm, /function\s+initializedMs\s*\(/i).body).toMatch(/\.getTime\s*\(\s*\)/);
    expect(status).toMatch(/answer\["settled"\]\s*=\s*javaCast\(\s*"boolean"\s*,\s*initialized\s*&&\s*settledAt\s*>\s*0\s*&&\s*settledAt\s*==\s*initializedAt\s*\)/i);
    expect(cfm).not.toMatch(/appInitializedTime\s*(?:==|!=|\beq\b|\bneq\b)/i);
  });
});


describe('baselineStateDir and legacyOrigin', () => {
  it('places saved responses in <state>/baseline', () => {
    expect(baselineStateDir(env)).toBe(path.join(tmp, 'baseline'));
  });

  it('reads OPT2_STATE_DIR from process.env by default', () => {
    vi.stubEnv('OPT2_STATE_DIR', tmp);

    expect(baselineStateDir()).toBe(path.join(tmp, 'baseline'));
  });

  it('refuses a state directory inside the checkout', () => {
    expect(() => baselineStateDir({ OPT2_STATE_DIR: path.join(REPO_ROOT, 'harness', 'state') })).toThrow(
      /must be outside the repository checkout/,
    );
  });

  it.each([
    [{ LEGACY_ORIGIN: LEGACY, PORT: '8500' }, LEGACY],
    [{ PORT: '8500' }, 'http://127.0.0.1:8500'],
    [{ LEGACY_ORIGIN: '', PORT: '8080' }, 'http://127.0.0.1:8080'],
  ])('resolves the legacy origin from %o', (vars, origin) => {
    expect(legacyOrigin(vars)).toBe(origin);
  });

  it('throws a UsageError carrying the usage text when neither LEGACY_ORIGIN nor PORT is set', () => {
    expect(() => legacyOrigin({})).toThrow(UsageError);
    expect(() => legacyOrigin({})).toThrow(/LEGACY_ORIGIN or PORT/);
    try {
      legacyOrigin({});
    } catch (err) {
      expect((err as UsageError).usage).toBe(USAGE);
    }
  });
});

describe('runOfficial', () => {
  it('saves the official runner 500 with 0 specs to official.json', async () => {
    const { fetch, sent } = routedFetch();

    const result = await runOfficial({ env, fetch, now: tickingClock('2026-06-30T00:00:00.000Z', 412) });

    expect(sent).toEqual([{ url: `${LEGACY}${OFFICIAL_RUNNER_PATH}`, method: 'GET', key: undefined }]);
    const { text, saved } = await readSaved('official.json');
    expect(saved).toEqual(result);
    expect(text).toBe(stableStringify(result));
    expect(saved).toMatchObject({
      runner: 'official',
      url: `${LEGACY}${OFFICIAL_RUNNER_PATH}`,
      httpStatus: 500,
      contentType: 'text/html;charset=UTF-8',
      bodyKind: 'text',
      specs: 0,
      durationMs: 412,
    });
    expect(saved.body).toContain('bundleValidatorSecurity.cfc: line 36');
  });

  it('falls back to http://127.0.0.1:${PORT} and reproduces the saved official fixture', async () => {
    const { fetch, sent } = routedFetch();

    const result = await runOfficial({
      env: { OPT2_STATE_DIR: tmp, PORT: '8500' },
      fetch,
      now: tickingClock(OFFICIAL_FIXTURE.startedAt, OFFICIAL_FIXTURE.durationMs),
    });

    expect(sent.map((request) => request.url)).toEqual([`http://127.0.0.1:8500${OFFICIAL_RUNNER_PATH}`]);
    expect(result).toEqual(OFFICIAL_FIXTURE);
    expect((await readSaved('official.json')).saved).toEqual(OFFICIAL_FIXTURE);
  });

  it('defaults to process.env and the system clock', async () => {
    vi.stubEnv('OPT2_STATE_DIR', tmp);
    vi.stubEnv('LEGACY_ORIGIN', LEGACY);
    const { fetch, sent } = routedFetch();
    const before = Date.now();

    const result = await runOfficial({ fetch });

    expect(sent).toHaveLength(1);
    expect(Date.parse(result.startedAt)).toBeGreaterThanOrEqual(before);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect((await readSaved('official.json')).saved).toEqual(result);
  });
});

describe('runDiagnostic', () => {
  it('saves the 200 diagnostic run to diagnostic.json with the TestBox totals as the source stores them', async () => {
    const { fetch, sent } = routedFetch();

    const result = await runDiagnostic(undefined, { env, fetch, now: tickingClock('2026-06-30T00:00:00.000Z', 1878) });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url.endsWith(DIAGNOSTIC_RUNNER_PATH)).toBe(true);
    expect(sent[0]?.key).toBe(KEY);
    const { text, saved } = await readSaved('diagnostic.json');
    expect(text).toBe(stableStringify(result));
    expect(saved).toMatchObject({
      runner: 'diagnostic',
      url: `${LEGACY}${DIAGNOSTIC_RUNNER_PATH}`,
      httpStatus: 200,
      contentType: 'application/json',
      startedAt: '2026-06-30T00:00:00.000Z',
      durationMs: 1878,
      bodyKind: 'json',
      specs: 683,
    });
    expect(saved.body).toEqual(DIAGNOSTIC_BODY);
    expect(saved.body).toMatchObject({ totalBundles: 22, totalSpecs: 683, totalPass: 662, totalFail: 21, totalError: 0 });
    expect(await exists(path.join(tmp, 'baseline', 'diagnostic-rerun.json'))).toBe(false);
  });

  it('saves a re-run to diagnostic-rerun.json and leaves diagnostic.json byte-for-byte unchanged', async () => {
    await runDiagnostic({}, { env, fetch: routedFetch().fetch, now: tickingClock('2026-06-30T00:00:00.000Z', 1878) });
    const first = await fs.readFile(path.join(tmp, 'baseline', 'diagnostic.json'));
    const rerunText = DIAGNOSTIC_TEXT.replace('"totalDuration": 1878', '"totalDuration": 1999');
    const { fetch } = recordingFetch(() => diagnosticResponse(rerunText));

    const rerun = await runDiagnostic({ rerun: true }, { env, fetch, now: tickingClock('2026-06-30T01:00:00.000Z', 1999) });

    expect((await fs.readFile(path.join(tmp, 'baseline', 'diagnostic.json'))).equals(first)).toBe(true);
    const { saved } = await readSaved('diagnostic-rerun.json');
    expect(saved).toEqual(rerun);
    expect(saved).toMatchObject({ runner: 'diagnostic', durationMs: 1999, specs: 683 });
    expect(saved.body).toMatchObject({ totalDuration: 1999 });
  });

  it('records a non-200 status as a result rather than failing', async () => {
    const { fetch } = recordingFetch(() => diagnosticResponse('{"totalSpecs":0,"error":"boom"}', 503));

    const result = await runDiagnostic({}, { env, fetch });

    expect(result).toMatchObject({ httpStatus: 503, bodyKind: 'json', specs: 0, body: { totalSpecs: 0, error: 'boom' } });
    expect((await readSaved('diagnostic.json')).saved).toEqual(result);
  });

  it('keeps a non-JSON body as text with 0 specs', async () => {
    const page = '<h1>Access Restricted.</h1>\n<br/>Testbox enabled: false';
    const { fetch } = recordingFetch(
      () => new Response(page, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } }),
    );

    const result = await runDiagnostic({}, { env, fetch });

    expect(result).toMatchObject({ httpStatus: 200, contentType: 'text/html;charset=UTF-8', bodyKind: 'text', specs: 0 });
    expect(result.body).toBe(page);
  });

  it('records a missing content type as null', async () => {
    const { fetch } = recordingFetch(() => new Response(new TextEncoder().encode('{"totalSpecs":7}'), { status: 200 }));

    const result = await runDiagnostic({}, { env, fetch });

    expect(result).toMatchObject({ contentType: null, bodyKind: 'json', specs: 7 });
  });

  it.each([
    ['{"TOTALSPECS":5}', 5],
    ['{"TotalSpecs":"683"}', 0],
    ['{"totalSpecs":null}', 0],
    ['[{"totalSpecs":3}]', 0],
    ['null', 0],
    ['42', 0],
    ['{}', 0],
  ])('counts specs from the JSON body %s as %d', async (text, specs) => {
    const { fetch } = recordingFetch(() => diagnosticResponse(text));

    const result = await runDiagnostic({}, { env, fetch });

    expect(result.bodyKind).toBe('json');
    expect(result.specs).toBe(specs);
    expect(result.body).toEqual(JSON.parse(text));
  });

  it('rejects with an HttpRequestError and saves nothing when the request fails', async () => {
    const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    const { fetch } = recordingFetch(() => Promise.reject(refused));

    const run = runDiagnostic({}, { env, fetch });

    await expect(run).rejects.toBeInstanceOf(HttpRequestError);
    await expect(run).rejects.toThrow(/request failed \(ECONNREFUSED\): GET http:\/\/legacy\.test\/harness\/legacy-baseline/);
    expect(await exists(path.join(tmp, 'baseline', 'diagnostic.json'))).toBe(false);
  });

  it('rejects with an HttpRequestError once the injected deadline passes', async () => {
    const fetchFake = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        }),
    );

    const run = runDiagnostic({}, { env, fetch: fetchFake, timeoutMs: 25 });

    await expect(run).rejects.toBeInstanceOf(HttpRequestError);
    await expect(run).rejects.toThrow(/timed out after 25 ms/);
    expect(await exists(path.join(tmp, 'baseline', 'diagnostic.json'))).toBe(false);
  });

  it('rejects with a UsageError before any request when no legacy origin is configured', async () => {
    const { fetch } = routedFetch();

    await expect(runDiagnostic({}, { env: { OPT2_STATE_DIR: tmp }, fetch })).rejects.toBeInstanceOf(UsageError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects naming OPT2_HARNESS_KEY and the key file, before any request or write, when no key is configured', async () => {
    const { fetch } = routedFetch();
    const keyFile = path.join(tmp, 'secrets', 'harness-diagnostic-key');

    await expect(runDiagnostic({}, { env: { OPT2_STATE_DIR: tmp, LEGACY_ORIGIN: LEGACY }, fetch })).rejects.toThrow(
      `no harness diagnostic key: ${HARNESS_KEY_VARIABLE} is unset and ${keyFile} is missing or empty`,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await exists(path.join(tmp, 'baseline'))).toBe(false);
  });

  it('rejects before any request or write when the state directory is inside the checkout', async () => {
    const inside = path.join(REPO_ROOT, 'harness', 'opt2-baseline-run-state');
    const { fetch } = routedFetch();

    await expect(runDiagnostic({}, { env: { OPT2_STATE_DIR: inside, LEGACY_ORIGIN: LEGACY }, fetch })).rejects.toThrow(
      /OPT2_STATE_DIR must be outside the repository checkout/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await exists(inside)).toBe(false);
  });
});

describe('lowerKeysDeep', () => {
  it('lower-cases keys at every depth through nested objects and arrays, leaving values and the input untouched', () => {
    const input = {
      TotalSpecs: 1,
      BundleStats: [{ SuiteStats: [{ SpecStats: [{ Name: 'X', FailMessage: 'should match schema datatype VARCHAR' }] }] }],
      Labels: ['MixedCase', 2, null],
      Nested: { InnerKey: { DeepKey: 'VARCHAR' } },
    };
    const snapshot = structuredClone(input);

    const lowered = lowerKeysDeep(input);

    expect(lowered).toEqual({
      totalspecs: 1,
      bundlestats: [{ suitestats: [{ specstats: [{ name: 'X', failmessage: 'should match schema datatype VARCHAR' }] }] }],
      labels: ['MixedCase', 2, null],
      nested: { innerkey: { deepkey: 'VARCHAR' } },
    });
    expect(lowered).not.toBe(input);
    expect(input).toEqual(snapshot);
  });

  it.each([42, 'VARCHAR', true, null, undefined])('passes the primitive %s through unchanged', (value) => {
    expect(lowerKeysDeep(value)).toBe(value);
  });

  it('maps an array of primitives to an equal new array', () => {
    const input = ['FLOAT', 1, null];

    const lowered = lowerKeysDeep(input);

    expect(lowered).toEqual(input);
    expect(lowered).not.toBe(input);
  });
});

describe('longRequestFetch over node:http and node:https', () => {
  it('returns a delayed 500 with its headers and JSON body', async () => {
    serve((_exchange, respond) => {
      setTimeout(() => {
        const rawHeaders = ['content-type', 'application/json', 'X-Opt2-Probe', 'delayed'];
        const res = new FakeResponse(500, 'Internal Server Error', rawHeaders);
        respond(res);
        res.finish(JSON.stringify({ error: 'boom', totalSpecs: 0 }));
      }, 50);
    });
    const started = performance.now();

    const res = await longRequestFetch(`${LEGACY}${OFFICIAL_RUNNER_PATH}`);

    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
    expect(res.status).toBe(500);
    expect(res.statusText).toBe('Internal Server Error');
    expect(res.headers.get('x-opt2-probe')).toBe('delayed');
    expect(res.headers.get('X-OPT2-PROBE')).toBe('delayed');
    expect(await res.json()).toEqual({ error: 'boom', totalSpecs: 0 });
  });

  it('returns a 200 text body and sends a GET to the requested path', async () => {
    serve((_exchange, respond) => {
      const res = new FakeResponse(200, 'OK', ['content-type', 'text/plain; charset=utf-8']);
      respond(res);
      res.finish('runner ready');
    });

    const res = await longRequestFetch(new URL(`${LEGACY}${DIAGNOSTIC_RUNNER_PATH}`));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('runner ready');
    expect(exchanges).toEqual([
      { transport: 'http', method: 'GET', url: `${LEGACY}${DIAGNOSTIC_RUNNER_PATH}`, headers: {}, body: '' },
    ]);
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('sends a POST body and headers, which the transport echoes', async () => {
    serve((exchange, respond) => {
      const res = new FakeResponse(200, 'OK', ['content-type', 'application/json']);
      respond(res);
      const { method, headers, body } = exchange;
      res.finish(JSON.stringify({ method, contentType: headers['content-type'], body }));
    });

    const res = await longRequestFetch(`${LEGACY}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reporter: 'json' }),
    });

    expect(await res.json()).toEqual({ method: 'POST', contentType: 'application/json', body: '{"reporter":"json"}' });
  });

  it('sends an https: URL through node:https', async () => {
    serve((_exchange, respond) => {
      const res = new FakeResponse(200, 'OK', ['content-type', 'text/plain']);
      respond(res);
      res.finish('tls ok');
    });

    const res = await longRequestFetch('https://legacy.test/secure');

    expect(await res.text()).toBe('tls ok');
    expect(exchanges).toMatchObject([{ transport: 'https', method: 'GET', url: 'https://legacy.test/secure' }]);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('returns a null body for a 204', async () => {
    serve((_exchange, respond) => {
      const res = new FakeResponse(204, 'No Content', []);
      respond(res);
      res.finish();
    });

    const res = await longRequestFetch(`${LEGACY}/empty`);

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('rejects with the RangeError a Response raises for a status outside 200-599', async () => {
    serve((_exchange, respond) => {
      const res = new FakeResponse(600, '', []);
      respond(res);
      res.finish('odd');
    });

    await expect(longRequestFetch(`${LEGACY}/odd`)).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects when the connection is refused', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED', syscall: 'connect' });
    serve((_exchange, _respond, req) => req.emit('error', refused));

    await expect(longRequestFetch(`${LEGACY}/`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it("rejects with the caller's abort reason", async () => {
    serve(() => undefined);
    const controller = new AbortController();
    const reason = new Error('caller gave up');
    setTimeout(() => controller.abort(reason), 20);

    await expect(longRequestFetch(`${LEGACY}/never`, { signal: controller.signal })).rejects.toBe(reason);
    expect(exchanges).toHaveLength(1);
  });

  it('rejects when the response closes before it completes', async () => {
    serve((_exchange, respond) => {
      const res = new FakeResponse(200, 'OK', ['content-length', '100']);
      respond(res);
      res.write('partial', () => res.destroy());
    });

    await expect(longRequestFetch(`${LEGACY}/truncated`)).rejects.toThrow(
      `response from ${LEGACY} closed before it completed`,
    );
  });
});

describe('main', () => {
  interface CliRun {
    code: number;
    exits: number[];
    line: Record<string, unknown>;
  }

  /** Runs `main` through runCli with captured stdout and exit; asserts exactly one summary line. */
  async function cli(argv: string[], deps: RunDeps): Promise<CliRun> {
    const chunks: string[] = [];
    const exits: number[] = [];
    const code = await runCli((args) => main(args, deps), {
      argv,
      command: COMMAND,
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: (status) => exits.push(status),
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endsWith('\n')).toBe(true);
    return { code, exits, line: JSON.parse(chunks[0] ?? '') as Record<string, unknown> };
  }

  it('runs the official then the diagnostic runner and prints one summary line', async () => {
    const { fetch, sent } = routedFetch();

    const run = await cli([], { env, fetch, now: tickingClock('2026-06-30T00:00:00.000Z', 412) });

    expect(run.code).toBe(0);
    expect(run.exits).toEqual([0]);
    expect(run.line).toEqual({
      command: COMMAND,
      ok: true,
      code: 0,
      official: { httpStatus: 500, specs: 0 },
      diagnostic: { httpStatus: 200, specs: 683, durationMs: 412 },
      savedTo: path.join(tmp, 'baseline'),
    });
    expect(sent.map((request) => [request.url, request.key])).toEqual([
      [`${LEGACY}${OFFICIAL_RUNNER_PATH}`, undefined],
      [`${LEGACY}${DIAGNOSTIC_RUNNER_PATH}`, KEY],
    ]);
    expect(await exists(path.join(tmp, 'baseline', 'official.json'))).toBe(true);
    expect(await exists(path.join(tmp, 'baseline', 'diagnostic.json'))).toBe(true);
  });

  it.each([[['--verbose']], [['extra']]])('exits 2 with the usage text for argv %j and sends nothing', async (argv) => {
    const { fetch } = routedFetch();

    const run = await cli(argv, { env, fetch });

    expect(run.code).toBe(2);
    expect(run.exits).toEqual([2]);
    expect(run.line).toMatchObject({ command: COMMAND, ok: false, code: 2, error: { type: 'UsageError' }, usage: USAGE });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prints the help text naming LEGACY_ORIGIN, PORT, OPT2_STATE_DIR and OPT2_HARNESS_KEY for --help, exits 0 and sends nothing', async () => {
    const { fetch } = routedFetch();
    const chunks: string[] = [];
    const exits: number[] = [];

    const code = await runCli((args) => main(args, { env, fetch }), {
      argv: ['--help'],
      command: COMMAND,
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: (status) => exits.push(status),
    });

    const text = chunks.join('');
    expect(code).toBe(0);
    expect(exits).toEqual([0]);
    expect(text.startsWith(`${USAGE}\n`)).toBe(true);
    for (const name of ['LEGACY_ORIGIN', 'PORT', 'OPT2_STATE_DIR', 'OPT2_HARNESS_KEY', '--help']) expect(text).toContain(name);
    expect(text).not.toMatch(/^\{/m);
    expect(fetch).not.toHaveBeenCalled();
    expect(await exists(path.join(tmp, 'baseline'))).toBe(false);
  });

  it('exits 1 when a runner request fails', async () => {
    const { fetch } = recordingFetch(() => Promise.reject(new Error('socket hang up')));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const run = await cli([], { env, fetch });

      expect(run.code).toBe(1);
      expect(run.line).toMatchObject({ ok: false, code: 1, error: { type: 'HttpRequestError' } });
    } finally {
      stderr.mockRestore();
    }
  });

  it('uses longRequestFetch by default against the legacy origin', async () => {
    serve((exchange, respond) => {
      const official = exchange.url.endsWith(OFFICIAL_RUNNER_PATH);
      const res = official
        ? new FakeResponse(500, 'Internal Server Error', ['content-type', 'text/html;charset=UTF-8'])
        : new FakeResponse(200, 'OK', ['content-type', 'application/json']);
      respond(res);
      res.finish(official ? (OFFICIAL_FIXTURE.body as string) : DIAGNOSTIC_TEXT);
    });

    const outcome = await main([], { env });

    expect(exchanges.map(({ transport, method, url }) => ({ transport, method, url }))).toEqual([
      { transport: 'http', method: 'GET', url: `${LEGACY}${OFFICIAL_RUNNER_PATH}` },
      { transport: 'http', method: 'GET', url: `${LEGACY}${DIAGNOSTIC_RUNNER_PATH}` },
    ]);
    expect(exchanges.map(({ headers }) => headers['x-opt2-harness-key'])).toEqual([undefined, KEY]);
    expect(outcome.code).toBe(0);
    expect(outcome.summary).toMatchObject({
      official: { httpStatus: 500, specs: 0 },
      diagnostic: { httpStatus: 200, specs: 683 },
      savedTo: path.join(tmp, 'baseline'),
    });
    expect((await readSaved('diagnostic.json')).saved.body).toEqual(DIAGNOSTIC_BODY);
  });
});
