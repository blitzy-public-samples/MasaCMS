// Tests over raw sockets that a legacy forward answers in legacy's own status line and header bytes, request and response heads past 16 KB included,
// with `Connection` and framing for the client connection.
import { Buffer } from 'node:buffer';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import replyFrom from '@fastify/reply-from';
import { LEGACY_ERROR_STATUS_TEXT, LEGACY_REQUEST_HEAD_LIMIT_BYTES } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardToLegacy, type LegacyBeforeSend, type LegacyForwardContext } from '../../src/dispatcher/forward-legacy.js';
import { replyFromOptions } from '../../src/dispatcher/response-head.js';

const HOST = 'localhost:20080';
const DATE = 'Date: Sat, 14 Nov 2026 22:00:00 GMT';
/** How long the client waits for a byte more than it expects before it hangs up. */
const IDLE_MS = 300;
const SILENT = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const MAPPED_SET_COOKIES = ['CFID=t-1;path=/;HttpOnly;', 'CFTOKEN=t-2;path=/;HttpOnly;'];

const mapsCookies: LegacyBeforeSend = () => Promise.resolve({ setCookies: [...MAPPED_SET_COOKIES] });
const keepsCookies: LegacyBeforeSend = () => Promise.resolve();

/** A response head of `lines`, as CRLF-terminated bytes. */
function head(...lines: string[]): string {
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** `answer` with an HTTP/1.0 status line, as legacy answers an HTTP/1.0 request. */
function http10(answer: string): string {
  return answer.replace(/^HTTP\/1\.1 /, 'HTTP/1.0 ');
}

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/**
 * A raw TCP stand-in for legacy that answers each bodiless request head with `answer(head)` and closes, or with
 * `keepOpen` answers every head on the connection; records every head and counts connections.
 */
async function startRawLegacy(
  answer: (requestHead: string) => Buffer | Promise<Buffer>,
  keepOpen = false,
): Promise<{ url: string; heads: string[]; connections: () => number }> {
  const heads: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let answered = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let end = pending.indexOf('\r\n\r\n'); end !== -1; end = pending.indexOf('\r\n\r\n')) {
        const requestHead = pending.subarray(0, end).toString('latin1');
        pending = pending.subarray(end + 4);
        heads.push(requestHead);
        const reply = answer(requestHead);
        // In request order, as one connection answers.
        answered = answered.then(async () => {
          const bytes = await reply;
          if (keepOpen) socket.write(bytes);
          else socket.end(bytes);
        });
        if (!keepOpen) return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, heads, connections: () => connections };
}

/** The gateway's service kit at legacy's head limit, forwarding every GET and HEAD to `legacyOrigin`, by default through the gateway's dispatcher. */
async function startGateway(
  legacyOrigin: string,
  ctx: Pick<LegacyForwardContext, 'mode' | 'sessionMode' | 'beforeSend'>,
  viaGatewayDispatcher = true,
): Promise<{ port: number; app: FastifyInstance }> {
  const app: FastifyInstance = await createService({
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
    logger: SILENT,
    legacyStartupScan: false,
    maxHeaderSize: LEGACY_REQUEST_HEAD_LIMIT_BYTES,
  });
  closers.push(() => app.close());
  await app.register(replyFrom, viaGatewayDispatcher ? replyFromOptions() : {});
  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    config: { opt2: { public: true } },
    handler: (request, reply) => {
      void forwardToLegacy(request, reply, {
        legacyOrigin,
        headers: request.headers,
        failContext: { surface: 'admin' },
        onSettled: () => Promise.resolve(),
        ...ctx,
      });
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { port: (app.server.address() as AddressInfo).port, app };
}

/** Writes `request` to `port` and resolves to the bytes answered, once `expected` bytes arrived or the line went quiet. */
function exchange(port: number, request: string, expected: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const socket = connect(port, '127.0.0.1', () => socket.write(request, 'latin1'));
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= expected) socket.destroy();
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Writes `requests` in turn over one connection to `port`, each once `lengths` bytes answered those before it; resolves to
 * everything answered, and whether the gateway ended the connection before the line went quiet.
 */
function converse(port: number, requests: readonly string[], lengths: readonly number[]): Promise<{ bytes: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let sent = 1;
    let closed = false;
    const socket = connect(port, '127.0.0.1', () => socket.write(requests[0] ?? '', 'latin1'));
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      const due = lengths.slice(0, sent).reduce((sum, length) => sum + length, 0);
      if (sent < requests.length && received >= due) socket.write(requests[sent++] ?? '', 'latin1');
    });
    socket.once('end', () => {
      closed = true;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve({ bytes: Buffer.concat(chunks).toString('latin1'), closed }));
  });
}

