import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import inject from 'light-my-request';

/** One request exactly as the double received it. */
export interface RecordedRequest {
  method: string;
  /** Request target without its query, as sent: neither decoded nor normalised. */
  path: string;
  /** Query parameters; a repeated key maps to its values in order. */
  query: Record<string, string | string[]>;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  /** Raw request target (`req.url`). */
  url: string;
  /** Body bytes as received; empty when there is none. */
  body: Buffer;
}

/** Answers a recorded request; a response it leaves unended stays open until `close()`. */
export type DoubleHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/** Loopback HTTP server standing in for an upstream in gateway tests. */
export interface HttpDouble {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  url: string;
  port: number;
  requests: RecordedRequest[];
  setHandler(handler: DoubleHandler): void;
  clearRequests(): void;
  /** Destroys every connection, hung responses included, then stops listening; safe to call repeatedly. */
  close(): Promise<void>;
}

/** An {@link HttpDouble} served in process: its `fetch` reaches the handler without a socket. */
export type InProcessDouble = Omit<HttpDouble, 'port'> & {
  /** Serves calls to `url`; any other origin, and every call after `close()`, is refused. */
  fetch: typeof fetch;
};

/** Statuses fetch delivers without a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

function parseQuery(search: string): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [key, value] of new URLSearchParams(search)) {
    const previous = query.get(key);
    if (previous === undefined) query.set(key, value);
    else if (typeof previous === 'string') query.set(key, [previous, value]);
    else previous.push(value);
  }
  // fromEntries defines own properties, so a `__proto__` parameter stays data.
  return Object.fromEntries(query);
}

async function record(req: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  // Split by hand: WHATWG URL parsing would fold `//` prefixes and dot segments the gateway actually sent.
  const url = req.url ?? '/';
  const queryAt = url.indexOf('?');
  return {
    method: req.method ?? 'GET',
    path: queryAt === -1 ? url : url.slice(0, queryAt),
    query: queryAt === -1 ? {} : parseQuery(url.slice(queryAt + 1)),
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    url,
    body: Buffer.concat(chunks),
  };
}

/** Ends `res` with `status`, each header as given (an array value repeats the header) and `body` unchanged. */
export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer | string,
  headers: Record<string, string | string[]> = {},
): void {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(body);
}

/** Ends `res` with `body` serialised as JSON; `headers` may replace the JSON content type. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  sendBytes(res, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8', ...headers });
}

/** Records each request, then answers it with the current handler; a handler error answers 500. */
function recorder(handler: DoubleHandler) {
  let current = handler;
  const requests: RecordedRequest[] = [];

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let recorded: RecordedRequest;
    try {
      recorded = await record(req);
    } catch {
      // The client went away mid-body: there is no complete request to record or answer.
      res.destroy();
      return;
    }
    requests.push(recorded);
    try {
      await current(recorded, res);
    } catch (error) {
      if (!res.headersSent) {
        sendBytes(res, 500, error instanceof Error ? error.message : String(error), {
          'content-type': 'text/plain; charset=utf-8',
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  }

  return {
    serve,
    requests,
    setHandler(next: DoubleHandler) {
      current = next;
    },
    clearRequests() {
      requests.length = 0;
    },
  };
}

/** Starts a double on an ephemeral 127.0.0.1 port; resolves once it is listening. */
export async function startHttpDouble(handler: DoubleHandler): Promise<HttpDouble> {
  const { serve, ...recorded } = recorder(handler);
  let closing: Promise<void> | undefined;
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    void serve(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    ...recorded,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

/** The TypeError fetch rejects with when nothing accepts the connection. */
function connectionRefused(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
}

/** A `fetch` refusing every call, as against an origin nothing listens on. */
export function refusingFetch(): typeof fetch {
  return () => Promise.reject(connectionRefused());
}

/** Settles as `pending` does unless `signal` aborts first, which rejects with its reason, as fetch does. */
function unlessAborted<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve(pending)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Creates a double whose `fetch` serves calls to `url`, an origin without a trailing slash, in process.
 * Requests are recorded as {@link startHttpDouble} records them, with the target exactly as sent; redirects are never followed.
 */
export function createInProcessDouble(handler: DoubleHandler, url = 'http://double.test'): InProcessDouble {
  const { serve, ...recorded } = recorder(handler);
  const open = new Set<ServerResponse>();
  let closed = false;

  async function inProcessFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = new Request(input, init);
    if (closed || !raw.startsWith(url) || new URL(raw).origin !== url) throw connectionRefused();
    const { signal } = request;
    signal.throwIfAborted();
    const rest = raw.slice(url.length);
    const target = rest.startsWith('/') ? rest : `/${rest}`;
    const payload = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    let served: ServerResponse | undefined;

    const exchange = inject(
      (req, res) => {
        // light-my-request normalises the target it is given; the handler sees it as sent.
        req.url = target;
        served = res;
        open.add(res);
        res.once('close', () => open.delete(res));
        void serve(req, res);
      },
      { method: request.method, url: target, headers: Object.fromEntries(request.headers), payload, payloadAsStream: true },
    );
    const answered = await unlessAborted(exchange, signal).catch((error: unknown) => {
      served?.destroy();
      throw signal.aborted ? signal.reason : new TypeError('fetch failed', { cause: error });
    });

    const body = answered.stream();
    const onAbort = (): void => {
      body.destroy(signal.reason);
      served?.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    body.once('close', () => signal.removeEventListener('abort', onAbort));
    const headers = new Headers();
    for (const [name, value] of Object.entries(answered.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
    }
    const bodyless = NULL_BODY_STATUSES.has(answered.statusCode);
    if (bodyless) body.resume();
    return new Response(bodyless ? null : (Readable.toWeb(body) as ReadableStream<Uint8Array>), {
      status: answered.statusCode,
      statusText: answered.statusMessage,
      headers,
    });
  }

  return {
    url,
    ...recorded,
    fetch: inProcessFetch,
    close() {
      closed = true;
      for (const res of open) res.destroy();
      return Promise.resolve();
    },
  };
}
