/** Request mapping, auth denials, error answers and contract shape of the custom image size routes over a recording ImageSizesDomain. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { GateClosedError } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  mintServiceToken,
  testVerifier,
  writeTestSecrets,
} from '@opt2/platform/testing';
import {
  applyImageSizeSet,
  newImageSizeBean,
  type ImageSizeBean,
  type ImageSizesDomain,
} from '../../src/domain/image-sizes.js';
import { registerImageSizeRoutes } from '../../src/routes/image-sizes.js';

type ContractOperation = Record<string, unknown>;
type Method = 'GET' | 'PUT' | 'DELETE';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const SIZE_PATHS = ['/v1/sites/{siteId}/image-sizes', '/v1/sites/{siteId}/image-sizes/{sizeId}'];
const SIZE_ID = '6A1C9E2B-1D3F-4A5B-8C7D9E0F1A2B3C4D';
const NEW_SIZE_ID = '0B2D4F6A-8C0E-4A1B-9D3F5A7C9E1B3D5F';
const LIST_URL = '/v1/sites/tenant-a/image-sizes';
const SIZE_URL = `${LIST_URL}/${SIZE_ID}`;
const STORED: ImageSizeBean = {
  sizeId: SIZE_ID,
  siteId: 'tenant-a',
  name: 'hero-wide',
  height: '400',
  width: 'AUTO',
  isNew: 0,
};
const STORED_JSON = { sizeID: SIZE_ID, siteID: 'tenant-a', name: 'hero-wide', height: '400', width: 'AUTO', isNew: 0 };
const NEW_BEAN: ImageSizeBean = { sizeId: NEW_SIZE_ID, siteId: '', name: '', height: 'AUTO', width: 'AUTO', isNew: 1 };
const NEW_JSON = { sizeID: NEW_SIZE_ID, siteID: '', name: '', height: 'AUTO', width: 'AUTO', isNew: 1 };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };
const SIZE_BODY = { name: 'hero', height: '400', width: 'AUTO' };
const ROUTES: ReadonlyArray<[Method, string]> = [
  ['GET', LIST_URL],
  ['GET', SIZE_URL],
  ['PUT', SIZE_URL],
  ['DELETE', SIZE_URL],
];

let stateDir: string;
let app: FastifyInstance;
let imageSizes: { [K in keyof ImageSizesDomain]: Mock<ImageSizesDomain[K]> };

const db: TenantDb = {
  schema: 'programs_sites',
  withTenant: () => Promise.reject(new Error('the recording domain runs no SQL')),
  withMetadata: () => Promise.reject(new Error('the recording domain runs no SQL')),
  end: async () => undefined,
};

const tenantAClaims = (sub: string) => expect.objectContaining({ sub, site: 'tenant-a', tid: TENANT_A.tenantId });

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-image-size-routes-'));
  await writeTestSecrets(stateDir);
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  imageSizes = {
    listImageSizes: vi.fn<ImageSizesDomain['listImageSizes']>(async () => [STORED]),
    loadImageSize: vi.fn<ImageSizesDomain['loadImageSize']>(async () => STORED),
    saveImageSize: vi.fn<ImageSizesDomain['saveImageSize']>(async () => STORED),
    deleteImageSize: vi.fn<ImageSizesDomain['deleteImageSize']>(async () => true),
  };
  app = await createService({
    name: 'programs-sites',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8113',
      OPT2_SERVICE_NAME: 'programs-sites',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('programs-sites'),
    pool: db,
    logger: createLogger({
      service: 'programs-sites',
      version: '1.0.0',
      env: 'local',
      destination: { write: () => undefined },
    }),
  });
  await registerImageSizeRoutes(app, { db, imageSizes });
  await app.ready();
});

afterEach(async () => {
  await app.opt2.shutdown();
});

async function headersAs(name: string): Promise<Record<string, string>> {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error(`No role subject ${name}`);
  return authHeadersFor(subject, { audience: 'programs-sites', site: 'tenant-a' });
}

/** Injects a request with `headers` and checks the answer against the contract. */
async function send(
  method: Method,
  url: string,
  headers: Record<string, string>,
  payload?: string | Record<string, unknown>,
) {
  const res = await app.inject({ method, url, headers, payload });
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

function expectNoDomainCall(): void {
  for (const operation of Object.values(imageSizes)) expect(operation).not.toHaveBeenCalled();
}

describe('route declarations', () => {
  it('match the contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter(
      (route) => route.method !== 'HEAD' && route.url.startsWith('/v1/sites/'),
    );
    const expected = SIZE_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: template.replace('{siteId}', ':siteId').replace('{sizeId}', ':sizeId'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
          siteCheck: true,
        })),
    );
    expect(expected).toHaveLength(4);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
    expect(declared).toHaveLength(4);
  });
});

describe('GET /v1/sites/:siteId/image-sizes', () => {
  it.each([
    ['s2', 'tenant-a', [STORED], [STORED_JSON]],
    ['site-admin', 'TENANT-A', [], []],
  ])('answers the domain sizes of the path site for %s on %s', async (as, site, rows, expected) => {
    imageSizes.listImageSizes.mockResolvedValueOnce(rows);
    const res = await send('GET', `/v1/sites/${site}/image-sizes`, await headersAs(as));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expected);
    expect(imageSizes.listImageSizes).toHaveBeenCalledExactlyOnceWith(db, tenantAClaims(`test-${as}`), site);
  });
});

