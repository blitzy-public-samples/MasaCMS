import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

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

/** Starts a double on an ephemeral 127.0.0.1 port; resolves once it is listening. */
export async function startHttpDouble(handler: DoubleHandler): Promise<HttpDouble> {
  let current = handler;
  let closing: Promise<void> | undefined;
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

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
    requests,
    setHandler(next) {
      current = next;
    },
    clearRequests() {
      requests.length = 0;
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
