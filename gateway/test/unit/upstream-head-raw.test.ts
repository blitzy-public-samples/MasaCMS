// Tests writeUpstreamHead on header values Node refuses to write: an upstream Location kept as received goes out byte for byte, any other refused value throws.
import { Buffer } from 'node:buffer';
import { createServer, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { writeUpstreamHead, type RawResponseHead } from '../../src/dispatcher/response-head.js';

/** A `Location` value only the lenient forward reads: DEL, NUL, a C0 control and 0xFF. */
const RAW = './?a\u007f\u0000\u0001b\u00ff';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  server = undefined;
});

/** Answers one HTTP/1.1 request with `respond`; resolves the answer's bytes as latin1 text. */
async function answer(respond: (res: ServerResponse) => void): Promise<string> {
  server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
}

describe('writeUpstreamHead with a value Node refuses', () => {
  const head: RawResponseHead = { statusCode: 302, statusMessage: 'Found', lines: ['Location', RAW, 'Content-Length', '0'] };
  const received: IncomingHttpHeaders = { location: RAW, 'content-length': '0' };

  it('writes the upstream line the reply kept as received byte for byte', async () => {
    const bytes = await answer((res) => {
      writeUpstreamHead(res, 302, head, received, { ...received } as OutgoingHttpHeaders);
      res.end();
    });

    expect(bytes.startsWith('HTTP/1.1 302 Found\r\nLocation: ./?a\u007f\u0000\u0001b\u00ff\r\nContent-Length: 0\r\n')).toBe(true);
    expect(bytes).not.toContain('opt2-raw-');
  });

  it.each<[string, RawResponseHead, IncomingHttpHeaders, OutgoingHttpHeaders]>([
    ['the upstream did not send', head, received, { ...received, location: `${RAW}x` } as OutgoingHttpHeaders],
    [
      'outside Location, though the upstream sent it',
      { ...head, lines: ['Set-Cookie', 'a=\u0001', 'Content-Length', '0'] },
      { 'set-cookie': ['a=\u0001'], 'content-length': '0' },
      { 'set-cookie': ['a=\u0001'], 'content-length': '0' },
    ],
  ])('throws as writeHead does for a refused value %s, leaving the response able to send another head', async (_case, upstreamHead, upstreamReceived, headers) => {
    let thrown: unknown;
    const bytes = await answer((res) => {
      try {
        writeUpstreamHead(res, 302, upstreamHead, upstreamReceived, headers);
      } catch (error) {
        thrown = error;
      }
      res.writeHead(502, { 'Content-Length': '0' }).end();
    });

    expect(thrown).toMatchObject({ code: 'ERR_INVALID_CHAR' });
    expect(bytes.startsWith('HTTP/1.1 502 Bad Gateway\r\n')).toBe(true);
  });
});