/** `bytes` split at the end of its head. */
function splitHead(bytes: string): [string, string] {
  const end = bytes.indexOf('\r\n\r\n') + 4;
  return [bytes.slice(0, end), bytes.slice(end)];
}

/** The payload of a complete chunked body; throws unless it is well framed and ends with the last chunk. */
function dechunk(body: string): string {
  let rest = body;
  let payload = '';
  for (;;) {
    const line = rest.indexOf('\r\n');
    const size = Number.parseInt(rest.slice(0, line), 16);
    if (line === -1 || Number.isNaN(size)) throw new Error(`invalid chunked body ${JSON.stringify(body)}`);
    if (size === 0) {
      if (rest.slice(line) !== '\r\n\r\n') throw new Error(`invalid last chunk in ${JSON.stringify(body)}`);
      return payload;
    }
    payload += rest.slice(line + 2, line + 2 + size);
    rest = rest.slice(line + 2 + size + 2);
  }
}

/** Legacy's answer with a reason phrase of its own, mixed-case and interleaved repeated names, UTF-8 and latin1 value bytes. */
const LEGACY_404 = Buffer.concat([
  Buffer.from(
    head(
      'HTTP/1.1 404 Content Not Found',
      DATE,
      'X-Multi: one',
      'content-type: text/html;charset=UTF-8',
      'X-Multi: two',
      'Content-Disposition: attachment; filename="caf\u00c3\u00a9.txt"',
      'X-Latin1: caf\u00e9',
      'WWW-Authenticate: Basic',
      'Content-Length: 5',
      'Connection: keep-alive',
    ),
    'latin1',
  ),
  Buffer.from('hello'),
]);

/** Legacy setting a session cookie and another cookie around another header, as ACF spells them. */
const LEGACY_COOKIES = head(
  'HTTP/1.1 200 OK',
  DATE,
  'SET-COOKIE: CFID=1001;Path=/;HttpOnly',
  'Content-Type: text/html;charset=UTF-8',
  'SET-COOKIE: A=1;Path=/',
  'Content-Length: 2',
  'Connection: keep-alive',
);

const LEGACY_PLAIN = head('HTTP/1.1 200 OK', DATE, 'Content-Type: text/html;charset=UTF-8', 'Content-Length: 2', 'Connection: keep-alive');

const LEGACY_CHUNKED_HEAD = head(
  'HTTP/1.1 200 OK',
  DATE,
  'Content-Type: text/plain',
  'Transfer-Encoding: chunked',
  'Connection: keep-alive',
  'X-After: 1',
);

const GET = head('GET /admin/ HTTP/1.1', `Host: ${HOST}`);
const HEAD_REQUEST = head('HEAD /admin/ HTTP/1.1', `Host: ${HOST}`);
const GET_HTTP_1_0 = head('GET /admin/ HTTP/1.0', `Host: ${HOST}`);

interface HeadCase {
  label: string;
  legacy: Buffer | string;
  request: string;
  expected: Buffer | string;
  sessionMode?: LegacyForwardContext['sessionMode'];
  beforeSend?: LegacyBeforeSend;
}

