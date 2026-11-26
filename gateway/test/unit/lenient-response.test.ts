// Tests the lenient forward: Node's strict client, its `Location` bytes escaped, reporting one exchange to undici's handler as undici would, failures coded as undici or Node's parser codes them.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createTlsServer, getCACertificates, setDefaultCACertificates, type TLSSocket } from 'node:tls';
import { Agent, SERVICE_MAX_HEADER_SIZE, type Dispatcher } from '@opt2/platform/service-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LenientForwards, withLenientResponse } from '../../src/dispatcher/lenient-response.js';
import { FORWARD_CONNECTIONS, replyFromOptions } from '../../src/dispatcher/response-head.js';

/** A head undici's parser refuses: a reason phrase in UTF-8, a `Location` with DEL, NUL, a C0 control and 0xFF, a repeated name. */
const REFUSED_HEAD = Buffer.concat([
  Buffer.from('HTTP/1.1 302 Trouv\u00c3\u00a9\r\n', 'latin1'),
  Buffer.from('Location: ./?a\u007f\u0000\u0001b\u00ff\r\n', 'latin1'),
  Buffer.from('Set-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 5\r\n\r\nhello', 'latin1'),
]);

/** One raw upstream: `answer` gets each connection once its request, head and body, has fully arrived. */
interface RawUpstream {
  origin: string;
  /** Each connection's request bytes, as received. */
  requests: Buffer[];
  connections: number;
  /** Connections that have closed. */
  closed: number;
  /** Each TLS connection's server name, false for none. */
  servernames: Array<string | false | null>;
}

/** A TLS key and certificate, in PEM. */
interface Credentials {
  key: string;
  cert: string;
}

let servers: Server[] = [];
let agents: Dispatcher[] = [];
/** Every upstream connection, destroyed after each test so a held one never stalls its server's close. */
const accepted = new Set<Socket>();

afterEach(async () => {
  await Promise.all(agents.map((agent) => agent.destroy()));
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
  agents = [];
});

/** Whether `bytes` hold one whole request: its head and the body its framing declares. */
function wholeRequest(bytes: Buffer): boolean {
  const end = bytes.indexOf('\r\n\r\n');
  if (end < 0) return false;
  const head = bytes.subarray(0, end).toString('latin1').toLowerCase();
  const length = /\r\ncontent-length: *(\d+)/.exec(head);
  if (length !== null) return bytes.length - end - 4 >= Number(length[1]);
  if (/\r\ntransfer-encoding: *chunked/.test(head)) return bytes.subarray(end).includes('\r\n0\r\n\r\n');
  return true;
}

/** A raw upstream, over TLS with `credentials`; `ipv6` listens on the IPv4-mapped loopback, its origin an IPv6 literal. */
async function upstream(answer: (socket: Socket) => void, credentials?: Credentials, ipv6 = false): Promise<RawUpstream> {
  const state: RawUpstream = { origin: '', requests: [], connections: 0, closed: 0, servernames: [] };
  const connected = (socket: Socket): void => {
    accepted.add(socket);
    state.connections += 1;
    if (credentials !== undefined) state.servernames.push((socket as TLSSocket).servername);
    let bytes = Buffer.alloc(0);
    let answered = false;
    socket.on('error', () => undefined);
    socket.on('close', () => {
      state.closed += 1;
    });
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (answered || !wholeRequest(bytes)) return;
      answered = true;
      state.requests.push(bytes);
      answer(socket);
    });
  };
  const server = credentials === undefined ? createServer(connected) : createTlsServer(credentials, connected);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, ipv6 ? '::ffff:127.0.0.1' : '127.0.0.1', resolve));
  state.origin = `${credentials === undefined ? 'http' : 'https'}://${ipv6 ? '[::ffff:127.0.0.1]' : '127.0.0.1'}:${String((server.address() as AddressInfo).port)}`;
  return state;
}

function lenientAgent(forwards = new LenientForwards(FORWARD_CONNECTIONS)): Dispatcher {
  const agent = new Agent();
  agents.push(agent);
  return agent.compose(forwards.interceptor);
}

