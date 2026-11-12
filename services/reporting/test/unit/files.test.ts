// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Local signed-URL route serving `reporting-exports` objects. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { recordedRoutes } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, signLocalUrl, type LocalStorageAdapter } from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, testVerifier } from '@opt2/platform/testing';
import { EXPORT_BUCKET, exportAttemptKey, exportObjectKey } from '../../src/repo/tables.js';
import { registerExportFileRoute } from '../../src/routes/files.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const NOW = Date.parse('2026-06-30T12:00:00Z');
const HMAC_KEY = 'reporting-files-test-hmac-key';
const JOB_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const BYTES = Buffer.from('id,name\r\n1,"Ada, \u00e9"\r\n\u0000\u00ff', 'utf8');
const KEY_A = exportObjectKey(TENANT_A.tenantId, JOB_ID, 'csv');
const KEY_A_SLOT = exportObjectKey(TENANT_A.tenantId, JOB_ID, 'xlsx', 'b');
const KEY_A_ATTEMPT = exportAttemptKey(TENANT_A.tenantId, JOB_ID, 'pdf', '12');
const OBJECT_NAME = new RegExp(
  (OPENAPI as { paths: Record<string, { parameters: { name: string; schema: { pattern: string } }[] }> }).paths[
    '/opt2/files/reporting-exports/{tenantId}/{objectName}'
  ]?.parameters.find((parameter) => parameter.name === 'objectName')?.schema.pattern ?? '^$',
);
const FORBIDDEN = {
  apiversion: 'v1',
  method: 'invalid',
  error: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
};

let stateDir: string;
let storage: LocalStorageAdapter;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-files-'));
  storage = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => NOW });
  await storage.put(EXPORT_BUCKET, KEY_A, BYTES, { contentType: 'text/csv;charset=utf-8' });
  await storage.put(EXPORT_BUCKET, KEY_A_SLOT, BYTES, { contentType: 'text/csv;charset=utf-8' });
  await storage.put(EXPORT_BUCKET, KEY_A_ATTEMPT, BYTES, { contentType: 'text/csv;charset=utf-8' });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A reporting service app carrying only the export file route, verifying at `NOW`. */
