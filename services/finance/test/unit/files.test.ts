// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Local signed-URL route serving `finance-attachments` objects. */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { recordedRoutes } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, signLocalUrl, type LocalStorageAdapter } from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, testVerifier } from '@opt2/platform/testing';
import { ATTACHMENT_BUCKET, attachmentObjectKey } from '../../src/repo/tables.js';
import { registerAttachmentFileRoute } from '../../src/routes/files.js';

const NOW = Date.parse('2026-06-30T12:00:00Z');
const HMAC_KEY = 'finance-files-test-hmac-key';
const ATTACHMENT_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x0d, 0x7f, 0x80]);
const KEY_A = attachmentObjectKey(TENANT_A.tenantId, ATTACHMENT_ID, 'scan.PDF');
const FORBIDDEN = {
  apiversion: 'v1',
  method: 'invalid',
  error: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
};

let stateDir: string;
let storage: LocalStorageAdapter;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-finance-files-'));
  storage = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => NOW });
  await storage.put(ATTACHMENT_BUCKET, KEY_A, BYTES, { contentType: 'application/pdf' });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A finance service app carrying only the attachment file route, verifying at `NOW`. */
async function fileRouteApp(port: LocalStorageAdapter = storage): Promise<FastifyInstance> {
  const app = await createService({
    name: 'finance',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8119',
      OPT2_SERVICE_NAME: 'finance',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('finance'),
    logger: createLogger({ service: 'finance', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  registerAttachmentFileRoute(app, { storage: port, clock: fixedClock(NOW) });
  await app.ready();
  return app;
}

describe('finance attachment file route', () => {
  it('declares the route public on the service transport', async () => {
    const app = await fileRouteApp();
    expect(recordedRoutes(app).find((route) => route.method === 'GET' && route.url.startsWith('/opt2/files/'))).toEqual({
      method: 'GET',
      url: '/opt2/files/finance-attachments/:tenantId/:objectName',
      config: { public: true, transport: 'service' },
    });
  });

  it('streams the stored bytes under the stored content type and length', async () => {
    const app = await fileRouteApp();
    const res = await app.inject({ method: 'GET', url: await storage.signedUrl(ATTACHMENT_BUCKET, KEY_A) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(BYTES.length));
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['generator']).toBe('Masa CMS 7.6.1');
  });

  it('streams an empty object with a zero length', async () => {
    const key = attachmentObjectKey(TENANT_A.tenantId, 'ABCDEF01-2345-6789-ABCDEF0123456780', 'empty.txt');
    await storage.put(ATTACHMENT_BUCKET, key, Buffer.alloc(0), { contentType: 'text/plain' });
    const app = await fileRouteApp();
    const res = await app.inject({ method: 'GET', url: await storage.signedUrl(ATTACHMENT_BUCKET, key) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['content-length']).toBe('0');
    expect(res.rawPayload.length).toBe(0);
  });

  it('sends a signed non-ASCII disposition as its UTF-8 bytes on the wire', async () => {
    const disposition = 'attachment; filename="Résumé €.pdf"';
    const app = await fileRouteApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const url = await storage.signedUrl(ATTACHMENT_BUCKET, KEY_A, { disposition });
    const { rawHeaders, body } = await new Promise<{ rawHeaders: string[]; body: Buffer }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}${url}`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });
    const at = rawHeaders.findIndex((name) => name.toLowerCase() === 'content-disposition');
    expect(Buffer.from(rawHeaders[at + 1] ?? '', 'latin1').toString('utf8')).toBe(disposition);
    expect(body.equals(BYTES)).toBe(true);
  });

  it.each<[string, () => Promise<string> | string]>([
    [
      'whose sig was tampered',
      async () =>
        (await storage.signedUrl(ATTACHMENT_BUCKET, KEY_A)).replace(/sig=(.)/, (_m, c: string) => `sig=${c === '0' ? '1' : '0'}`),
    ],
    ['that has expired', () => signLocalUrl({ bucket: ATTACHMENT_BUCKET, key: KEY_A, expires: NOW / 1000 - 1 }, Buffer.from(HMAC_KEY))],
    [
      'signed for another bucket',
      async () => (await storage.signedUrl('reporting-exports', KEY_A)).replace('/reporting-exports/', `/${ATTACHMENT_BUCKET}/`),
    ],
    [
      "signed for another tenant's key",
      async () =>
        (await storage.signedUrl(ATTACHMENT_BUCKET, attachmentObjectKey(TENANT_B.tenantId, ATTACHMENT_ID, 'scan.pdf'))).replace(
          TENANT_B.tenantId,
          TENANT_A.tenantId,
        ),
    ],
  ])('answers the legacy 403 to a URL %s', async (_case, urlFor) => {
    const app = await fileRouteApp();
    const res = await app.inject({ method: 'GET', url: await urlFor() });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual(FORBIDDEN);
  });

  it('answers the legacy 404 to a valid URL whose object was deleted', async () => {
    const key = attachmentObjectKey(TENANT_A.tenantId, 'ABCDEF01-2345-6789-ABCDEF0123456781', 'gone.pdf');
    await storage.put(ATTACHMENT_BUCKET, key, BYTES, { contentType: 'application/pdf' });
    const url = await storage.signedUrl(ATTACHMENT_BUCKET, key);
    await storage.delete(ATTACHMENT_BUCKET, key);
    const app = await fileRouteApp();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });

  it('answers the legacy 500 when the object cannot be read', async () => {
    const failing: LocalStorageAdapter = { ...storage, open: () => Promise.reject(new Error('disk failure')) };
    const app = await fileRouteApp(failing);
    const res = await app.inject({ method: 'GET', url: await storage.signedUrl(ATTACHMENT_BUCKET, KEY_A) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error', message: 'Unhandled Exception' } });
  });
});
