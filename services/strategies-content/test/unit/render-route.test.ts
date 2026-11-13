/** `/_api/render/*` and `/tasks/render/*`: the request parse against the shared route key, then the routes over a throwaway `content` schema and local storage. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { LEGACY_ERROR_PAGE_HTML, routeKeyForRequest } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  pgAvailable,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type InjectResponse,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import { createContentRepository, type ContentRepository, type FileInput } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { registerRenderRoutes, renderRequestOf, type ParsedRenderRequest, type RenderQuery } from '../../src/routes/render.js';
import { SERVICE, testEnv, userHeaders } from '../helpers/app.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};

const FILE_ID = 'B1C2D3E4-0001-4A5B-8C7D9E0F1A2B3C4D';

describe('renderRequestOf', () => {
  const file = (size: string, method = 'inline', fileId = FILE_ID): ParsedRenderRequest => ({ matched: true, kind: 'file', fileId, method, size });
  const sized = (kind: 'small' | 'medium', size: string = kind): ParsedRenderRequest => ({ matched: true, kind, fileId: FILE_ID, method: 'inline', size });

  it.each<[string, string, RenderQuery, ParsedRenderRequest]>([
    ['the path size', '/_api/render/file/', { fileid: FILE_ID }, file('file')],
    ['a query size over the path', '/_api/render/small/', { fileid: FILE_ID, size: 'medium' }, sized('medium')],
    ['a sized rendition ignoring the method', '/tasks/render/medium', { fileid: FILE_ID, method: 'attachment' }, sized('medium')],
    ['the method of renderFile', '/_api/render/file', { fileid: FILE_ID, method: 'attachment' }, file('file', 'attachment')],
    ['an empty method as inline', '/_api/render/file', { fileid: FILE_ID, method: '' }, file('file')],
    ['an empty query size', '/_api/render/file', { fileid: FILE_ID, size: '' }, file('')],
    ['keys and the size switch without case', '/_api/render/thumb', { FileID: FILE_ID, SIZE: 'Small' }, sized('small', 'Small')],
    ['the endpoint without case', '/_API/Render/file', { fileid: FILE_ID }, file('file')],
    ['empty segments skipped', '/_api/render//small/', { fileid: FILE_ID }, sized('small')],
    ['a repeated fileid joined', '/tasks/render/file', { fileid: [FILE_ID, 'x'] }, file('file', 'inline', `${FILE_ID},x`)],
    ['no fileid', '/_api/render/file', { size: 'small' }, { matched: false }],
    ['another endpoint', '/_api/asset/file', { fileid: FILE_ID }, { matched: false }],
    ['the endpoint without its slash', '/_api/renderfile/x', { fileid: FILE_ID }, { matched: false }],
  ])('reads %s', (_name, requestPath, query, expected) => {
    const parsed = renderRequestOf(requestPath, query);
    expect(parsed).toEqual(expected);
    const key = routeKeyForRequest({ method: 'GET', path: requestPath, query: query as Record<string, string | string[]>, headers: {} });
    expect(key.family === 'render' ? key.key : 'not render').toBe(parsed.matched ? `render:${parsed.kind}` : 'not render');
  });

  it('throws without a third segment, where the route key reads server_error', () => {
    expect(() => renderRequestOf('/_api/render/', { fileid: FILE_ID, size: 'small' })).toThrow(RangeError);
    expect(routeKeyForRequest({ method: 'GET', path: '/_api/render/', query: { fileid: FILE_ID }, headers: {} }).key).toBe('render:!server_error');
  });
});

describe.skipIf(!(await pgAvailable()))('render routes', () => {
  const UMBRELLA = TENANT_UMBRELLA.tenantId;
  const PDF = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
  const PNG = 'C1D2E3F4-0002-4A5B-8C7D9E0F1A2B3C4D';
  const FLV = 'C1D2E3F4-0003-4A5B-8C7D9E0F1A2B3C4D';
  const UNKNOWN = 'C1D2E3F4-0009-4A5B-8C7D9E0F1A2B3C4D';
  const USER_ID = 'D1E2F3A4-0001-4A5B-8C7D9E0F1A2B3C4D';
  const CREATED = new Date('2026-01-02T03:04:05.000Z');
  const HOLDER = 'render-route-test';
  const HTML = 'text/html;charset=UTF-8';
  const OBJECTS: Readonly<Record<string, Buffer>> = {
    [`${PDF}.pdf`]: Buffer.from('%PDF-1.4 brochure'),
    [`${PNG}.png`]: Buffer.from('png original'),
    [`${PNG}_small.png`]: Buffer.from('png small'),
    [`${PNG}_medium.png`]: Buffer.from('png medium'),
    [`${PNG}_thumb.png`]: Buffer.from('png thumb'),
    [`${FLV}.flv`]: Buffer.from('flv video'),
  };

  let handle: ThrowawaySchema;
  let repo: ContentRepository;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let app: FastifyInstance;

  const bytesOf = (name: string): Buffer => OBJECTS[name] ?? Buffer.alloc(0);

  /** Inserts a pooled `content.file` row of `fileId` in the umbrella tenant, the file pool of tenant-a. */
  function insertFile(fileId: string, row: Omit<FileInput, 'fileid' | 'siteid' | 'created'>): Promise<unknown> {
    return withGatedTenant(handle.app, UMBRELLA, (tx) =>
      repo.files.insertFile(tx, { fileid: fileId, siteid: TENANT_UMBRELLA.siteId, created: CREATED, ...row }),
    );
  }

  /** Sends `url` and checks the answer against the contract operation it reaches. */
  async function call(url: string, headers: Record<string, string> = {}): Promise<InjectResponse> {
    const res = await app.inject({ method: 'GET', url, headers });
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path: (url.split('?')[0] ?? url).replace(/\/$/, ''),
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  const tenantA = (): Promise<Record<string, string>> => userHeaders({ sub: USER_ID, site: TENANT_A.siteId, roles: [] });

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, state: 'open' });
    await seedRegistry(handle.app);
    const clock = fixedClock(new Date('2026-06-30T12:00:00.000Z'));
    repo = createContentRepository({ clock, schema: handle.schema });
    await insertFile(PDF, { filename: 'brochure.pdf', fileext: 'pdf', contenttype: 'application', contentsubtype: 'pdf' });
    await insertFile(PNG, { filename: 'logo.png', fileext: 'png', contenttype: 'image', contentsubtype: 'png' });
    await insertFile(FLV, { filename: 'clip.flv', fileext: 'flv', contenttype: 'video', contentsubtype: 'x-flv' });

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-render-'));
    await writeTestSecrets(stateDir);
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'render-route-test-key' });
    for (const [name, bytes] of Object.entries(OBJECTS)) {
      await storage.put(CONTENT_FILES_BUCKET, `${UMBRELLA}/${name}`, bytes, { contentType: 'application/octet-stream' });
    }

    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, testEnv(stateDir)),
      clock,
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerRenderRoutes(app, { domain: { db, repository: repo }, storage });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares both contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.includes('/render/'));
    expect(declared).toEqual(
      ['/_api/render/{size}', '/tasks/render/{size}'].map((template) => {
        const operation = OPENAPI.paths[template]?.['get'] ?? {};
        return expect.objectContaining({
          method: 'GET',
          url: template.replace('{size}', ':size'),
          transport: operation['x-opt2-transport'],
          public: operation['x-opt2-public'],
        });
      }),
    );
  });

  it('streams the stored bytes with the legacy file headers', async () => {
    const res = await call(`/_api/render/file/?fileid=${PDF}`, await tenantA());
    const httpTime = CREATED.toUTCString();
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(bytesOf(`${PDF}.pdf`));
    expect(res.headers).toMatchObject({
      'content-type': 'application/pdf; charset=UTF-8',
      'content-disposition': 'inline;filename="brochure.pdf"',
      'content-length': String(bytesOf(`${PDF}.pdf`).length),
      'last-modified': [httpTime, httpTime],
      generator: 'Masa CMS 7.6.1',
    });
  });

  it.each<[string, string, string, string]>([
    ['the requested method of renderFile', `/_api/render/file/?fileid=${PDF}&method=attachment`, 'attachment;filename="brochure.pdf"', `${PDF}.pdf`],
    ['a video as an attachment', `/_api/render/file?fileid=${FLV}`, 'attachment;filename="clip.flv"', `${FLV}.flv`],
    ['a small rendition inline whatever the method', `/tasks/render/small/?fileid=${PNG}&method=attachment`, 'inline;filename="logo.png"', `${PNG}_small.png`],
    ['the query size over the path', `/_api/render/small/?fileid=${PNG}&size=medium`, 'inline;filename="logo.png"', `${PNG}_medium.png`],
    ['a stored custom size', `/tasks/render/thumb?fileid=${PNG}`, 'inline;filename="logo.png"', `${PNG}_thumb.png`],
  ])('serves %s', async (_name, url, disposition, object) => {
    const res = await call(url, await tenantA());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(disposition);
    expect(res.rawPayload).toEqual(bytesOf(object));
  });

  it('answers 200 with the bytes to an If-Modified-Since after the file date, as ACF 2023 never exposes it', async () => {
    const res = await call(`/_api/render/file/?fileid=${PDF}`, { ...(await tenantA()), 'if-modified-since': 'Fri, 01 Jan 2027 00:00:00 GMT' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(bytesOf(`${PDF}.pdf`));
  });

  it.each<[string, string, boolean]>([
    ['a non-UUID fileid', '/_api/render/file/?fileid=not-a-uuid', false],
    ['a dotted size', `/_api/render/file/?fileid=${PDF}&size=a.b`, false],
    ['an unknown file', `/tasks/render/file/?fileid=${UNKNOWN}`, true],
  ])('answers %s with the legacy 404', async (_name, url, credentials) => {
    const res = await call(url, credentials ? await tenantA() : {});
    expect([res.statusCode, res.statusMessage, res.headers['content-type'], res.body]).toEqual([404, 'Content Not Found', HTML, '']);
  });

  it('does not find a file outside the token site file pool', async () => {
    const headers = await userHeaders({ sub: USER_ID, site: TENANT_B.siteId, roles: [] });
    expect((await call(`/_api/render/file/?fileid=${PDF}`, headers)).statusCode).toBe(404);
  });

  it('answers a request without fileid with legacy empty page', async () => {
    const res = await call('/_api/render/file/');
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, HTML, '']);
  });

  it('refuses a valid file request without a user token', async () => {
    expect((await call(`/_api/render/file/?fileid=${PDF}`)).statusCode).toBe(401);
  });

  it('fails closed for a custom-size image rendition that was never stored', async () => {
    const res = await call(`/_api/render/file/?fileid=${PNG}`, await tenantA());
    expect(res.statusCode).toBe(503);
  });

  it('answers the legacy error page when the stored object is absent', async () => {
    const res = await call(`/_api/render/small/?fileid=${PDF}`, await tenantA());
    expect([res.statusCode, res.statusMessage, res.headers['content-type'], res.body]).toEqual([500, 'An Error Occurred', HTML, LEGACY_ERROR_PAGE_HTML]);
  });
});
