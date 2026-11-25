/** `lookupContentLinks` over a throwaway `content` schema: registry tenancy, active-version reads, legacy link forms under the `MURA_<KEY>` URL settings, auth and body validation. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { EnvValidationError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  loadOpenApiDocument,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { UNIT_OF } from '../../src/repo/tables.js';
import {
  contentLinkUrlSettings,
  lookupContentLinks,
  registerContentLinksRoutes,
  type MasaEnv,
} from '../../src/routes/internal-content-links.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as {
  paths: Partial<Record<string, Partial<Record<string, ContractOperation>>>>;
};
const SERVICE = 'strategies-content';
const LINKS_URL = '/internal/v1/content:links';
const HOME = '00000000000000000000000000000000001';
const PAGE = 'C0A1B2C3-0001-4A5B-8C7D9E0F1A2B3C4D';
const NESTED = 'C0A1B2C3-0002-4A5B-8C7D9E0F1A2B3C4D';
const DRAFT_ONLY = 'C0A1B2C3-0003-4A5B-8C7D9E0F1A2B3C4D';
const OTHER_SITE = 'C0A1B2C3-0004-4A5B-8C7D9E0F1A2B3C4D';
const AMPERSAND = 'C0A1B2C3-0005-4A5B-8C7D9E0F1A2B3C4D';
const SHORT_ID = 'SHORT-CONTENT';
/** This deployment's `MURA_<KEY>` URL settings, which the app registers with: no site id and no index file in links. */
const DEPLOYMENT_ENV: MasaEnv = { MURA_SITEIDINURLS: 'false', MURA_INDEXFILEINURLS: 'false' };

/** Content versions: `active` 1 is the version contentBean.loadBy reads. */
const VERSIONS: ReadonlyArray<{ tenantId: string; siteId: string; contentId: string; filename: string | null; type: string; active: number }> = [
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, contentId: HOME, filename: null, type: 'Page', active: 1 },
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, contentId: PAGE, filename: 'about', type: 'Page', active: 1 },
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, contentId: PAGE, filename: 'about-old', type: 'Page', active: 0 },
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, contentId: NESTED, filename: 'about/team', type: 'Link', active: 1 },
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, contentId: DRAFT_ONLY, filename: 'draft', type: 'Page', active: 0 },
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, contentId: AMPERSAND, filename: 'q&a', type: 'Page', active: 1 },
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, contentId: SHORT_ID, filename: 'short', type: 'Folder', active: 1 },
  { tenantId: TENANT_B.tenantId, siteId: TENANT_B.siteId, contentId: OTHER_SITE, filename: 'elsewhere', type: 'Page', active: 1 },
];

let handle: ThrowawaySchema | undefined;
let stateDir: string | undefined;
let app: FastifyInstance | undefined;
let schemaDb: TenantDb | undefined;

/** The app `beforeAll` built. */
function builtApp(): FastifyInstance {
  if (app === undefined) throw new Error('the content links app was not built');
  return app;
}

/** The database `beforeAll` seeded. */
function seededDb(): TenantDb {
  if (schemaDb === undefined) throw new Error('the content links schema was not seeded');
  return schemaDb;
}