/** The forward agent of a gateway, closed after the test. */
function forwardAgent(): Dispatcher {
  const dispatcher = replyFromOptions().undici as unknown as Dispatcher;
  agents.push(dispatcher);
  return dispatcher;
}

/** Reads `origin`'s answer through undici's parser; rejects where it refuses the head or body. */
async function undiciRead(origin: string, headers: Record<string, string> = {}): Promise<string> {
  const agent = new Agent();
  agents.push(agent);
  const res = await agent.request({ origin, path: '/', method: 'GET', headers });
  return res.body.text();
}

/** What a handler heard of one exchange. */
interface Heard {
  started: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
  body: Buffer;
  trailers?: Record<string, string | string[] | undefined>;
  rawTrailers?: string[];
  error?: Error & { code?: string };
}

/** Dispatches `options` under the lenient parser to a handler that records what it hears; `steer` may act on its controller. */
function exchange(
  dispatcher: Dispatcher,
  options: Dispatcher.DispatchOptions,
  steer: {
    onStart?: (controller: Dispatcher.DispatchController) => void;
    onHead?: (controller: Dispatcher.DispatchController) => void;
    onData?: (controller: Dispatcher.DispatchController) => void;
  } = {},
): Promise<Heard> {
  const heard: Heard = { started: false, body: Buffer.alloc(0) };
  const latin1 = (lines: Dispatcher.DispatchController['rawHeaders']): string[] =>
    Array.isArray(lines) ? (lines as Array<Buffer | string>).map((line) => (typeof line === 'string' ? line : line.toString('latin1'))) : [];
  return new Promise((resolve) => {
    withLenientResponse(() =>
      dispatcher.dispatch(options, {
        onRequestStart(controller) {
          heard.started = true;
          steer.onStart?.(controller);
        },
        onResponseStart(controller, status, headers, statusText) {
          Object.assign(heard, { status, headers, statusText, rawHeaders: latin1(controller.rawHeaders) });
          steer.onHead?.(controller);
        },
        onResponseData(controller, chunk) {
          heard.body = Buffer.concat([heard.body, chunk]);
          steer.onData?.(controller);
        },
        onResponseEnd(controller, trailers) {
          Object.assign(heard, { trailers, rawTrailers: latin1(controller.rawTrailers) });
          resolve(heard);
        },
        onResponseError(_controller, error) {
          heard.error = error;
          resolve(heard);
        },
      }),
    );
  });
}