async function fileRouteApp(port: LocalStorageAdapter = storage): Promise<FastifyInstance> {
  const app = await createService({
    name: 'reporting',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8116',
      OPT2_SERVICE_NAME: 'reporting',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('reporting'),
    logger: createLogger({ service: 'reporting', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  registerExportFileRoute(app, { storage: port, clock: fixedClock(NOW) });
  await app.ready();
  return app;
}

/** Validates an injected response against `downloadExportObject` in the reporting contract. */
function assertContract(url: string, res: { statusCode: number; headers: Record<string, unknown>; payload: string }): void {
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'GET',
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'] as string | undefined,
    body: res.payload,
  });
}

describe('reporting export file route', () => {
  it('declares the route public on the service transport, as the contract annotates it', async () => {
    const app = await fileRouteApp();
    expect(recordedRoutes(app).find((route) => route.method === 'GET' && route.url.startsWith('/opt2/files/'))).toEqual({
      method: 'GET',
      url: '/opt2/files/reporting-exports/:tenantId/:objectName',
      config: { public: true, transport: 'service' },
    });
    const operation = (OPENAPI as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths[
      '/opt2/files/reporting-exports/{tenantId}/{objectName}'
    ]?.get;
    expect(operation).toMatchObject({ operationId: 'downloadExportObject', 'x-opt2-public': true, 'x-opt2-transport': 'service' });
  });

  it.each([
    ['a runner key', KEY_A],
    ['an output-slot key', KEY_A_SLOT],
    ['a run attempt key', KEY_A_ATTEMPT],
  ])('streams the stored bytes of %s under the stored content type and length', async (_case, key) => {
    expect(key.split('/')[1]).toMatch(OBJECT_NAME);
    const app = await fileRouteApp();
    const url = await storage.signedUrl(EXPORT_BUCKET, key, { expiresS: 900 });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe('text/csv;charset=utf-8');
    expect(res.headers['content-length']).toBe(String(BYTES.length));
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['generator']).toBe('Masa CMS 7.6.1');
    assertContract(url, res);
  });

  it.each(['0', 'x', '01', 'a.1'])('declares no object name with segment %s between the job id and the extension', (segment) => {
    expect(`${JOB_ID}.${segment}.csv`).not.toMatch(OBJECT_NAME);
  });

  it('streams an empty object with a zero length', async () => {
    const key = exportObjectKey(TENANT_A.tenantId, 'ABCDEF01-2345-6789-ABCDEF0123456780', 'pdf');
    await storage.put(EXPORT_BUCKET, key, Buffer.alloc(0), { contentType: 'application/pdf' });
    const app = await fileRouteApp();
    const res = await app.inject({ method: 'GET', url: await storage.signedUrl(EXPORT_BUCKET, key) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe('0');
    expect(res.rawPayload.length).toBe(0);
  });

  it('sends a signed non-ASCII disposition as its UTF-8 bytes on the wire', async () => {
    const disposition = 'attachment; filename="Übersicht €.csv"';
    const app = await fileRouteApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const url = await storage.signedUrl(EXPORT_BUCKET, KEY_A, { disposition });
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
        (await storage.signedUrl(EXPORT_BUCKET, KEY_A)).replace(/sig=(.)/, (_m, c: string) => `sig=${c === '0' ? '1' : '0'}`),
    ],
    ['that has expired', () => signLocalUrl({ bucket: EXPORT_BUCKET, key: KEY_A, expires: NOW / 1000 - 1 }, Buffer.from(HMAC_KEY))],
    [
      'signed for another bucket',
      async () => (await storage.signedUrl('finance-attachments', KEY_A)).replace('/finance-attachments/', `/${EXPORT_BUCKET}/`),
    ],
    [
      "signed for another tenant's key",
      async () =>
        (await storage.signedUrl(EXPORT_BUCKET, exportObjectKey(TENANT_B.tenantId, JOB_ID, 'csv'))).replace(
          TENANT_B.tenantId,
          TENANT_A.tenantId,
        ),
    ],
    [
      'signed for another object name',
      async () => (await storage.signedUrl(EXPORT_BUCKET, exportObjectKey(TENANT_A.tenantId, JOB_ID, 'pdf'))).replace('.pdf?', '.csv?'),
    ],
  ])('answers the legacy 403 to a URL %s', async (_case, urlFor) => {
    const app = await fileRouteApp();
    const url = await urlFor();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual(FORBIDDEN);
    assertContract(url, res);
  });

  it('serves no finance-attachments URL', async () => {
    const app = await fileRouteApp();
    const res = await app.inject({ method: 'GET', url: await storage.signedUrl('finance-attachments', KEY_A) });
    expect(res.statusCode).toBe(404);
  });

  it('answers the legacy 404 to a valid URL whose object was deleted', async () => {
    const key = exportObjectKey(TENANT_A.tenantId, 'ABCDEF01-2345-6789-ABCDEF0123456781', 'xlsx');
    await storage.put(EXPORT_BUCKET, key, BYTES, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = await storage.signedUrl(EXPORT_BUCKET, key);
    await storage.delete(EXPORT_BUCKET, key);
    const app = await fileRouteApp();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    assertContract(url, res);
  });

  it('registers only GET on the file path and answers HEAD to a valid URL with the legacy 404', async () => {
    const app = await fileRouteApp();
    const methods = recordedRoutes(app).filter((route) => route.url.startsWith('/opt2/files/')).map((route) => route.method);
    expect(methods).toEqual(['GET']);
    const res = await app.inject({ method: 'HEAD', url: await storage.signedUrl(EXPORT_BUCKET, KEY_A) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });

  it('answers the legacy 500 when the object cannot be read', async () => {
    const failing: LocalStorageAdapter = { ...storage, open: () => Promise.reject(new Error('disk failure')) };
    const app = await fileRouteApp(failing);
    const res = await app.inject({ method: 'GET', url: await storage.signedUrl(EXPORT_BUCKET, KEY_A) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error', message: 'Unhandled Exception' } });
  });
});