/** The invocation credential of `caller`, without a user token, as people's favorites call sends it. */
async function callerHeaders(caller = 'people'): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE })}` };
}

/** Posts `payload` to the lookup and checks the answer against the contract. */
async function links(headers: Record<string, string>, payload: string | Record<string, unknown>) {
  const res = await builtApp().inject({ method: 'POST', url: LINKS_URL, headers, payload });
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'POST',
    path: LINKS_URL,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

describe.skipIf(!(await pgAvailable()))('lookupContentLinks', () => {
  beforeAll(async () => {
    const schema = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    handle = schema;
    await seedRegistry(schema.app);
    await ensureUnitGates(schema.app, [UNIT_OF.content, UNIT_OF.file, UNIT_OF.approval_request]);
    for (const version of VERSIONS) {
      await schema.app.withTenant(version.tenantId, (tx) =>
        tx.query(
          `INSERT INTO ${schema.schema}.content (tenant_id, contentid, contenthistid, siteid, filename, type, active, approved)` +
            ' VALUES ($1, $2, $3, $4, $5, $6, $7, 1)',
          [tx.tenantId, version.contentId, `H${String(version.active)}${version.contentId.slice(2)}`, version.siteId, version.filename, version.type, version.active],
        ),
      );
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-content-links-'));
    stateDir = dir;
    await writeTestSecrets(dir);
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: schema.app.schema,
      withTenant: (tenantId, fn) => schema.app.withTenant(tenantId, fn),
      withMetadata: (fn) => schema.app.withMetadata(fn),
      end: () => Promise.resolve(),
    };
    schemaDb = db;
    const service = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: dir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    app = service;
    registerContentLinksRoutes(service, { db, env: DEPLOYMENT_ENV });
    await service.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares the contract operation', () => {
    const operation = OPENAPI.paths[LINKS_URL]?.post ?? {};
    const declared = collectRouteMatrix(builtApp()).routes.filter((route) => route.url.startsWith('/internal/v1/content'));
    expect(declared).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: operation['x-opt2-fastify-path'],
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
      }),
    ]);
  });

  it.each([
    ['the home page, whose filename is NULL, at the site root', HOME, '/'],
    ['a page by its active version’s filename', PAGE, '/about/'],
    ['a nested Link by its filename, as for a Page', NESTED, '/about/team/'],
    ['an id with only an inactive version at the root', DRAFT_ONLY, '/'],
    ['another site’s content at the root', OTHER_SITE, '/'],
    ['an id that names no content at the root', 'NO-SUCH-CONTENT', '/'],
    ['an id longer than a content id at the root', `${PAGE}X`, '/'],
    ['a filename HTML-edit-formatted', AMPERSAND, '/q&amp;a/'],
    ['a lower-case id, echoed as listed', PAGE.toLowerCase(), '/about/'],
    ['a short id in another case with trailing spaces', `${SHORT_ID.toLowerCase()}  `, '/short/'],
  ])('links %s', async (_label, contentId, href) => {
    const res = await links(await callerHeaders(), { siteId: TENANT_A.siteId, contentIds: [contentId] });
    expect({ status: res.statusCode, body: res.json<unknown>() }).toEqual({ status: 200, body: { items: [{ contentId, href }] } });
  });

  it('answers several ids in listed order, the site id matched in any case', async () => {
    const res = await links(await callerHeaders(), { siteId: TENANT_A.siteId.toUpperCase(), contentIds: [PAGE, HOME, NESTED] });
    expect(res.json()).toEqual({
      items: [
        { contentId: PAGE, href: '/about/' },
        { contentId: HOME, href: '/' },
        { contentId: NESTED, href: '/about/team/' },
      ],
    });
  });

  it.each<[string, MasaEnv, string, string]>([
    ['unset, at the settings template’s values', {}, '/', '/index.cfm/about/'],
    ['of this deployment, without site id or index file', DEPLOYMENT_ENV, '/', '/about/'],
    [
      'with context /cms/ and both flags on',
      { MURA_CONTEXT: '/cms/', MURA_SITEIDINURLS: 'true', MURA_INDEXFILEINURLS: 'yes' },
      `/cms/index.cfm/${TENANT_A.siteId}/`,
      `/cms/index.cfm/${TENANT_A.siteId}/about/`,
    ],
    ['with numeric flags, the site id without the index file', { MURA_SITEIDINURLS: '1', MURA_INDEXFILEINURLS: '0' }, `/${TENANT_A.siteId}/`, `/${TENANT_A.siteId}/about/`],
    ['with hash URLs', { ...DEPLOYMENT_ENV, MURA_HASHURLS: 'true' }, '/', '/#/about'],
    [
      'with non-boolean flags, at configBean’s defaults',
      { MURA_SITEIDINURLS: 'maybe', MURA_INDEXFILEINURLS: '', MURA_HASHURLS: 'on' },
      `/index.cfm/${TENANT_A.siteId}/`,
      `/index.cfm/${TENANT_A.siteId}/about/`,
    ],
    ['with an expression context, read as unset', { ...DEPLOYMENT_ENV, MURA_CONTEXT: '${cgi.context_path}' }, '/', '/about/'],
    [
      'with the legacy index file location under MURA_SITEDIR',
      { MURA_SITEIDINURLS: 'true', MURA_LEGACYINDEXFILELOCATION: 'true', MURA_SITEDIR: 'content' },
      `/content/${TENANT_A.siteId}/`,
      `/content/${TENANT_A.siteId}/index.cfm/about/`,
    ],
  ])('links the home page and a page under MURA_<KEY> URL settings %s', async (_label, env, home, page) => {
    const items = await lookupContentLinks(seededDb(), contentLinkUrlSettings(env), TENANT_A.siteId, [HOME, PAGE]);
    expect(items).toEqual([
      { contentId: HOME, href: home },
      { contentId: PAGE, href: page },
    ]);
  });

  it('refuses a malformed MURA_CONTEXT at registration', () => {
    expect(() => {
      registerContentLinksRoutes(builtApp(), { db: seededDb(), env: { MURA_CONTEXT: 'cms' } });
    }).toThrow(EnvValidationError);
  });

  it('reads the content of the requested site’s own tenant only', async () => {
    const res = await links(await callerHeaders(), { siteId: TENANT_B.siteId, contentIds: [OTHER_SITE, PAGE] });
    expect(res.json()).toEqual({
      items: [
        { contentId: OTHER_SITE, href: '/elsewhere/' },
        { contentId: PAGE, href: '/' },
      ],
    });
  });

  it('answers the legacy 503 for a site the registry does not hold', async () => {
    const res = await links(await callerHeaders(), { siteId: 'unregistered-site', contentIds: [HOME] });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });

  it.each([
    ['no credential', () => Promise.resolve({}), 401],
    ['another service', () => callerHeaders('identity'), 403],
    [
      'a browser user through the gateway',
      async () => ({
        authorization: `Bearer ${await mintUserToken({ sub: PAGE, site: TENANT_A.siteId, roles: [Roles.s2] })}`,
        [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
      }),
      403,
    ],
  ])('denies a call with %s', async (_label, headers, status) => {
    const res = await links(await headers(), { siteId: TENANT_A.siteId, contentIds: [HOME] });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each<[string, string | Record<string, unknown>]>([
    ['no contentIds', { siteId: TENANT_A.siteId }],
    ['an empty list', { siteId: TENANT_A.siteId, contentIds: [] }],
    ['a repeated id', { siteId: TENANT_A.siteId, contentIds: [HOME, HOME] }],
    ['an empty id', { siteId: TENANT_A.siteId, contentIds: [''] }],
    ['an id over 1000 characters', { siteId: TENANT_A.siteId, contentIds: ['x'.repeat(1001)] }],
    ['an empty site', { siteId: '', contentIds: [HOME] }],
    ['a site over 25 characters', { siteId: 's'.repeat(26), contentIds: [HOME] }],
    ['an unknown member', { siteId: TENANT_A.siteId, contentIds: [HOME], tenantId: TENANT_B.tenantId }],
    ['a non-JSON body', '{"siteId":'],
  ])('rejects %s with the legacy 400', async (_label, payload) => {
    const headers = { ...(await callerHeaders()), ...(typeof payload === 'string' ? { 'content-type': 'application/json' } : {}) };
    const res = await links(headers, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});


describe('contentLinkUrlSettings', () => {
  it('takes the settings template’s values when no MURA_<KEY> is set', () => {
    expect(contentLinkUrlSettings({})).toEqual({
      context: '',
      siteIdInUrls: false,
      indexFileInUrls: true,
      hashUrls: false,
      legacyIndexFileLocation: false,
      siteAssetPath: '/sites',
    });
  });

  it.each([
    [{ MURA_LEGACYINDEXFILELOCATION: 'yes' }, { legacyIndexFileLocation: true, siteAssetPath: '/sites' }],
    [{ MURA_LEGACYINDEXFILELOCATION: '${legacy}', MURA_SITEDIR: '' }, { legacyIndexFileLocation: false, siteAssetPath: '' }],
    [{ MURA_SITEDIR: '{{siteDir}}' }, { legacyIndexFileLocation: false, siteAssetPath: '/sites' }],
  ])('reads the legacy index file location and site directory of %j', (env, expected) => {
    expect(contentLinkUrlSettings(env)).toMatchObject(expected);
  });

  it.each([
    ['/cms/', '/cms'],
    ['\\cms\\', '\\cms'],
    ['/shop/cms', '/shop/cms'],
    ['/', ''],
    ['  ', ''],
    ['${cgi.context_path}', ''],
    ['{{contextPath}}', ''],
  ])('reads MURA_CONTEXT %j as the context %j', (value, context) => {
    expect(contentLinkUrlSettings({ MURA_CONTEXT: value }).context).toBe(context);
  });

  it.each([
    ['MURA_CONTEXT', 'cms'],
    ['MURA_CONTEXT', '/c ms'],
    ['MURA_CONTEXT', 'http://host/cms'],
    ['MURA_CONTEXT', '/cms?x=1'],
    ['MURA_CONTEXT', '/cms#top'],
    ['MURA_LEGACYINDEXFILELOCATION', 'maybe'],
    ['MURA_LEGACYINDEXFILELOCATION', ''],
  ])('throws EnvValidationError naming %s for %j', (key, value) => {
    expect(() => contentLinkUrlSettings({ [key]: value })).toThrow(
      expect.objectContaining({ name: 'EnvValidationError', issues: [expect.stringMatching(new RegExp(`^${key}: `))] }),
    );
  });
});