describe('lenientResponse', () => {
  it("reports a head undici's parser refuses byte for byte, with its body, to the first dispatch under withLenientResponse", async () => {
    const up = await upstream((socket) => socket.end(REFUSED_HEAD));

    const heard = await exchange(lenientAgent(), {
      origin: up.origin,
      path: '/admin/index.cfm?x=%00',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '3', 'x-absent': undefined },
      body: 'a=1',
    });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, statusText: 'Trouvé', body: Buffer.from('hello') });
    expect(heard.headers).toEqual({ location: './?a\u007f\u0000\u0001b\u00ff', 'set-cookie': ['a=1', 'b=2'], 'content-length': '5' });
    expect(heard.rawHeaders).toEqual(['Location', './?a\u007f\u0000\u0001b\u00ff', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
    expect(heard.trailers).toEqual({});
    // The head undici writes: host and connection first, the given lines, then the body's length.
    expect((up.requests[0] ?? Buffer.alloc(0)).toString('latin1')).toBe(
      `POST /admin/index.cfm?x=%00 HTTP/1.1\r\nhost: ${new URL(up.origin).host}\r\nconnection: keep-alive\r\ncontent-type: application/x-www-form-urlencoded\r\ncontent-length: 3\r\n\r\na=1`,
    );
  });

  it("leaves undici's parser on every dispatch outside withLenientResponse and on a later one under it", async () => {
    const up = await upstream((socket) => socket.end(REFUSED_HEAD));
    const dispatcher = lenientAgent();
    const get = (): Promise<unknown> => dispatcher.request({ origin: up.origin, path: '/', method: 'GET' }).then(async (res) => res.body.text());

    await expect(get()).rejects.toThrow(/Invalid header value char/);
    await expect(
      withLenientResponse(async () => {
        const first = await get();
        return [first, await get().catch((error: unknown) => (error as Error).message)];
      }),
    ).resolves.toEqual(['hello', expect.stringMatching(/Invalid header value char/)]);
  });

  it('reports trailers, and a body streamed both ways under backpressure', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    const up = await upstream((socket) => {
      const parts = ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Done\r\n\r\n'];
      for (let index = 0; index < 8; index += 1) parts.push(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      parts.push('0\r\nX-Done: yes\r\n\r\n');
      socket.end(parts.join(''));
    });
    let paused = 0;

    const heard = await exchange(
      lenientAgent(),
      { origin: up.origin, path: '/', method: 'PUT', headers: ['Host', 'legacy.test', 'X-Many', 'a', 'X-Many', 'b'], body: Readable.from(['ab', 'cd']) },
      {
        onHead(controller) {
          paused += 1;
          controller.pause();
          setTimeout(() => controller.resume(), 1);
        },
        onData(controller) {
          // Resuming a flowing exchange is a no-op.
          controller.resume();
          paused += 1;
          controller.pause();
          setTimeout(() => controller.resume(), 1);
        },
      },
    );

    expect(heard.error).toBeUndefined();
    expect(heard.body.length).toBe(8 * chunk.length);
    expect(paused).toBeGreaterThan(1);
    expect(heard.trailers).toEqual({ 'x-done': 'yes' });
    expect(heard.rawTrailers).toEqual(['X-Done', 'yes']);
    expect((up.requests[0] ?? Buffer.alloc(0)).toString('latin1')).toBe(
      'PUT / HTTP/1.1\r\nhost: legacy.test\r\nconnection: keep-alive\r\nX-Many: a\r\nX-Many: b\r\ntransfer-encoding: chunked\r\n\r\n2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n',
    );
  });

  it.each([
    ['pairs, a reset closing', { method: 'GET', reset: true }, 'GET / HTTP/1.1\r\nhost: HOST\r\nconnection: close\r\nx-one: 1\r\nx-many: a\r\nx-many: b\r\n\r\n'],
    ['pairs, a given close closing', { method: 'POST', connection: 'Close' }, 'POST / HTTP/1.1\r\nhost: HOST\r\nconnection: close\r\nx-one: 1\r\nx-many: a\r\nx-many: b\r\ncontent-length: 0\r\n\r\n'],
    ['pairs, a buffer body framed by its length', { method: 'PUT', body: Buffer.from('xyz') }, 'PUT / HTTP/1.1\r\nhost: HOST\r\nconnection: keep-alive\r\nx-one: 1\r\nx-many: a\r\nx-many: b\r\ncontent-length: 3\r\n\r\nxyz'],
  ] as const)('sends headers given as an iterable of %s, as undici writes them', async (_case, { connection, ...overrides }: { method: string; reset?: boolean; connection?: string; body?: Buffer }, expected) => {
    const up = await upstream((socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'));

    const heard = await exchange(lenientAgent(), {
      origin: up.origin,
      path: '/',
      ...overrides,
      headers: new Map<string, string | string[] | undefined>([
        ['x-one', '1'],
        ['x-many', ['a', 'b']],
        ['x-absent', undefined],
        ...(connection === undefined ? [] : [['connection', connection] as [string, string]]),
      ]) as unknown as Dispatcher.DispatchOptions['headers'],
    });

    expect(heard).toMatchObject({ status: 204, body: Buffer.alloc(0) });
    expect((up.requests[0] ?? Buffer.alloc(0)).toString('latin1')).toBe(expected.replace('HOST', new URL(up.origin).host));
  });

  it.each([
    ['UND_ERR_HEADERS_TIMEOUT', (): void => undefined, { headersTimeout: 50 }],
    ['UND_ERR_BODY_TIMEOUT', (socket: Socket): void => void socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab'), { bodyTimeout: 50 }],
    ['ECONNRESET', (socket: Socket): void => void socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab'), {}],
  ] as const)("fails with %s, a code the gateway reads as undici's", async (code, answer, bounds) => {
    const up = await upstream(answer);

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET', ...bounds });

    expect(heard.error?.code).toBe(code);
  });

  it('reports a refused connection with its socket code', async () => {
    const up = await upstream(() => undefined);
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.error?.code).toBe('ECONNREFUSED');
  });

  it.each([
    ['a header Node refuses to send', { headers: { 'x-bad': 'a\nb' } }],
    ['a header undici refuses', { headers: { 'transfer-encoding': 'chunked' } }],
    ['a connection option undici refuses', { headers: { connection: 'upgrade' } }],
    ['a body it cannot send', { method: 'POST', body: new FormData() as unknown as string }],
    ['an origin protocol neither client sends', { origin: 'ftp://127.0.0.1:1' }],
  ])('refuses %s before sending any of it, coded as undici codes an argument it refuses', async (_case, overrides) => {
    const up = await upstream((socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET', ...overrides });

    expect(heard.error).toMatchObject({ name: 'LenientRequestRefusedError', code: 'UND_ERR_INVALID_ARG' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(up.requests).toEqual([]);
  });

  it('fails the exchange with a request body stream that errors', async () => {
    const up = await upstream((socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'));
    const failure = new Error('body broke');
    const body = new Readable({ read: () => undefined });
    setTimeout(() => body.destroy(failure), 10);

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'POST', body });

    expect(heard.error).toBe(failure);
  });

  it('stops the exchange its handler aborts, before sending or once the head arrives', async () => {
    const up = await upstream((socket) => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab'));
    const early = new Error('aborted early');
    const late = new Error('aborted late');

    const before = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' }, { onStart: (controller) => controller.abort(early) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(before).toMatchObject({ started: true, error: early });
    expect(up.connections).toBe(0);

    let aborted: Dispatcher.DispatchController | undefined;
    const after = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' }, {
      onData(controller) {
        aborted = controller;
        controller.abort(late);
        controller.abort(early);
      },
    });
    expect(after).toMatchObject({ status: 200, body: Buffer.from('ab'), error: late });
    expect(aborted).toMatchObject({ aborted: true, reason: late });
  });

  it.each([
    ['a C0 control in a header but Location', 'HTTP/1.1 200 OK\r\nSet-Cookie: a=\u0001\r\nContent-Length: 0\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['DEL in a header but Location', 'HTTP/1.1 200 OK\r\nX-Note: a\u007fb\r\nContent-Length: 0\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['Content-Length with Transfer-Encoding', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n', 'HPE_INVALID_TRANSFER_ENCODING'],
    ['a repeated Content-Length', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nok', 'HPE_UNEXPECTED_CONTENT_LENGTH'],
    ['a Content-Length but digits', 'HTTP/1.1 200 OK\r\nContent-Length: +2\r\n\r\nok', 'HPE_INVALID_CONTENT_LENGTH'],
    ['a header name outside the token set', 'HTTP/1.1 200 OK\r\nX(Note: 1\r\nContent-Length: 0\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['a C0 control in a header whose name only ends in Location', 'HTTP/1.1 302 Found\r\nX-Location: a\u0001\r\nContent-Length: 0\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['a NUL in a header but Location', 'HTTP/1.1 302 Found\r\nLocation: ./\r\nX-Note: a\u0000b\r\nContent-Length: 0\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['a version but 1.0 or 1.1', 'HTTP/1.2 200 OK\r\nContent-Length: 0\r\n\r\n', 'HPE_INVALID_VERSION'],
    ['a line a bare LF ends', 'HTTP/1.1 200 OK\r\nX-Note: 1\nContent-Length: 0\r\n\r\n', 'HPE_CR_EXPECTED'],
    ['a bare LF in the final head after a 1xx head', 'HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 200 OK\nContent-Length: 0\n\n', 'HPE_CR_EXPECTED'],
    ['a folded line', 'HTTP/1.1 200 OK\r\nX-Note: 1\r\n 2\r\nContent-Length: 0\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
  ])("refuses a head with %s, which undici's parser refuses, before reporting it", async (_case, head, code) => {
    const up = await upstream((socket) => socket.end(Buffer.from(head, 'latin1')));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.status).toBeUndefined();
    expect(heard.error).toMatchObject({ code });
    await expect(undiciRead(up.origin)).rejects.toBeInstanceOf(Error);
  });

  it('reads the final head after a 1xx head', async () => {
    const up = await upstream((socket) => socket.end(Buffer.concat([Buffer.from('HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n'), REFUSED_HEAD])));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, body: Buffer.from('hello') });
    expect(heard.rawHeaders).toEqual(['Location', './?a\u007f\u0000\u0001b\u00ff', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
  });

  it('reads the final head after 1xx heads that together exceed the head limit, each within it', async () => {
    const early = `HTTP/1.1 103 Early Hints\r\nLink: <${'a'.repeat(SERVICE_MAX_HEADER_SIZE / 2)}>\r\n\r\n`;
    const up = await upstream((socket) => socket.end(Buffer.concat([Buffer.from(early.repeat(3)), REFUSED_HEAD])));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, body: Buffer.from('hello') });
    expect(heard.rawHeaders).toEqual(['Location', './?a\u007f\u0000\u0001b\u00ff', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
  });

  it('relays a Location holding every byte but CR and LF exactly, the escape byte 0xFF and obs-text included', async () => {
    const bytes = Array.from({ length: 256 }, (_, byte) => String.fromCharCode(byte)).filter((char) => char !== '\r' && char !== '\n');
    const location = `./?${bytes.join('')}\u00ff@\u00ff\u00ffz`;
    const up = await upstream((socket) => socket.end(Buffer.from(`HTTP/1.1 302 Found\r\nlocation: ${location}\r\nContent-Length: 0\r\n\r\n`, 'latin1')));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, headers: { location, 'content-length': '0' } });
    expect(heard.rawHeaders).toEqual(['location', location, 'Content-Length', '0']);
  });

  it('reads the refused head from an origin whose host is an IPv6 literal, its Host line bracketed as undici writes it', async () => {
    const up = await upstream((socket) => socket.end(REFUSED_HEAD), undefined, true);

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, body: Buffer.from('hello') });
    expect(heard.rawHeaders).toEqual(['Location', './?a\u007f\u0000\u0001b\u00ff', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
    expect((up.requests[0] ?? Buffer.alloc(0)).toString('latin1')).toBe(`GET / HTTP/1.1\r\nhost: ${new URL(up.origin).host}\r\nconnection: keep-alive\r\n\r\n`);
    expect(new URL(up.origin).host).toMatch(/^\[::ffff:7f00:1\]:\d+$/);
  });

  it('reads the refused head byte for byte when it arrives a few bytes at a time', async () => {
    const up = await upstream((socket) => {
      socket.setNoDelay(true);
      void (async () => {
        for (let at = 0; at < REFUSED_HEAD.length; at += 3) {
          socket.write(REFUSED_HEAD.subarray(at, at + 3));
          await delay(2);
        }
        socket.end();
      })();
    });

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, statusText: 'Trouvé', body: Buffer.from('hello') });
    expect(heard.rawHeaders).toEqual(['Location', './?a\u007f\u0000\u0001b\u00ff', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
  });

  it.each([
    ['a chunk size with trailing space', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2 \r\nok\r\n0\r\n\r\n', 'HPE_INVALID_CHUNK_SIZE'],
    ['a bare LF in chunk framing', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\nok\r\n0\r\n\r\n', 'HPE_CR_EXPECTED'],
    ['a C0 control in a trailer', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX-Done: a\u0001\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['DEL in a Location trailer', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nLocation: a\u007f\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
  ])("fails the exchange on a body with %s, which undici's parser refuses, after reporting its head", async (_case, answer, code) => {
    const up = await upstream((socket) => socket.end(Buffer.from(answer, 'latin1')));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.status).toBe(200);
    expect(heard.trailers).toBeUndefined();
    expect(heard.error).toMatchObject({ code });
    await expect(undiciRead(up.origin)).rejects.toBeInstanceOf(Error);
  });

  it('refuses a head line over the head limit as Node does, while the upstream holds its connection open', async () => {
    const up = await upstream((socket) => void socket.write(`HTTP/1.1 302 Found\r\nLocation: ./?${'a'.repeat(SERVICE_MAX_HEADER_SIZE)}`));

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.status).toBeUndefined();
    expect(heard.error).toMatchObject({ code: 'HPE_HEADER_OVERFLOW' });
  });

  it('holds at most its limit of exchanges in flight per origin, refusing more before sending, each connection closed once its exchange ends', async () => {
    const held: Socket[] = [];
    let holding = true;
    const up = await upstream((socket) => {
      if (holding) held.push(socket);
      else socket.write('HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n');
    });
    const other = await upstream((socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'));
    const dispatcher = lenientAgent(new LenientForwards(2));
    const get = (origin: string): Promise<Heard> => exchange(dispatcher, { origin, path: '/', method: 'GET' });

    const first = get(up.origin);
    const second = get(up.origin);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect((await get(up.origin)).error).toMatchObject({ name: 'LenientRequestRefusedError', code: 'UND_ERR_INVALID_ARG' });
    expect(await get(other.origin)).toMatchObject({ status: 204 });
    expect(up.connections).toBe(2);

    holding = false;
    held[0]?.write('HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n');
    expect(await first).toMatchObject({ status: 204 });
    await vi.waitFor(() => expect(up.closed).toBe(1));
    await vi.waitFor(async () => expect(await get(up.origin)).toMatchObject({ status: 204 }));
    held[1]?.write('HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n');
    expect(await second).toMatchObject({ status: 204 });
    await vi.waitFor(() => expect(up.closed).toBe(up.connections));
  });

  it("ends with the gateway's forward agent: close drains the exchanges in flight, destroy fails them, each refusing later ones", async () => {
    const held: Socket[] = [];
    const up = await upstream((socket) => held.push(socket));
    const closing = forwardAgent();
    const destroying = forwardAgent();
    const get = (dispatcher: Dispatcher): Promise<Heard> => exchange(dispatcher, { origin: up.origin, path: '/', method: 'GET' });

    const drained = get(closing);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    let closed = false;
    const close = closing.close().then(() => {
      closed = true;
    });
    expect((await get(closing)).error).toMatchObject({ name: 'LenientEndedError', code: 'UND_ERR_CLOSED' });
    await delay(50);
    expect(closed).toBe(false);
    held[0]?.end('HTTP/1.1 204 No Content\r\n\r\n');
    expect(await drained).toMatchObject({ status: 204 });
    await close;

    const failed = get(destroying);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    await destroying.destroy();
    expect((await failed).error).toMatchObject({ code: 'UND_ERR_DESTROYED' });
    expect((await get(destroying)).error).toMatchObject({ code: 'UND_ERR_DESTROYED' });
    expect(up.connections).toBe(2);
    await vi.waitFor(() => expect(up.closed).toBe(2));
  });

  it("refuses the forward agent's ordinary requests from the start of its close, while a held lenient exchange drains before the close resolves", async () => {
    const held: Socket[] = [];
    const up = await upstream((socket) => held.push(socket));
    const closing = forwardAgent();
    const ordinary = (): Promise<unknown> => closing.request({ origin: up.origin, path: '/', method: 'GET' }).then(async (res) => res.body.text());

    const drained = exchange(closing, { origin: up.origin, path: '/', method: 'GET' });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    let closed = false;
    const close = closing.close().then(() => {
      closed = true;
    });
    await expect(ordinary()).rejects.toMatchObject({ name: 'ClientClosedError', code: 'UND_ERR_CLOSED' });
    await delay(50);
    // undici's own part has drained, so it is destroyed, as undici's close leaves it.
    await expect(ordinary()).rejects.toMatchObject({ name: 'ClientDestroyedError', code: 'UND_ERR_DESTROYED' });
    expect(closed).toBe(false);
    expect(up.connections).toBe(1);
    held[0]?.end('HTTP/1.1 204 No Content\r\n\r\n');
    expect(await drained).toMatchObject({ status: 204 });
    await close;
    await expect(closing.close()).rejects.toMatchObject({ code: 'UND_ERR_DESTROYED' });
  });

  it("fails a held lenient exchange when the forward agent is destroyed during its close, which then resolves", async () => {
    const held: Socket[] = [];
    const up = await upstream((socket) => held.push(socket));
    const closing = forwardAgent();

    const failed = exchange(closing, { origin: up.origin, path: '/', method: 'GET' });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const close = closing.close();
    await delay(20);
    await closing.destroy();

    expect((await failed).error).toMatchObject({ code: 'UND_ERR_DESTROYED' });
    await close;
    await vi.waitFor(() => expect(up.closed).toBe(1));
  });
});

/** A self-signed certificate for `legacy.test`, 127.0.0.1 and ::ffff:127.0.0.1, made in `dir` and removed from it. */
function selfSigned(dir: string, name: string): Credentials {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=legacy.test', '-addext', 'subjectAltName=DNS:legacy.test,IP:127.0.0.1,IP:::ffff:127.0.0.1', '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  const credentials = { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  rmSync(key);
  rmSync(cert);
  return credentials;
}

describe('lenientResponse to an HTTPS origin', () => {
  let trusted: Credentials;
  let untrusted: Credentials;
  let defaults: string[];

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'opt2-lenient-tls-'));
    try {
      trusted = selfSigned(dir, 'trusted');
      untrusted = selfSigned(dir, 'untrusted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    defaults = getCACertificates('default');
    setDefaultCACertificates([...defaults, trusted.cert]);
  });

  afterAll(() => {
    setDefaultCACertificates(defaults);
  });

  it.each([
    ["none for the origin's IP literal", {}, false],
    ["the Host line's host name", { host: 'legacy.test:8443' }, 'legacy.test'],
  ] as const)('reads the refused head byte for byte over a verified connection, sending as server name %s, as undici does', async (_case, headers, servername) => {
    const up = await upstream((socket) => socket.end(REFUSED_HEAD), trusted);
    const plain = await upstream((socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'), trusted);

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET', headers });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, statusText: 'Trouvé', body: Buffer.from('hello') });
    expect(heard.rawHeaders).toEqual(['Location', './?a\u007f\u0000\u0001b\u00ff', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
    await expect(undiciRead(plain.origin, headers)).resolves.toBe('');
    expect([...up.servernames, ...plain.servernames]).toEqual([servername, servername]);
  });

  it("reads the refused head over a connection to an IPv6-literal origin, verified against that address and sending no server name, as undici does", async () => {
    const up = await upstream((socket) => socket.end(REFUSED_HEAD), trusted, true);
    const plain = await upstream((socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'), trusted, true);

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET' });

    expect(heard.error).toBeUndefined();
    expect(heard).toMatchObject({ status: 302, body: Buffer.from('hello') });
    expect(heard.rawHeaders).toEqual(['Location', './?a\u007f\u0000\u0001b\u00ff', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
    await expect(undiciRead(plain.origin)).resolves.toBe('');
    expect([...up.servernames, ...plain.servernames]).toEqual([false, false]);
  });

  it.each([
    ['a certificate no trusted CA signed', 'untrusted', {}, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    ['a certificate for another name than the Host line', 'trusted', { host: 'other.test' }, 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ] as const)('fails the exchange on %s, sending nothing', async (_case, which, headers, code) => {
    const up = await upstream((socket) => socket.end(REFUSED_HEAD), which === 'trusted' ? trusted : untrusted);

    const heard = await exchange(lenientAgent(), { origin: up.origin, path: '/', method: 'GET', headers });

    expect(heard.status).toBeUndefined();
    expect(heard.error?.code).toBe(code);
    expect(up.requests).toEqual([]);
  });
});