describe('GET /v1/sites/:siteId/image-sizes/:sizeId', () => {
  it.each([
    ['a stored size', STORED, STORED_JSON],
    ['the defaulted new size of an unknown id', NEW_BEAN, NEW_JSON],
  ])('answers %s as loaded by the path size id', async (_label, bean, expected) => {
    imageSizes.loadImageSize.mockResolvedValueOnce(bean);
    const res = await send('GET', SIZE_URL, await headersAs('site-admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expected);
    expect(imageSizes.loadImageSize).toHaveBeenCalledExactlyOnceWith(db, tenantAClaims('test-site-admin'), SIZE_ID);
    expect(imageSizes.listImageSizes).not.toHaveBeenCalled();
  });
});

describe('PUT /v1/sites/:siteId/image-sizes/:sizeId', () => {
  it.each([
    [
      'a JSON body',
      SIZE_URL,
      JSON_BODY,
      { name: 'Hero Wide', height: 400, width: 'AUTO', note: null },
      { name: 'Hero Wide', height: '400', width: 'AUTO', note: '' },
    ],
    [
      'a form body over the query',
      `${SIZE_URL}?height=300&name=fromQuery`,
      FORM,
      'name=Hero&width=AUTO',
      { height: '300', name: 'Hero', width: 'AUTO' },
    ],
    [
      'a posted siteid and sizeid',
      SIZE_URL,
      FORM,
      `siteid=TENANT-A&sizeid=${NEW_SIZE_ID}&name=Hero&height=AUTO&width=120`,
      { siteid: 'TENANT-A', sizeid: NEW_SIZE_ID, name: 'Hero', height: 'AUTO', width: '120' },
    ],
    ['a malformed JSON body, which legacy ignores', SIZE_URL, JSON_BODY, '{"name":', {}],
  ])('saves the merged request values of %s under the path ids, then lists the site', async (_label, url, headers, payload, posted) => {
    const res = await send('PUT', url, { ...(await headersAs('s2')), ...headers }, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([STORED_JSON]);
    const claims = tenantAClaims('test-s2');
    const input = { ...posted, siteId: 'tenant-a', sizeId: SIZE_ID };
    expect(imageSizes.saveImageSize).toHaveBeenCalledExactlyOnceWith(db, claims, input);
    expect(applyImageSizeSet(newImageSizeBean(), imageSizes.saveImageSize.mock.calls[0]?.[2] ?? {})).toMatchObject({
      sizeId: SIZE_ID,
      siteId: 'tenant-a',
    });
    expect(imageSizes.listImageSizes).toHaveBeenCalledExactlyOnceWith(db, claims, 'tenant-a');
    expect(imageSizes.saveImageSize).toHaveBeenCalledBefore(imageSizes.listImageSizes);
  });

  it('denies a posted siteid of another site before any domain operation', async () => {
    const payload = 'siteid=tenant-b&name=Hero&height=AUTO&width=AUTO';
    const res = await send('PUT', SIZE_URL, { ...(await headersAs('s2')), ...FORM }, payload);
    expect(res.statusCode).toBe(403);
    expectNoDomainCall();
  });
});

describe('DELETE /v1/sites/:siteId/image-sizes/:sizeId', () => {
  it.each([true, false])('deletes the path size id and lists the site when the domain answers %s', async (deleted) => {
    imageSizes.deleteImageSize.mockResolvedValueOnce(deleted);
    const res = await send('DELETE', SIZE_URL, await headersAs('site-admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([STORED_JSON]);
    const claims = tenantAClaims('test-site-admin');
    expect(imageSizes.deleteImageSize).toHaveBeenCalledExactlyOnceWith(db, claims, SIZE_ID);
    expect(imageSizes.listImageSizes).toHaveBeenCalledExactlyOnceWith(db, claims, 'tenant-a');
    expect(imageSizes.deleteImageSize).toHaveBeenCalledBefore(imageSizes.listImageSizes);
  });
});

describe('write failures', () => {
  it.each([
    ['PUT', 'saveImageSize', SIZE_BODY],
    ['DELETE', 'deleteImageSize', undefined],
  ] as const)('answer the legacy 503 when %s meets a closed unit gate, listing nothing', async (method, operation, body) => {
    imageSizes[operation].mockRejectedValueOnce(new GateClosedError(['programs-sites.image-sizes']));
    const headers = { ...(await headersAs('s2')), ...(body === undefined ? {} : JSON_BODY) };
    const res = await send(method, SIZE_URL, headers, body);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error' } });
    expect(imageSizes[operation]).toHaveBeenCalledOnce();
    expect(imageSizes.listImageSizes).not.toHaveBeenCalled();
  });
});

describe('auth denials', () => {
  const denials: ReadonlyArray<[string, number]> = [
    ['anonymous', 401],
    ['member', 403],
    ['system-user', 403],
    ['editor', 403],
    ['other-tenant', 403],
    ['service:gateway', 401],
  ];

  it.each(ROUTES.flatMap(([method, url]) => denials.map(([as, status]) => [method, url, as, status] as const)))(
    'deny %s %s to %s with %i before any domain operation',
    async (method, url, as, status) => {
      const headers = { ...(await headersAs(as)), ...(method === 'PUT' ? JSON_BODY : {}) };
      const res = await send(method, url, headers, method === 'PUT' ? SIZE_BODY : undefined);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
      expectNoDomainCall();
    },
  );

  it.each(ROUTES)('answer %s %s with 401 when a service credential carries s2 without a user token', async (method, url) => {
    const token = await mintServiceToken({ caller: 'gateway', audience: 'programs-sites', roles: [Roles.s2] });
    const headers = { [INVOCATION_HEADER]: `Bearer ${token}`, ...(method === 'PUT' ? JSON_BODY : {}) };
    const res = await send(method, url, headers, method === 'PUT' ? SIZE_BODY : undefined);
    expect(res.statusCode).toBe(401);
    expectNoDomainCall();
  });
});
