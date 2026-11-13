/** `/internal/v1/migration/objects` over a throwaway `content` schema and local storage: wire mapping, contract shapes, the read back, 400s and authorisation. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { WRITE_POSITION_HEADER_LC, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { registerMigrationObjectRoutes } from '../../src/routes/migration-objects.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const SERVICE = 'strategies-content';
const OBJECTS_URL = '/internal/v1/migration/objects';
const NOW = new Date('2026-06-30T12:00:00.000Z');

const FILE_ID = 'B1C2D3E4-0001-4A5B-8C7D9E0F1A2B3C4D';
const ORPHAN_ID = 'B1C2D3E4-0002-4A5B-8C7D9E0F1A2B3C4D';
const REJECTED_ID = 'B1C2D3E4-0003-4A5B-8C7D9E0F1A2B3C4D';
const ROUND_TRIP_ID = 'B1C2D3E4-0004-4A5B-8C7D9E0F1A2B3C4D';
const BYTES = Buffer.from('legacy png bytes');

let handle: ThrowawaySchema;
let stateDir: string;
let storage: LocalStorageAdapter;
let app: FastifyInstance;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Invocation-credential headers of `caller`, as the service client sends them. */
async function serviceHeaders(caller: string): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE })}` };
}

/** The upload query of `bytes` for `fileId`, with `overrides` applied. */
function putQuery(fileId: string, bytes: Buffer, overrides: Record<string, string> = {}): Record<string, string> {
  return { tenantId: TENANT_A.tenantId, fileId, variant: '', ext: 'PNG', contentType: 'image/png', sha256: sha256(bytes), ...overrides };
}

/** The contract's `pattern` of query parameter `name` of the `method` operation. */
function contractPattern(method: 'get' | 'post', name: string): string {
  const parameters = (OPENAPI.paths[OBJECTS_URL]?.[method]?.['parameters'] ?? []) as { name: string; schema?: { pattern?: string } }[];
  const pattern = parameters.find((parameter) => parameter.name === name)?.schema?.pattern;
  if (pattern === undefined) throw new Error(`the contract declares no pattern for ${method.toUpperCase()} ${OBJECTS_URL} ${name}`);
  return pattern;
}

/** Sends one request and checks the answer against the contract. */
async function call(method: 'GET' | 'POST', query: Record<string, string>, headers: Record<string, string>, payload?: Buffer) {
  const res = await app.inject({
    method,
    url: OBJECTS_URL,
    query,
    headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/octet-stream' },
    ...(payload === undefined ? {} : { payload }),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: OBJECTS_URL, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

describe.skipIf(!(await pgAvailable()))('migration object routes', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.file (tenant_id, fileid, siteid, fileext) VALUES ($1, $2, $3, 'png')`, [
        tx.tenantId,
        FILE_ID,
        TENANT_A.siteId,
      ]),
    );

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-migration-objects-'));
    await writeTestSecrets(stateDir);
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'migration-objects-test-key' });
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    const clock = fixedClock(NOW);
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerWritePositionHeader(app);
    registerMigrationObjectRoutes(app, {
      domain: { db, repository: createContentRepository({ clock, schema: handle.schema }) },
      storage,
      clock,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares both contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url === OBJECTS_URL);
    expect(declared).toEqual(
      ['GET', 'POST'].map((method) => {
        const operation = OPENAPI.paths[OBJECTS_URL]?.[method.toLowerCase()] ?? {};
        return expect.objectContaining({
          method,
          url: OBJECTS_URL,
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
        });
      }),
    );
  });

  it('stores the body under the query key, answers the contract FileObject, then answers a repeat as not created', async () => {
    const headers = await serviceHeaders('migration');
    const key = `${TENANT_A.tenantId}/${FILE_ID}.png`;

    const first = await call('POST', putQuery(FILE_ID, BYTES), headers, BYTES);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ key, size: BYTES.length, sha256: sha256(BYTES), created: true });
    expect(first.headers[WRITE_POSITION_HEADER_LC]).toMatch(/^strategies-content=\d+$/);
    expect(await storage.get(CONTENT_FILES_BUCKET, key)).toEqual(BYTES);

    const repeat = await call('POST', putQuery(FILE_ID, BYTES), headers, BYTES);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ key, size: BYTES.length, sha256: sha256(BYTES), created: false });
  });

  it('stores an object whose file id has no file row, under the tenant the wire names', async () => {
    const bytes = Buffer.from('orphan medium rendition');
    const res = await call('POST', putQuery(ORPHAN_ID, bytes, { tenantId: TENANT_B.tenantId, variant: '_medium', ext: 'jpg' }), await serviceHeaders('migration'), bytes);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: `${TENANT_B.tenantId}/${ORPHAN_ID}_medium.jpg`, created: true });
    const { rows } = await handle.app.withTenant(TENANT_B.tenantId, (tx) =>
      tx.query<{ orphan: boolean }>(`SELECT orphan FROM ${handle.schema}.file_object WHERE object_key = $1`, [`${TENANT_B.tenantId}/${ORPHAN_ID}_medium.jpg`]),
    );
    expect(rows).toEqual([{ orphan: true }]);
  });

  it('stores an empty object', async () => {
    const empty = Buffer.alloc(0);
    const res = await call('POST', putQuery(FILE_ID, empty, { variant: '_small' }), await serviceHeaders('migration'), empty);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ size: 0, sha256: sha256(empty), created: true });
  });

  it.each<[string, Record<string, string>, Buffer | undefined, string]>([
    ['a tenant id that is not a UUID', { tenantId: TENANT_A.siteId }, BYTES, 'Invalid parameters'],
    ['a file id that is not a CF UUID', { fileId: 'not-a-cf-uuid' }, BYTES, 'Invalid parameters'],
    ['a variant that leaves the key directory', { variant: '_x/y' }, BYTES, 'Invalid parameters'],
    ['a variant without its underscore', { variant: 'small' }, BYTES, 'Invalid parameters'],
    ['an empty extension', { ext: '' }, BYTES, 'Invalid parameters'],
    ['an upper-case SHA-256', { sha256: sha256(BYTES).toUpperCase() }, BYTES, 'Invalid parameters'],
    ['an undeclared parameter', { siteId: TENANT_A.siteId }, BYTES, 'Invalid parameters'],
    ['no body', {}, undefined, 'Invalid parameters'],
    ['a body whose SHA-256 differs from the query', { sha256: sha256(Buffer.from('other')) }, BYTES, 'Bad Request'],
  ])('refuses an upload with %s', async (_label, overrides, payload, message) => {
    const res = await call('POST', putQuery(FILE_ID, BYTES, { variant: '_source', ...overrides }), await serviceHeaders('migration'), payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message } });
    expect(await storage.head(CONTENT_FILES_BUCKET, `${TENANT_A.tenantId}/${FILE_ID}_source.png`)).toBeNull();
  });

  it('declares the upload variant and extension grammars as those of the object key', () => {
    const variant = contractPattern('post', 'variant');
    const ext = contractPattern('post', 'ext');
    expect(contractPattern('get', 'key').endsWith(`${variant.slice(1, -1)}\\.${ext.slice(1)}`)).toBe(true);
  });

  it.each(['x-y', 'tar.gz', 'a b', 'é'])('refuses, as the contract does, an upload with the extension %j outside the stored-name grammar', async (ext) => {
    expect(new RegExp(contractPattern('post', 'ext'), 'u').test(ext)).toBe(false);
    const bytes = Buffer.from(`extension ${ext}`);
    const res = await call('POST', putQuery(REJECTED_ID, bytes, { ext }), await serviceHeaders('migration'), bytes);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
    expect(await storage.head(CONTENT_FILES_BUCKET, `${TENANT_A.tenantId}/${REJECTED_ID}.${ext.toLowerCase()}`)).toBeNull();
    const { rows } = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query(`SELECT object_key FROM ${handle.schema}.file_object WHERE object_key LIKE $1`, [`${TENANT_A.tenantId}/${REJECTED_ID}%`]),
    );
    expect(rows).toEqual([]);
  });

  it.each(['PNG', 'jpg', '7z'].flatMap((ext) => ['', '_small', '_W100_H200', '_a.b'].map((variant): [string, string] => [ext, variant])))(
    'reads back by its returned key the object uploaded with extension %j and variant %j',
    async (ext, variant) => {
      expect(new RegExp(contractPattern('post', 'ext'), 'u').test(ext)).toBe(true);
      const headers = await serviceHeaders('migration');
      const bytes = Buffer.from(`round trip ${ext}${variant}`);
      const put = await call('POST', putQuery(ROUND_TRIP_ID, bytes, { variant, ext }), headers, bytes);
      expect(put.statusCode).toBe(200);
      const { key } = put.json<{ key: string }>();
      expect(key).toBe(`${TENANT_A.tenantId}/${ROUND_TRIP_ID}${variant}.${ext.toLowerCase()}`);
      expect(key).toMatch(new RegExp(contractPattern('get', 'key'), 'u'));

      const res = await call('GET', { key }, headers);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(bytes);
    },
  );

  it('reads back the stored bytes of a recorded object as an octet stream', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const headers = await serviceHeaders('migration');
    await call('POST', putQuery(FILE_ID, bytes, { variant: '_W100_H50', ext: 'gif' }), headers, bytes);

    const res = await app.inject({ method: 'GET', url: OBJECTS_URL, query: { key: `${TENANT_A.tenantId}/${FILE_ID}_W100_H50.gif` }, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.rawPayload).toEqual(bytes);
  });

  it.each<[string, () => string]>([
    ['the key names no recorded object', () => `${TENANT_A.tenantId}/${FILE_ID}_none.png`],
    ['the object is recorded in another tenant only', () => `${TENANT_A.tenantId}/${ORPHAN_ID}_medium.jpg`],
  ])('answers the legacy 404 when %s', async (_label, key) => {
    const res = await call('GET', { key: key() }, await serviceHeaders('migration'));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid method call' } });
  });

  it('answers the legacy 404 when the recorded object is missing from storage', async () => {
    const key = `${TENANT_A.tenantId}/${FILE_ID}.png`;
    const bytes = await storage.get(CONTENT_FILES_BUCKET, key);
    await storage.delete(CONTENT_FILES_BUCKET, key);
    try {
      const res = await call('GET', { key }, await serviceHeaders('migration'));
      expect(res.statusCode).toBe(404);
    } finally {
      await storage.put(CONTENT_FILES_BUCKET, key, bytes, { contentType: 'image/png' });
    }
  });

  it.each([['a key without a tenant segment', `${FILE_ID}.png`], ['a key with a dot segment', `${TENANT_A.tenantId}/../${FILE_ID}.png`]])(
    'refuses a read of %s',
    async (_label, key) => {
      const res = await call('GET', { key }, await serviceHeaders('migration'));
      expect(res.statusCode).toBe(400);
    },
  );

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', async () => ({}), 401],
    ['the operator service', () => serviceHeaders('operator'), 403],
    ['another service', () => serviceHeaders('programs-sites'), 403],
    [
      'an S2 user token with gateway invocation',
      async () => ({
        authorization: `Bearer ${await mintUserToken({ sub: 'U1', site: TENANT_A.siteId, s2: true, roles: ['s2'] })}`,
        ...(await serviceHeaders('gateway')),
      }),
      403,
    ],
  ])('refuses both operations to %s before any store', async (label, headersOf, status) => {
    const bytes = Buffer.from(`refused ${label}`);
    const headers = await headersOf();
    const put = await call('POST', putQuery(FILE_ID, bytes, { variant: '_refused' }), headers, bytes);
    const get = await call('GET', { key: `${TENANT_A.tenantId}/${FILE_ID}.png` }, headers);
    expect([put.statusCode, get.statusCode]).toEqual([status, status]);
    expect(await storage.head(CONTENT_FILES_BUCKET, `${TENANT_A.tenantId}/${FILE_ID}_refused.png`)).toBeNull();
  });
});
