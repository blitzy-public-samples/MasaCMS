import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '../../src/auth/index.js';
import { REDACTED, validateLogRecord } from '../../src/logging/index.js';
import { main } from '../../src/tasks/cli.js';
import { recurringQueues } from '../../src/tasks/queues.js';
import { writeTestSecrets } from '../../src/testing/tokens.js';

type WriteCallback = (err?: Error | null) => void;

interface Received {
  method?: string;
  url?: string;
  invocation?: string | string[];
}

const URLS_ISSUE = 'OPT2_SERVICE_URLS: must name at least one service';
const CLOUD_ISSUE = 'GOOGLE_CLOUD_PROJECT: is required when OPT2_ENV=cloud';
const NO_CREATOR = 'opt2-tasks: OPT2_SERVICE_URLS names no creator of the selected queues\n';
const CREATOR = 'communications';
const QUEUE = 'communications-outbox-sweep';

let server: Server;
let serverUrl: string;
let stateDir: string;
let received: Received[];
let answer: { status: number; body: unknown };
let stdout: string;
let stderr: string;

/** A `write` stand-in that appends each chunk to `sink` and calls back with `error`. */
function capture(sink: (chunk: string) => void, error: Error | null = null) {
  return (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(error);
    return error === null;
  };
}

/** Sets the variables the CLI reads; an undefined `urls` leaves OPT2_SERVICE_URLS unset. */
function stubCliEnv(urls: string | undefined, mode = 'local'): void {
  vi.stubEnv('OPT2_ENV', mode);
  vi.stubEnv('OPT2_STATE_DIR', stateDir);
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
  vi.stubEnv('OPT2_SERVICE_URLS', urls);
}

/** The stdout result line of every default-selected creator, with `own` replacing the deployed creator's line. */
function expectedLines(own?: Record<string, unknown>): Array<Record<string, unknown>> {
  return recurringQueues({ includeLocalOnly: true }).flatMap((def) =>
    def.creators.map((service) =>
      own !== undefined && service === CREATOR && def.name === QUEUE
        ? own
        : { queue: def.name, service, ok: true, skipped: 'not deployed' },
    ),
  );
}

/** Loads cli.ts as the process entry module, as the opt2-tasks bin does; resolves with the code it exits with. */
async function runAsBin(): Promise<number> {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const argv = process.argv;
  process.argv = [argv[0] as string, fileURLToPath(new URL('../../src/tasks/cli.ts', import.meta.url)), 'reconcile'];
  try {
    vi.resetModules();
    await import('../../src/tasks/cli.js');
  } finally {
    process.argv = argv;
  }
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  expect(exit).toHaveBeenCalledTimes(1);
  return exit.mock.calls[0]?.[0] as number;
}

function stdoutLines(): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'opt2-tasks-cli-'));
  await writeTestSecrets(stateDir);
  server = createServer((req, res) => {
    received.push({ method: req.method, url: req.url, invocation: req.headers[INVOCATION_HEADER] });
    req.resume();
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  answer = { status: 404, body: {} };
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(capture((chunk) => (stdout += chunk)));
  vi.spyOn(process.stderr, 'write').mockImplementation(capture((chunk) => (stderr += chunk)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('opt2-tasks reconcile', () => {
  it.each([
    { label: 'OPT2_SERVICE_URLS is unset', mode: 'local', urls: () => undefined, issue: URLS_ISSUE },
    { label: 'OPT2_SERVICE_URLS is blank', mode: 'local', urls: () => '  ', issue: URLS_ISSUE },
    { label: 'OPT2_SERVICE_URLS is an empty map', mode: 'local', urls: () => '{}', issue: URLS_ISSUE },
    { label: 'OPT2_ENV=cloud lacks GOOGLE_CLOUD_PROJECT', mode: 'cloud', urls: () => JSON.stringify({ [CREATOR]: serverUrl }), issue: CLOUD_ISSUE },
  ])('exits 2 naming the variable, before any call, when $label', async ({ mode, urls, issue }) => {
    stubCliEnv(urls(), mode);

    expect(await main(['reconcile'])).toBe(2);

    expect(stderr).toBe(`opt2-tasks: invalid environment\n  ${issue}\n`);
    expect(stdout).toBe('');
    expect(received).toEqual([]);
  });

  it('exits 2 naming OPT2_SERVICE_URLS when the map names no creator of the selected queues', async () => {
    stubCliEnv(JSON.stringify({ gateway: serverUrl }));

    expect(await main(['reconcile'])).toBe(2);

    expect(stdoutLines()).toEqual(expectedLines());
    expect(stderr).toBe(NO_CREATOR);
    expect(received).toEqual([]);
  });

  it.each([
    {
      status: 200,
      code: 0,
      line: { queue: QUEUE, service: CREATOR, ok: true, created: true, name: `${QUEUE}-1782820800`, reason: 'created-current' },
    },
    {
      status: 503,
      code: 1,
      line: { queue: QUEUE, service: CREATOR, ok: false, error: `Queue control ensure of ${QUEUE} on ${CREATOR} answered HTTP 503` },
    },
  ])('exits $code when the one deployed creator answers HTTP $status, keeping the other creators skipped', async ({ status, code, line }) => {
    stubCliEnv(JSON.stringify({ [CREATOR]: serverUrl }));
    answer = {
      status,
      body: { queue: QUEUE, service: CREATOR, ensured: { queue: QUEUE, name: `${QUEUE}-1782820800`, created: true, reason: 'created-current' } },
    };

    expect(await main(['reconcile'])).toBe(code);

    expect(stdoutLines()).toEqual(expectedLines(line));
    expect(stderr).toBe('');
    expect(received).toEqual([
      { method: 'POST', url: `/internal/v1/task-queues/${QUEUE}/ensure`, invocation: expect.stringMatching(/^Bearer \S+$/) },
    ]);
  });

  it.each([
    { label: 'main', run: () => main(['reconcile']) },
    { label: 'the opt2-tasks bin', run: runAsBin },
  ])('logs a fatal error as one safe log-record.v1 line on stderr and exits 1, run as $label', async ({ run }) => {
    stubCliEnv(JSON.stringify({ gateway: serverUrl }));
    const failure = new Error('write failed for https://user:pw@h/?X-Goog-Signature=abc');
    const write = capture((chunk) => (stdout += chunk), failure);
    // As a real stream does, the failed write's error event follows its callback.
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback?, callback?) => {
      process.nextTick(() => process.stdout.emit('error', failure));
      return write(chunk, encodingOrCallback, callback);
    });
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    expect(await run()).toBe(1);

    const [line, ...rest] = stderr.split('\n');
    expect(rest).toEqual(['']);
    const record = JSON.parse(line as string) as unknown;
    expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
    expect(record).toMatchObject({
      severity: 'CRITICAL',
      service: 'opt2-tasks',
      env: 'local',
      message: 'opt2-tasks failed',
      error: { type: 'Error', message: REDACTED },
    });
    expect(stderr).not.toMatch(/write failed|user:pw|X-Goog-Signature/);
    expect(warning).not.toHaveBeenCalled();
  });
});