const CASES: HeadCase[] = [
  { label: 'a custom reason phrase, mixed-case and interleaved names, UTF-8 and latin1 bytes', legacy: LEGACY_404, request: GET, expected: LEGACY_404 },
  {
    label: "target-primary's mapped cookies at legacy's first Set-Cookie line",
    legacy: `${LEGACY_COOKIES}ok`,
    request: GET,
    sessionMode: 'target-primary',
    beforeSend: mapsCookies,
    expected: `${head(
      'HTTP/1.1 200 OK',
      DATE,
      'SET-COOKIE: CFID=t-1;path=/;HttpOnly;',
      'SET-COOKIE: CFTOKEN=t-2;path=/;HttpOnly;',
      'Content-Type: text/html;charset=UTF-8',
      'Content-Length: 2',
      'Connection: keep-alive',
    )}ok`,
  },
  {
    label: "target-primary withholding legacy's session cookie, the other kept at its first line",
    legacy: `${LEGACY_COOKIES}ok`,
    request: GET,
    sessionMode: 'target-primary',
    beforeSend: keepsCookies,
    expected: `${head(
      'HTTP/1.1 200 OK',
      DATE,
      'SET-COOKIE: A=1;Path=/',
      'Content-Type: text/html;charset=UTF-8',
      'Content-Length: 2',
      'Connection: keep-alive',
    )}ok`,
  },
  {
    label: "target-primary withholding legacy's only cookie, its line dropped",
    legacy: `${head('HTTP/1.1 200 OK', DATE, 'SET-COOKIE: CFID=1001;Path=/;HttpOnly', 'Content-Length: 2', 'Connection: keep-alive')}ok`,
    request: GET,
    sessionMode: 'target-primary',
    beforeSend: keepsCookies,
    expected: `${head('HTTP/1.1 200 OK', DATE, 'Content-Length: 2', 'Connection: keep-alive')}ok`,
  },
  { label: "legacy-primary's cookies as legacy sent them", legacy: `${LEGACY_COOKIES}ok`, request: GET, beforeSend: keepsCookies, expected: `${LEGACY_COOKIES}ok` },
  {
    label: 'cookies the gateway adds, appended',
    legacy: `${LEGACY_PLAIN}ok`,
    request: GET,
    sessionMode: 'target-primary',
    beforeSend: mapsCookies,
    expected: `${head(
      'HTTP/1.1 200 OK',
      DATE,
      'Content-Type: text/html;charset=UTF-8',
      'Content-Length: 2',
      'Connection: keep-alive',
      ...MAPPED_SET_COOKIES.map((cookie) => `set-cookie: ${cookie}`),
    )}ok`,
  },
  {
    label: 'a chunked body, re-chunked under legacy’s Transfer-Encoding line',
    legacy: `${LEGACY_CHUNKED_HEAD}5\r\nhello\r\n0\r\n\r\n`,
    request: GET,
    expected: `${LEGACY_CHUNKED_HEAD}5\r\nhello\r\n0\r\n\r\n`,
  },
  ...[
    ['204', 'No Content'],
    ['304', 'Not Modified'],
  ].map(([status, reason]) => {
    const bodiless = head(`HTTP/1.1 ${String(status)} ${String(reason)}`, DATE, 'ETag: "A1B2"', 'Connection: keep-alive', 'Cache-Control: no-cache');
    return { label: `a ${String(status)} without a body`, legacy: bodiless, request: GET, expected: bodiless };
  }),
];

const CHUNKED_HELLO = `${LEGACY_CHUNKED_HEAD}5\r\nhello\r\n0\r\n\r\n`;
/** {@link LEGACY_CHUNKED_HEAD} to a client connection that closes: `Connection: close` at its line, no `Transfer-Encoding`. */
const CLOSING_CHUNKED_HEAD = head('HTTP/1.1 200 OK', DATE, 'Content-Type: text/plain', 'Connection: close', 'X-After: 1');
const CLOSING_PLAIN = head('HTTP/1.1 200 OK', DATE, 'Content-Type: text/html;charset=UTF-8', 'Content-Length: 2', 'Connection: close');
/** Legacy's 304, which carries no `Connection` line. */
const LEGACY_304 = head('HTTP/1.1 304 Not Modified', DATE);
/** Legacy's 304 to a HEAD, framed as if a body followed. */
const LEGACY_HEAD_304 = head('HTTP/1.1 304 Not Modified', 'Connection: keep-alive', 'Transfer-Encoding: chunked', DATE);
const GET_CLOSE = head('GET /admin/ HTTP/1.1', `Host: ${HOST}`, 'Connection: close');
const GET_HTTP_1_0_KEEP_ALIVE = head('GET /admin/ HTTP/1.0', `Host: ${HOST}`, 'Connection: keep-alive');
const NEXT = head('GET /next HTTP/1.1', `Host: ${HOST}`);
const NEXT_ANSWER = `${LEGACY_PLAIN}ok`;

interface ConnectionCase {
  label: string;
  request: string;
  legacy: string;
  expected: string;
  /** Sent next on the connection, which the gateway must keep open; without it, the gateway must close the connection. */
  next?: string;
  /** The answer to `next`; defaults to {@link NEXT_ANSWER}. */
  nextExpected?: string;
}

