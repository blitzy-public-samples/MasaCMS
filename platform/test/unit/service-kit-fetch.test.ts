// Unit tests for createSignalBoundFetch against a local HTTP server.
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSignalBoundFetch } from '../../src/service-kit/fetch.js';

interface Received {
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  res: ServerResponse;
}

// undici's default header and body timeouts, which Node's global fetch applies.
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;

let server: Server;
let origin: string;
let onRequest: (received: Received) => void = () => undefined;

/** Resolves with the next request the server has read in full; its answer is left to the test. */
function nextRequest(): Promise<Received> {
  return new Promise((resolve) => {
    onRequest = resolve;
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => onRequest({ method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks), res }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Runs first under one fake clock, because undici's low-resolution timer clock is module state that keeps the first
// clock it was scheduled on.
describe('createSignalBoundFetch past undici default timeouts', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("receives headers delayed past undici's default header timeout", async () => {
    const arrived = nextRequest();
    const answer = createSignalBoundFetch()(`${origin}/late-headers`);
    const { res } = await arrived;

    await vi.advanceTimersByTimeAsync(UNDICI_DEFAULT_TIMEOUT_MS + 10_000);
    res.end('late');

    await expect((await answer).text()).resolves.toBe('late');
  });

  it("receives a body stalled past undici's default body timeout", async () => {
    const arrived = nextRequest();
    const answer = createSignalBoundFetch()(`${origin}/late-body`);
    const { res } = await arrived;
    res.writeHead(200);
    res.write('la');
    const text = (await answer).text();

    await vi.advanceTimersByTimeAsync(UNDICI_DEFAULT_TIMEOUT_MS + 10_000);
    res.end('te');

    await expect(text).resolves.toBe('late');
  });
});

describe('createSignalBoundFetch', () => {
  it('rejects with the abort reason when the signal fires before the answer headers', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const arrived = nextRequest();
    const answer = createSignalBoundFetch()(`${origin}/stalled-headers`, { signal: controller.signal });
    await arrived;

    controller.abort(reason);

    await expect(answer).rejects.toBe(reason);
  });

  it('rejects the body read with the abort reason when the signal fires mid-body', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const arrived = nextRequest();
    const answer = createSignalBoundFetch()(`${origin}/stalled-body`, { signal: controller.signal });
    const { res } = await arrived;
    res.writeHead(200);
    res.write('par');
    const text = (await answer).text();

    controller.abort(reason);

    await expect(text).rejects.toBe(reason);
  });

  it('sends a streamed AsyncIterable body unchunked under its Content-Length', async () => {
    const bytes = Buffer.from('streamed through the signal-bound fetch');
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield bytes.subarray(0, 8);
      yield bytes.subarray(8);
    }
    const arrived = nextRequest();
    const answer = createSignalBoundFetch()(`${origin}/upload`, {
      method: 'POST',
      headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' },
      body: chunks(),
      duplex: 'half',
    });
    const received = await arrived;
    received.res.end('stored');

    await expect((await answer).text()).resolves.toBe('stored');
    expect(received.method).toBe('POST');
    expect(received.body.equals(bytes)).toBe(true);
    expect(received.headers['content-length']).toBe(String(bytes.length));
    expect(received.headers['transfer-encoding']).toBeUndefined();
  });

  it.each<[string, () => [Request | string, RequestInit | undefined], string, RegExp, string]>([
    [
      'a global Request input',
      () => [new Request(`${origin}/request`, { method: 'PUT', body: 'from a Request' }), undefined],
      'PUT',
      /^text\/plain/,
      'from a Request',
    ],
    [
      'a global FormData body',
      () => {
        const form = new FormData();
        form.set('field', 'from a FormData');
        return [`${origin}/form`, { method: 'POST', body: form }];
      },
      'POST',
      /^multipart\/form-data; boundary=/,
      'from a FormData',
    ],
  ])('sends %s with its method, content type and body', async (_label, build, method, contentType, content) => {
    const arrived = nextRequest();
    const answer = createSignalBoundFetch()(...build());
    const received = await arrived;
    received.res.end('ok');

    await expect((await answer).text()).resolves.toBe('ok');
    expect(received.method).toBe(method);
    expect(received.headers['content-type']).toMatch(contentType);
    expect(received.body.toString('utf8')).toContain(content);
  });
});
