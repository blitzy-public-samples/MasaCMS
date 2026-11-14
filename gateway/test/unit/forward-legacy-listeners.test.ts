// Tests the client response's listener load and the early-end handling of a streamed legacy forward, over an in-process legacy.
import { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import replyFrom, { type FastifyReplyFromOptions } from '@fastify/reply-from';
import { createLogger, serializeError } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardToLegacy, type LegacySettlement } from '../../src/dispatcher/forward-legacy.js';

const CHUNK = Buffer.alloc(16 * 1024, 0x61);
const CHUNK_COUNT = 3;
const ENDED_EARLY = 'legacy response stream ended early';
const UNCERTAIN = 'legacy exchange ended uncertainly; in-flight registration kept';
const PREMATURE_CLOSE = { type: 'Error', message: 'ERR_STREAM_PREMATURE_CLOSE' };

type OnSettled = (outcome: LegacySettlement) => Promise<void>;

interface LogLine {
  message?: string;
  error?: unknown;
}

interface Harness {
  app: FastifyInstance;
  /** Legacy's response body of each forwarded request, written and ended by the test. */
  origins: PassThrough[];
  /** The client response of each request. */
  responses: ServerResponse[];
  /** Ends the first request as a client going away does: its socket destroyed, its response closed. */
  disconnect(): void;
  /** Most `close` listeners a client response held at once. */
  peakCloseListeners(): number;
  logs(): LogLine[];
}

interface UpstreamAnswer {
  statusCode: number;
  headers: Record<string, string>;
  body: PassThrough;
}

const closers: Array<() => Promise<void>> = [];
const warnings: Error[] = [];
const onWarning = (warning: Error): void => {
  warnings.push(warning);
};

beforeEach(() => {
  warnings.length = 0;
  process.on('warning', onWarning);
});

afterEach(async () => {
  process.off('warning', onWarning);
  for (const close of closers.splice(0)) await close();
});

/** reply-from transport answering each request in-process with a 200 whose body the test writes, so no socket opens. */
function inProcessLegacy(origins: PassThrough[]): NonNullable<FastifyReplyFromOptions['undici']> {
  const request = (_options: unknown, callback: (error: null, answer: UpstreamAnswer) => void): void => {
    const body = new PassThrough();
    origins.push(body);
    setImmediate(() => callback(null, { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body }));
  };
  return { request } as unknown as NonNullable<FastifyReplyFromOptions['undici']>;
}

interface HarnessOptions {
  onSettled?: OnSettled;
  /** Runs as the forward's beforeSend, once legacy's headers arrived. */
  beforeSend?: (h: Harness) => Promise<void>;
}

/** The service-kit app the gateway runs on, whose every GET streams legacy's answer as dispatch does. */
async function harness({ onSettled, beforeSend }: HarnessOptions = {}): Promise<Harness> {
  const lines: string[] = [];
  const origins: PassThrough[] = [];
  const responses: ServerResponse[] = [];
  const sockets: Socket[] = [];
  let peak = 0;
  const app = await createService({
    name: 'gateway',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8100',
      OPT2_SERVICE_NAME: 'gateway',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('gateway'),
    logger: createLogger({
      service: 'gateway',
      version: '1.0.0',
      env: 'local',
      destination: {
        write(line: string) {
          lines.push(line);
        },
      },
    }),
  });
  closers.push(() => app.opt2.shutdown());
  const h: Harness = {
    app,
    origins,
    responses,
    disconnect() {
      // light-my-request's socket is a plain emitter; a real disconnect leaves the socket destroyed.
      Object.assign(sockets[0] ?? {}, { destroyed: true });
      responses[0]?.destroy();
    },
    peakCloseListeners: () => peak,
    logs: () => lines.map((line) => JSON.parse(line) as LogLine),
  };
  await app.register(replyFrom, { undici: inProcessLegacy(origins) });
  app.addHook('onRequest', (request, reply, done) => {
    const raw = reply.raw;
    sockets.push(request.raw.socket);
    responses.push(raw);
    // Emitted before the listener is added.
    raw.on('newListener', (event) => {
      if (event === 'close') peak = Math.max(peak, raw.listenerCount('close') + 1);
    });
    done();
  });
  app.get('/*', { config: { opt2: { public: true } } }, (request, reply) =>
    forwardToLegacy(request, reply, {
      legacyOrigin: 'http://legacy.invalid',
      headers: request.headers,
      sessionMode: 'legacy-primary',
      mode: 'stream',
      onSettled,
      beforeSend: beforeSend === undefined ? undefined : () => beforeSend(h),
      failContext: { surface: 'admin' },
    }),
  );
  await app.ready();
  return h;
}