const CONNECTION_CASES: ConnectionCase[] = [
  { label: 'a client asking to close, a body without a length close-delimited', request: GET_CLOSE, legacy: CHUNKED_HELLO, expected: `${CLOSING_CHUNKED_HEAD}hello` },
  { label: 'a client asking to close, a body with a length', request: GET_CLOSE, legacy: `${LEGACY_PLAIN}ok`, expected: `${CLOSING_PLAIN}ok` },
  {
    label: 'a HEAD from a client asking to close',
    request: head('HEAD /admin/ HTTP/1.1', `Host: ${HOST}`, 'Connection: close'),
    legacy: LEGACY_CHUNKED_HEAD,
    expected: CLOSING_CHUNKED_HEAD,
  },
  { label: 'an HTTP/1.0 client', request: GET_HTTP_1_0, legacy: CHUNKED_HELLO, expected: http10(`${CLOSING_CHUNKED_HEAD}hello`) },
  {
    label: 'an HTTP/1.0 keep-alive client, a body without a length',
    request: GET_HTTP_1_0_KEEP_ALIVE,
    legacy: CHUNKED_HELLO,
    expected: http10(`${CLOSING_CHUNKED_HEAD}hello`),
  },
  {
    label: 'an HTTP/1.0 keep-alive client, a body with a length',
    request: GET_HTTP_1_0_KEEP_ALIVE,
    legacy: `${LEGACY_PLAIN}ok`,
    expected: http10(`${LEGACY_PLAIN}ok`),
    next: head('GET /next HTTP/1.0', `Host: ${HOST}`, 'Connection: keep-alive'),
    nextExpected: http10(NEXT_ANSWER),
  },
  { label: 'an HTTP/1.0 HEAD', request: head('HEAD /admin/ HTTP/1.0', `Host: ${HOST}`), legacy: LEGACY_CHUNKED_HEAD, expected: http10(CLOSING_CHUNKED_HEAD) },
  {
    label: "a request body unread when legacy answered, closed as reply-from asks",
    request: `${head('GET /admin/ HTTP/1.1', `Host: ${HOST}`, 'Content-Length: 10')}hello`,
    legacy: `${LEGACY_PLAIN}ok`,
    expected: `${CLOSING_PLAIN}ok`,
  },
  { label: "a HEAD, legacy's chunked head without a body", request: HEAD_REQUEST, legacy: LEGACY_CHUNKED_HEAD, expected: LEGACY_CHUNKED_HEAD, next: NEXT },
  { label: "legacy's 304 without a Connection line, none added", request: GET, legacy: LEGACY_304, expected: LEGACY_304, next: NEXT },
  { label: "legacy's 304 without a Connection line, to a client asking to close", request: GET_CLOSE, legacy: LEGACY_304, expected: LEGACY_304 },
  { label: "legacy's chunked 304 to a HEAD", request: HEAD_REQUEST, legacy: LEGACY_HEAD_304, expected: LEGACY_HEAD_304, next: NEXT },
  {
    label: "legacy's chunked 304 to an HTTP/1.0 keep-alive HEAD, closed as legacy closes it",
    request: head('HEAD /admin/ HTTP/1.0', `Host: ${HOST}`, 'Connection: keep-alive'),
    legacy: LEGACY_HEAD_304,
    expected: head('HTTP/1.0 304 Not Modified', 'Connection: close', DATE),
  },
  {
    label: "legacy closing its own connection, a keep-alive client's closed too, without a Date legacy did not send",
    request: GET,
    legacy: head('HTTP/1.1 400 Bad Request', 'Content-Length: 0', 'Connection: close'),
    expected: head('HTTP/1.1 400 Bad Request', 'Content-Length: 0', 'Connection: close'),
  },
];

