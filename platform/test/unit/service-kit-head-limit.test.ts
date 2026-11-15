// Request-head limits of createService over real sockets: legacy's limit at the gateway, headroom for forwarded heads elsewhere.
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_REQUEST_HEAD_LIMIT_BYTES } from '../../src/legacy-compat/index.js';
import { createLogger } from '../../src/logging/index.js';
import { SERVICE_MAX_HEADER_SIZE, baseEnvSchema, createService, loadEnv, type FastifyInstance } from '../../src/service-kit/index.js';
import { testVerifier } from '../../src/testing/index.js';

/** Legacy's whole answer to a head over its limit, as measured on the oracle. */
const LEGACY_BARE_400 = 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const FASTIFY_CLIENT_ERROR_BODY = '{"error":"Bad Request","message":"Client Error","statusCode":400}';
/** Fastify's answer to a malformed head, which createService keeps. */
const FASTIFY_CLIENT_ERROR = `HTTP/1.1 400 Bad Request\r\nContent-Length: ${String(FASTIFY_CLIENT_ERROR_BODY.length)}\r\nContent-Type: application/json\r\n\r\n${FASTIFY_CLIENT_ERROR_BODY}`;

const env = loadEnv(baseEnvSchema, {
  PORT: '26112',
  OPT2_SERVICE_NAME: 'people',
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
  OPT2_TOKEN_ISSUER: 'opt2-local-identity',
  OPT2_TOKEN_AUDIENCE: 'opt2-local',
  OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-service-kit-head-limit-state'),
  TZ: 'UTC',
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A listening service whose `/head?h=<name>` answers the byte length of header `<name>`; returns its port. */
async function listening(maxHeaderSize: number | undefined): Promise<number> {
  const app = await createService({
    name: 'people',
    version: '1.0.0',
    env,
    verifierOverride: testVerifier('people'),
    logger: createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    ...(maxHeaderSize === undefined ? {} : { maxHeaderSize }),
  });
  apps.push(app);
  app.get<{ Querystring: { h: string } }>('/head', { config: { opt2: { public: true } } }, async (request) => ({
    length: Buffer.byteLength(String(request.headers[request.query.h])),
  }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

/** A `Connection: close` GET head of `total` bytes, the header `name` padded to fill it; its value's length. */
function paddedHead(name: string, total: number, prefix = ''): { head: string; valueLength: number } {
  const lines = (value: string): string =>
    `GET /head?h=${name.toLowerCase()} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${name}: ${value}\r\n\r\n`;
  const valueLength = total - lines('').length;
  return { head: lines(prefix + 'a'.repeat(valueLength - prefix.length)), valueLength };
}

/** Writes `head` to `port` and resolves to every byte answered once the server closes the connection. */
function exchange(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answered = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(head, 'latin1'));
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      answered += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(answered));
  });
}

const GATEWAY = LEGACY_REQUEST_HEAD_LIMIT_BYTES;

describe('createService request-head limit', () => {
  it.each([
    { label: 'a 17 KB header', limit: GATEWAY, name: 'X-Big', total: 17_000, prefix: '' },
    { label: 'a 60 KB header', limit: GATEWAY, name: 'X-Big', total: 60_000, prefix: '' },
    { label: 'a 12 KB CFID/CFTOKEN cookie', limit: GATEWAY, name: 'Cookie', total: 12_288, prefix: 'CFID=4017; CFTOKEN=' },
    { label: "a head of legacy's largest accepted size", limit: GATEWAY, name: 'X-Big', total: LEGACY_REQUEST_HEAD_LIMIT_BYTES, prefix: '' },
    { label: 'a legacy-size head plus forwarding headers, by default', limit: undefined, name: 'X-Big', total: GATEWAY + 4096, prefix: '' },
  ])('accepts $label', async ({ limit, name, total, prefix }) => {
    const port = await listening(limit);
    const { head, valueLength } = paddedHead(name, total, prefix);
    expect(head).toHaveLength(total);

    const answered = await exchange(port, head);

    expect(answered.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(answered.endsWith(`\r\n\r\n{"length":${String(valueLength)}}`)).toBe(true);
  });

  it.each([
    { label: "the gateway's legacy limit", limit: GATEWAY, total: GATEWAY + 1024 },
    { label: 'the default service limit', limit: undefined, total: SERVICE_MAX_HEADER_SIZE + 1024 },
  ])('answers a head over $label with legacy bare 400 only, then closes', async ({ limit, total }) => {
    const port = await listening(limit);

    const answered = await exchange(port, paddedHead('X-Big', total).head);

    expect(answered).toBe(LEGACY_BARE_400);
  });

  it("keeps Fastify's answer to a malformed head", async () => {
    const port = await listening(GATEWAY);

    const answered = await exchange(port, 'GET /head?h=host HTTP/1.1\r\nHost: localhost\r\nNot a header\r\n\r\n');

    expect(answered).toBe(FASTIFY_CLIENT_ERROR);
  });
});