/** The first request's legacy body, once reply-from asked for it. */
async function firstOrigin(h: Harness): Promise<PassThrough> {
  await vi.waitFor(() => expect(h.origins).toHaveLength(1));
  return h.origins[0] as PassThrough;
}

/** Resolves after pending stream callbacks and the warnings they emitted have run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const listenerWarnings = (): Error[] => warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning');

const messages = (h: Harness, message: string): LogLine[] => h.logs().filter((line) => line.message === message);

/** `type` and `message` of a logged error record, without the stack frames that produced it. */
function typeAndMessage(error: unknown): { type: unknown; message: unknown } {
  const { type, message } = error as { type?: unknown; message?: unknown };
  return { type, message };
}

describe('forwardToLegacy streaming a whole legacy response', () => {
  it.each([{ settles: true }, { settles: false }])(
    'keeps the client response within its listener limit (onSettled given: $settles)',
    async ({ settles }) => {
      const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
      const h = await harness({ onSettled: settles ? onSettled : undefined });

      const pending = h.app.inject({ method: 'GET', url: '/_api/json/v1/default/site/default' });
      const origin = await firstOrigin(h);
      for (let sent = 0; sent < CHUNK_COUNT; sent += 1) origin.write(CHUNK);
      origin.end();
      const res = await pending;
      await tick();

      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(Buffer.concat(Array.from({ length: CHUNK_COUNT }, () => CHUNK)))).toBe(true);
      expect(h.peakCloseListeners()).toBeLessThanOrEqual(h.responses[0]?.getMaxListeners() ?? 0);
      expect(listenerWarnings()).toEqual([]);
      expect(messages(h, ENDED_EARLY)).toEqual([]);
      expect(onSettled.mock.calls).toEqual(settles ? [['completed']] : []);
    },
  );
});

describe('forwardToLegacy when a streamed legacy response ends early', () => {
  const legacyFailure = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const legacyFailureRecord = typeAndMessage(serializeError(legacyFailure));

  it.each([
    { at: 'mid-body', cut: 'client', settles: true, logged: PREMATURE_CLOSE, uncertain: 0, settled: [['completed']], originEnded: true },
    { at: 'mid-body', cut: 'client', settles: false, logged: PREMATURE_CLOSE, uncertain: 0, settled: [], originEnded: false },
    { at: 'mid-body', cut: 'legacy', settles: true, logged: PREMATURE_CLOSE, uncertain: 1, settled: [], originEnded: false },
    { at: 'mid-body', cut: 'legacy', settles: false, logged: legacyFailureRecord, uncertain: 0, settled: [], originEnded: false },
    { at: 'beforeSend', cut: 'client', settles: true, logged: PREMATURE_CLOSE, uncertain: 0, settled: [['completed']], originEnded: true },
    { at: 'beforeSend', cut: 'client', settles: false, logged: PREMATURE_CLOSE, uncertain: 0, settled: [], originEnded: false },
    { at: 'beforeSend', cut: 'legacy', settles: true, logged: PREMATURE_CLOSE, uncertain: 1, settled: [], originEnded: false },
  ] as const)(
    '$cut cuts it at $at (onSettled given: $settles): logged once, the other side cut',
    async ({ at, cut, settles, logged, uncertain, settled, originEnded }) => {
      const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
      const cutNow = (h: Harness): void => {
        if (cut === 'client') h.disconnect();
        else h.origins[0]?.destroy(legacyFailure);
      };
      const h = await harness({
        onSettled: settles ? onSettled : undefined,
        beforeSend:
          at === 'beforeSend'
            ? async (self) => {
                cutNow(self);
                await tick();
              }
            : undefined,
      });

      const outcome = h.app.inject({ method: 'GET', url: '/' }).then(
        () => 'complete',
        () => 'cut',
      );
      const origin = await firstOrigin(h);
      if (at === 'mid-body') {
        await vi.waitFor(() => expect(h.responses[0]?.headersSent).toBe(true));
        origin.write(CHUNK);
        await tick();
        cutNow(h);
      }
      await vi.waitFor(() => expect(messages(h, ENDED_EARLY)).toHaveLength(1));
      // A drained origin still reaches its end, which is what settles the exchange.
      if (!origin.destroyed) origin.end(CHUNK);
      if (settled.length > 0) await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
      await tick();

      expect(await outcome).toBe('cut');
      expect(messages(h, ENDED_EARLY).map((line) => typeAndMessage(line.error))).toEqual([logged]);
      expect(messages(h, UNCERTAIN)).toHaveLength(uncertain);
      expect(onSettled.mock.calls).toEqual(settled);
      expect(origin.readableEnded).toBe(originEnded);
      expect(h.responses[0]?.destroyed).toBe(true);
      expect(listenerWarnings()).toEqual([]);
    },
  );
});