describe('legacy forward response head', () => {
  it.each((['stream', 'buffer'] as const).flatMap((mode) => CASES.map((row) => ({ mode, ...row }))))(
    '$mode mode: $label',
    async ({ mode, legacy, request, expected, sessionMode = 'legacy-primary', beforeSend }) => {
      const origin = await startRawLegacy(() => Buffer.from(legacy as string, 'latin1'));
      const { port } = await startGateway(origin.url, { mode, sessionMode, ...(beforeSend === undefined ? {} : { beforeSend }) });
      const [wantHead, wantBody] = splitHead(Buffer.isBuffer(expected) ? expected.toString('latin1') : expected);
      // Node chunks a streamed body as it arrives, so a chunked body is compared by its payload and framing.
      const chunked = wantBody !== '' && /\r\ntransfer-encoding: chunked\r\n/i.test(wantHead);

      const answered = await exchange(port, request, chunked ? Number.MAX_SAFE_INTEGER : wantHead.length + wantBody.length);

      const [gotHead, gotBody] = splitHead(answered.toString('latin1'));
      expect(gotHead).toBe(wantHead);
      expect(chunked ? dechunk(gotBody) : gotBody).toBe(chunked ? dechunk(wantBody) : wantBody);
      expect(origin.heads).toHaveLength(1);
    },
  );

  it.each([
    {
      label: 'a header the gateway set is one Node refuses',
      legacy: `${LEGACY_COOKIES}ok`,
      ctx: { mode: 'stream', sessionMode: 'target-primary', beforeSend: () => Promise.resolve({ setCookies: ['CFID=bad\u0001value'] }) },
    },
    { label: 'legacy hangs up without answering', legacy: '', ctx: { mode: 'stream', sessionMode: 'legacy-primary' } },
  ] as const)("answers today's legacy-shaped 503 when $label", async ({ legacy, ctx }) => {
    const origin = await startRawLegacy(() => Buffer.from(legacy, 'latin1'));
    const gateways = await Promise.all([startGateway(origin.url, ctx), startGateway(origin.url, ctx, false)]);

    const [viaDispatcher, viaDefault] = await Promise.all(
      gateways.map(async ({ port }) => (await exchange(port, GET, Number.MAX_SAFE_INTEGER)).toString('latin1')),
    );

    expect(viaDispatcher?.split('\r\n')[0]).toBe(`HTTP/1.1 503 ${LEGACY_ERROR_STATUS_TEXT}`);
    expect(viaDispatcher).toBe(viaDefault);
    expect(viaDispatcher).not.toContain('CFID=');
  });

  it('forwards a 20 KB query and answers legacy’s 301 whose Location echoes it past 16 KB', async () => {
    const query = `q=${'a'.repeat(20_000)}`;
    const origin = await startRawLegacy((requestHead) => {
      const target = (requestHead.split('\r\n')[0] ?? '').split(' ')[1] ?? '';
      return Buffer.from(
        head('HTTP/1.1 301 Moved Permanently', DATE, `location: http://${HOST}${target}`, 'Content-Length: 0', 'Connection: keep-alive'),
        'latin1',
      );
    });
    const { port } = await startGateway(origin.url, { mode: 'stream', sessionMode: 'legacy-primary' });
    const expected = head(
      'HTTP/1.1 301 Moved Permanently',
      DATE,
      `location: http://${HOST}/admin/?${query}`,
      'Content-Length: 0',
      'Connection: keep-alive',
    );

    const answered = await exchange(port, head(`GET /admin/?${query} HTTP/1.1`, `Host: ${HOST}`), expected.length);

    expect(answered.toString('latin1')).toBe(expected);
    expect(origin.heads[0]?.startsWith(`GET /admin/?${query} HTTP/1.1\r\n`)).toBe(true);
  });
});

describe('legacy forward client connection', () => {
  it.each((['stream', 'buffer'] as const).flatMap((mode) => CONNECTION_CASES.map((row) => ({ mode, ...row }))))(
    '$mode mode: $label',
    async ({ mode, request, legacy, expected, next, nextExpected = NEXT_ANSWER }) => {
      const origin = await startRawLegacy(
        (requestHead) => Buffer.from(requestHead.startsWith('GET /next ') ? NEXT_ANSWER : legacy, 'latin1'),
        true,
      );
      const { port } = await startGateway(origin.url, { mode, sessionMode: 'legacy-primary' });

      const answered = await converse(port, next === undefined ? [request] : [request, next], [expected.length, nextExpected.length]);

      expect(answered.bytes).toBe(next === undefined ? expected : `${expected}${nextExpected}`);
      expect(answered.closed).toBe(next === undefined);
      // Legacy gets a persistent request, a HEAD included, and keeps serving the gateway on it.
      expect(origin.heads[0]).toMatch(/\r\nconnection: keep-alive(?:\r\n|$)/);
      expect(origin.connections()).toBe(1);
    },
  );

  it("closes a connection while the gateway drains, Connection: close at legacy's line", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const origin = await startRawLegacy(async (requestHead) => {
      if (requestHead.startsWith('GET /slow ')) await held;
      return Buffer.from(`${LEGACY_PLAIN}ok`, 'latin1');
    }, true);
    const { port, app } = await startGateway(origin.url, { mode: 'stream', sessionMode: 'legacy-primary' });
    const received: Buffer[] = [];
    const socket = connect(port, '127.0.0.1');
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    const ended = new Promise<void>((resolve) => socket.once('end', resolve));
    socket.write(head('GET /slow HTTP/1.1', `Host: ${HOST}`));
    await vi.waitFor(() => {
      expect(origin.heads).toHaveLength(1);
    });

    const closing = app.close();
    await vi.waitFor(() => {
      expect(app.server.listening).toBe(false);
    });
    socket.write(head('GET /during-close HTTP/1.1', `Host: ${HOST}`));
    await vi.waitFor(() => {
      expect(origin.heads).toHaveLength(2);
    });
    release();
    await Promise.all([ended, closing]);

    expect(Buffer.concat(received).toString('latin1')).toBe(`${LEGACY_PLAIN}ok${CLOSING_PLAIN}ok`);
  });
});
