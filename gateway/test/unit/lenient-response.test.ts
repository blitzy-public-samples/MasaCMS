// Tests the lenient forward: Node's lenient client reporting one exchange to undici's handler as undici would, failures coded as undici codes them.
import { Buffer } from 'node:buffer';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { Agent, type Dispatcher } from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { lenientResponse, withLenientResponse } from '../../src/dispatcher/lenient-response.js';

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
}

let servers: Server[] = [];
let agents: Agent[] = [];

afterEach(async () => {
  await Promise.all(agents.map((agent) => agent.destroy()));
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

async function upstream(answer: (socket: Socket) => void): Promise<RawUpstream> {
  const state: RawUpstream = { origin: '', requests: [], connections: 0 };
  const server = createServer((socket) => {
    state.connections += 1;
    let bytes = Buffer.alloc(0);
    let answered = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (answered || !wholeRequest(bytes)) return;
      answered = true;
      state.requests.push(bytes);
      answer(socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return state;
}

function lenientAgent(): Dispatcher {
  const agent = new Agent();
  agents.push(agent);
  return agent.compose(lenientResponse);
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
});
