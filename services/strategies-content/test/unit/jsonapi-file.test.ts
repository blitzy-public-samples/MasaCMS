/** JSON API `file` and `fileMetaData` handlers over a throwaway `content` schema, the seeded registry and local storage. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, isCfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createLocalStorageAdapter, type StoragePort } from '@opt2/platform/storage';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type ContentConfig } from '../../src/domain/context.js';
import { ImageUploadHaltedError, type UploadedFile } from '../../src/domain/files.js';
import { withPoolTenant } from '../../src/domain/pools.js';
import { jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { createContentRepository, type ContentRepository, type FileInput, type FileMetadataInput } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { fileHandler, fileMetaDataHandler } from '../../src/routes/jsonapi/file.js';
import {
  createJsonApiParams,
  rowsSource,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
} from '../../src/routes/jsonapi/types.js';

type Struct = Record<string, unknown>;

const NOW = new Date(2026, 5, 30, 10, 15, 42);
const HOLDER = 'jsonapi-file-test';
const SITE_TREE = '00000000000000000000000000000000000';
const UMBRELLA = TENANT_UMBRELLA.tenantId;
const META_ID = 'D0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const CONTENT_ID = 'C0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const HIST_ID = 'H0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';

/** A CF-format id whose eight-character first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(8 - prefix.length, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

// Keys of the legacy oracle's new-bean answers (findOne of a missing id, findNew; ACF 2023, site default).
const NEW_FILE_KEYS = [
  'alttext', 'cachedwithin', 'caption', 'contentid', 'contentsubtype', 'contenttype', 'created', 'credits', 'deleted', 'entityname',
  'exif', 'fileext', 'filefield', 'fileid', 'filename', 'filesize', 'id', 'isnew', 'links', 'moduleid', 'remoteid', 'remotepubdate',
  'remotesource', 'remotesourceurl', 'remoteurl', 'returnformat', 'siteid',
];
const NEW_META_KEYS = [
  'alttext', 'cachedwithin', 'caption', 'contenthistid', 'contentid', 'contentsubtype', 'contenttype', 'created', 'credits', 'directimages',
  'entityname', 'exif', 'fileext', 'fileid', 'filename', 'filesize', 'id', 'isnew', 'links', 'metaid', 'remoteid', 'remotepubdate',
  'remotesource', 'remotesourceurl', 'remoteurl', 'returnformat', 'siteid',
];
const NEW_BEAN_LINKS = ['all', 'entities', 'permissions', 'properties', 'self', 'site'];

function siteUrls(siteId: string, filePoolId: string): LegacySiteUrlConfig {
  return {
    siteId,
    scheme: 'http',
    domain: 'localhost',
    requestDomain: 'localhost',
    previewDomain: '',
    serverPort: ':8080',
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId,
    configFileAssetPath: '',
    assetPath: '/sites',
    siteAssetPath: '/sites',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  };
}

/** A user of `site` holding `roles`. */
function actorOf(site: { siteId: string; tenantId: string }, roles: readonly string[] = [moduleRole(SITE_TREE)]): Actor {
  return { userId: cfId('U', 1), fullName: 'Ada Admin', isLoggedIn: true, s2: false, roles, siteId: site.siteId, tenantId: site.tenantId };
}

interface CallInput {
  method: string;
  entity?: 'file' | 'fileMetaData';
  actor?: Actor;
  site?: { siteId: string; tenantId: string; filePoolId?: string };
  id?: string;
  ids?: string[];
  params?: Struct;
  url?: Struct;
  files?: UploadedFile[];
  csrf?: boolean;
}

/** A resolved call and the number of CSRF validations it made. */
function callOf(input: CallInput): { call: JsonApiCall; csrfCalls: () => number } {
  const site = input.site ?? TENANT_B;
  const filePoolId = input.site?.filePoolId ?? site.siteId;
  const actor = input.actor ?? actorOf(site);
  const url: Struct = { ...(input.url ?? {}) };
  let validations = 0;
  const urls = siteUrls(site.siteId, filePoolId);
  const apiContext: JsonApiRequestContext = {
    siteId: site.siteId,
    mode: 'json',
    endpoint: jsonApiEndpoint({ adminSSL: false, requestProtocol: 'http', serverName: 'localhost', serverPort: ':8080', context: '', mode: 'json', siteId: site.siteId }),
    url,
    form: {},
    method: input.method,
    isAggregateQuery: false,
    user: { loggedIn: actor.isLoggedIn, systemUser: actor.isLoggedIn },
    allowAction: () => true,
    site: urls,
    customImageSizes: () => Promise.resolve([]),
  };
  const params = createJsonApiParams(Object.entries({ ...url, ...(input.params ?? {}) }));
  const call: JsonApiCall = {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:${(input.entity ?? 'file').toLowerCase()}.${input.method.toLowerCase()}`,
    method: input.method,
    entityName: input.entity ?? 'file',
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.ids === undefined ? {} : { ids: input.ids }),
    pathInfo: [],
    params,
    query: { raw: Object.entries(url).map(([key, value]) => `${key}=${String(value)}`).join('&'), params: createJsonApiParams(Object.entries(url)) },
    siteId: site.siteId,
    tenantId: site.tenantId,
    actor,
    site: {
      siteId: site.siteId,
      site: site.siteId,
      locking: 'None',
      contentApprovalScript: '',
      contentRejectionScript: '',
      contentPendingScript: '',
      contentCanceledScript: '',
      contactEmail: '',
      urls,
    },
    apiContext,
    httpMethod: 'GET',
    headers: {},
    ...(input.files === undefined ? {} : { files: input.files }),
    validateCsrf: () => {
      validations += 1;
      return Promise.resolve(input.csrf ?? true);
    },
  };
  return { call, csrfCalls: () => validations };
}

/** A posted part of `fileName` under `newfile`. */
function part(fileName: string, contentType = 'application/pdf', fieldName = 'newfile'): UploadedFile {
  return { fieldName, fileName, contentType, bytes: Buffer.from(`bytes of ${fileName}`) };
}

/** The handler of `method`, which every file entity handler serves. */
function handlerOf(entity: EntityHandler, method: keyof Omit<EntityHandler, 'entity' | 'config'>): JsonApiHandlerFn {
  const handler = entity[method];
  if (handler === undefined) throw new Error(`${entity.entity} serves no ${method}`);
  return handler;
}

/** The `data` struct of a result. */
function dataOf(result: JsonApiResult): Struct {
  return result.data as Struct;
}

describe.skipIf(!(await pgAvailable()))('routes/jsonapi/file', () => {
  let handle: ThrowawaySchema;
  let repo: ContentRepository;
  let stateDir: string;
  let config: ContentConfig;
  let puts: string[];
  let ctx: ContentRouteContext;

  const gated = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withGatedTenant(handle.app, tenantId, fn);

  /** Inserts a `content.file` row of `fileId` in `tenantId`. */
  function insertFile(tenantId: string, fileId: string, row: Omit<FileInput, 'fileid'>): Promise<unknown> {
    return gated(tenantId, (tx) => repo.files.insertFile(tx, { fileid: fileId, ...row }));
  }

  /** The number of `content.file` rows of `tenantId`. */
  async function fileCount(tenantId: string): Promise<number> {
    return withTenant(handle.app, tenantId, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${handle.schema}.file`)).rows[0]?.n));
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, state: 'open' });
    await seedRegistry(handle.app);
    const clock = fixedClock(NOW);
    repo = createContentRepository({ clock, schema: handle.schema });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-jsonapi-file-'));
    const local = await createLocalStorageAdapter({ stateDir, hmacKey: 'jsonapi-file-test-key' });
    // Records every put, so a refused upload can be shown to store nothing.
    const storage = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === 'put') {
          return (...args: Parameters<StoragePort['put']>) => {
            puts.push(args[1]);
            return target.put(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    config = { ...CONTENT_CONFIG_DEFAULTS };
    // The handlers read only the domain dependencies, storage and the clock.
    ctx = { domain: { db: handle.app, repository: repo, clock, get config() { return config; } }, storage, clock } as unknown as ContentRouteContext;
  });

  beforeEach(() => {
    puts = [];
    config = { ...CONTENT_CONFIG_DEFAULTS };
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  describe('access', () => {
    const denied: [string, Actor][] = [
      ['anonymous', actorFromClaims(undefined, '')],
      ['a member', actorOf(TENANT_B, [Roles.member])],
      ['a system user without Site Manager access', actorOf(TENANT_B, [Roles.systemUser])],
    ];
    const reads: [string, Omit<CallInput, 'actor'>][] = [
      ['findOne', { method: 'findOne', id: cfId('F', 1) }],
      ['findNew', { method: 'findNew' }],
      ['findAll', { method: 'findAll' }],
      ['findQuery', { method: 'findQuery', url: { fileext: 'pdf' } }],
      ['findMany', { method: 'findMany', ids: [cfId('F', 1)] }],
    ];
    const cases = [fileHandler, fileMetaDataHandler].flatMap((entity) =>
      reads.flatMap(([method, input]) => denied.map(([who, actor]) => [entity.entity, method, who, entity, input, actor] as const)),
    );

    it.each(cases)('%s %s by %s answers authorization', async (_entity, method, _who, entity, input, actor) => {
      const { call } = callOf({ ...input, entity: entity.entity as 'file' | 'fileMetaData', actor });
      await expect(handlerOf(entity, method as 'findOne')(ctx, call)).resolves.toEqual({ error: 'authorization' });
    });

    it.each([fileHandler, fileMetaDataHandler])('$entity findPermissions follows the module permission without denying', async (entity) => {
      const anonymous = callOf({ method: 'findPermissions', entity: entity.entity as 'file', id: 'permissions', actor: actorFromClaims(undefined, '') });
      const editor = callOf({ method: 'findPermissions', entity: entity.entity as 'file', id: cfId('F', 1) });
      await expect(handlerOf(entity, 'findPermissions')(ctx, anonymous.call)).resolves.toEqual({
        status: 200,
        data: { read: false, delete: false, save: false },
        serializerEntity: entity.entity,
      });
      expect(dataOf(await handlerOf(entity, 'findPermissions')(ctx, editor.call))).toEqual({ read: true, delete: true, save: true });
    });

    it.each([
      [fileHandler, 'fileid'],
      [fileMetaDataHandler, 'metaid'],
    ] as const)('$entity findProperties answers the registration to anyone', async (entity, primaryKey) => {
      const { call } = callOf({ method: 'findProperties', entity: entity.entity as 'file', actor: actorFromClaims(undefined, '') });
      expect(dataOf(await handlerOf(entity, 'findProperties')(ctx, call))).toMatchObject({ primarykey: primaryKey, public: false, entityname: entity.entity });
    });

    it.each(['findOne', 'findPermissions'] as const)('%s without an id fails as legacy does on an undefined argument', async (method) => {
      const { call } = callOf({ method });
      await expect(handlerOf(fileHandler, method)(ctx, call)).rejects.toMatchObject({ name: 'LegacyApiError', type: 'server_error' });
    });
  });

  describe('reads', () => {
    it.each([
      [fileHandler, 'findOne', NEW_FILE_KEYS],
      [fileHandler, 'findNew', NEW_FILE_KEYS],
      [fileMetaDataHandler, 'findOne', NEW_META_KEYS],
      [fileMetaDataHandler, 'findNew', NEW_META_KEYS],
    ] as const)('$entity %s of no stored row answers the legacy new bean', async (entity, method, keys) => {
      const id = cfId('N', 1);
      const { call } = callOf({ method, entity: entity.entity as 'file', id });
      const result = await handlerOf(entity, method)(ctx, call);
      const data = dataOf(result);
      expect(result).toMatchObject({ status: 200, serializerEntity: entity.entity });
      expect(Object.keys(data).sort()).toEqual(keys);
      expect(Object.keys(data['links'] as Struct).sort()).toEqual(NEW_BEAN_LINKS);
      expect(data).toMatchObject({ isnew: 1, returnformat: 'self', cachedwithin: 0, siteid: TENANT_B.siteId, created: NOW, entityname: entity.entity });
      const key = entity === fileHandler ? 'fileid' : 'metaid';
      expect(data['id']).toBe(data[key]);
      if (method === 'findOne') expect(data['id']).toBe(id);
      else expect(isCfUuid(String(data['id']))).toBe(true);
      if (entity === fileHandler) expect(data).toMatchObject({ filefield: 'newfile', moduleid: SITE_TREE, deleted: 0, filesize: 0 });
      else expect(data).toMatchObject({ directimages: true, filesize: 0, fileid: '' });
    });

    it('reads a pooled site file in the file pool tenant, under the site legacy filters by', async () => {
      await insertFile(UMBRELLA, cfId('P', 1), { siteid: TENANT_A.siteId, filename: 'own.pdf', fileext: 'pdf', caption: '  Spaced  ' });
      await insertFile(UMBRELLA, cfId('P', 2), { siteid: TENANT_UMBRELLA.siteId, filename: 'pool.pdf', fileext: 'pdf' });
      const fromA = (id: string): JsonApiCall => callOf({ method: 'findOne', id, site: { ...TENANT_A, filePoolId: TENANT_UMBRELLA.siteId }, actor: actorOf(TENANT_A) }).call;

      const own = dataOf(await handlerOf(fileHandler, 'findOne')(ctx, fromA(cfId('P', 1))));
      expect(own).toMatchObject({ fileid: cfId('P', 1), isnew: 0, filename: 'own.pdf', caption: 'Spaced', image: '', remotepubdate: '', filefield: 'newfile' });
      expect(own).not.toHaveProperty('tenant_id');
      expect(own).not.toHaveProperty('returnformat');
      // Legacy loads `fileid = ? AND siteid = <request site>`, so a file stored under the pool site is new from tenant-a.
      expect(dataOf(await handlerOf(fileHandler, 'findOne')(ctx, fromA(cfId('P', 2))))).toMatchObject({ isnew: 1, siteid: TENANT_A.siteId });
      const fromPool = callOf({ method: 'findOne', id: cfId('P', 2), site: TENANT_UMBRELLA, actor: actorOf(TENANT_UMBRELLA) }).call;
      expect(dataOf(await handlerOf(fileHandler, 'findOne')(ctx, fromPool))).toMatchObject({ isnew: 0, filename: 'pool.pdf' });
    });

    it.each([
      [fileHandler, 'content'],
      [fileHandler, 'all'],
      [fileMetaDataHandler, 'file'],
    ] as const)('$entity findOne expanding %s fails closed with the legacy 503', async (entity, expand) => {
      const { call } = callOf({ method: 'findOne', entity: entity.entity as 'file', id: cfId('N', 2), url: { expand } });
      await expect(handlerOf(entity, 'findOne')(ctx, call)).rejects.toMatchObject({ name: 'LegacyServiceUnavailableError', reason: 'file-expand-related' });
    });

    it.each([
      ['findOne', 'crumbs'],
      ['findNew', 'site'],
    ] as const)('%s with expand %s expands nothing and answers the bean', async (method, expand) => {
      const { call } = callOf({ method, id: cfId('N', 3), url: { expand } });
      expect(await handlerOf(fileHandler, method)(ctx, call)).toMatchObject({ status: 200 });
    });

    describe('feeds', () => {
      beforeAll(async () => {
        await insertFile(TENANT_B.tenantId, cfId('B', 1), { siteid: TENANT_B.siteId, filename: 'b1.pdf', fileext: 'pdf' });
        await insertFile(TENANT_B.tenantId, cfId('B', 2), { siteid: TENANT_B.siteId, filename: 'b2.docx', fileext: 'docx' });
        await insertFile(TENANT_B.tenantId, cfId('B', 3), { siteid: TENANT_B.siteId, filename: 'b3.pdf', fileext: 'pdf' });
      });

      /** The `fileid`s of a collection answer. */
      const idsOf = (result: JsonApiResult): unknown[] => (dataOf(result)['items'] as Struct[]).map((item) => item['fileid']);

      it('findAll lists the site files by id', async () => {
        const result = await handlerOf(fileHandler, 'findAll')(ctx, callOf({ method: 'findAll' }).call);
        expect(idsOf(result)).toEqual([cfId('B', 1), cfId('B', 2), cfId('B', 3)]);
        expect(dataOf(result)).toMatchObject({ totalItems: 3, entityname: 'file' });
        expect((dataOf(result)['items'] as Struct[])[0]).toMatchObject({ isnew: 0, filename: 'b1.pdf', entityname: 'file', id: cfId('B', 1) });
      });

      it('findQuery filters by the query string', async () => {
        const result = await handlerOf(fileHandler, 'findQuery')(ctx, callOf({ method: 'findQuery', url: { fileext: 'pdf' } }).call);
        expect(idsOf(result)).toEqual([cfId('B', 1), cfId('B', 3)]);
      });

      it.each([
        ['keeps the requested order', {}, [cfId('B', 3), cfId('B', 1)]],
        ['keeps the feed order under a sort', { sort: 'fileid' }, [cfId('B', 1), cfId('B', 3)]],
      ])('findMany %s', async (_name, url, expected) => {
        const { call } = callOf({ method: 'findMany', ids: [cfId('B', 3), cfId('B', 1).toLowerCase()], url });
        expect(idsOf(await handlerOf(fileHandler, 'findMany')(ctx, call))).toEqual(expected);
      });

      it('findAll with fields fills the columns it did not select from the new bean', async () => {
        const result = await handlerOf(fileHandler, 'findAll')(ctx, callOf({ method: 'findAll', url: { fields: 'filename' } }).call);
        expect((dataOf(result)['items'] as Struct[])[0]).toEqual({
          filename: 'b1.pdf',
          fileid: cfId('B', 1),
          siteid: '',
          isnew: 0,
          id: cfId('B', 1),
          entityname: 'file',
        });
      });

      it('findAll expanding the items fails closed with the legacy 503', async () => {
        const { call } = callOf({ method: 'findAll', url: { expand: 'content' } });
        await expect(handlerOf(fileHandler, 'findAll')(ctx, call)).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
      });

      it('findAll answers countOnly with the count', async () => {
        const result = await handlerOf(fileHandler, 'findAll')(ctx, callOf({ method: 'findAll', url: { countOnly: 'true' } }).call);
        expect(dataOf(result)).toEqual({ count: 3 });
      });
    });
  });

  describe('save', () => {
    const save = (input: Omit<CallInput, 'method'>): ReturnType<typeof callOf> => callOf({ method: 'save', ...input });

    it('stores a posted PDF as a new file and answers the reloaded row', async () => {
      const { call, csrfCalls } = save({ id: 'new', params: { contentid: CONTENT_ID, caption: ' Q2 ' }, files: [part('report.pdf')] });
      const result = await handlerOf(fileHandler, 'save')(ctx, call);
      const data = dataOf(result);
      expect(result).toMatchObject({ status: 200, serializerEntity: 'file' });
      expect(data).toMatchObject({ isnew: 0, filename: 'report.pdf', fileext: 'pdf', contentid: CONTENT_ID, caption: 'Q2', saveErrors: '', errors: {} });
      expect(isCfUuid(String(data['fileid']))).toBe(true);
      expect(puts).toEqual([`${TENANT_B.tenantId}/${String(data['fileid'])}.pdf`]);
      expect(csrfCalls()).toBe(1);
    });

    it("stores a pooled site's upload under the pool and answers the new bean legacy reloads", async () => {
      const before = await fileCount(UMBRELLA);
      const site = { ...TENANT_A, filePoolId: TENANT_UMBRELLA.siteId };
      const { call } = save({ site, actor: actorOf(TENANT_A), files: [part('pooled.pdf')] });
      const data = dataOf(await handlerOf(fileHandler, 'save')(ctx, call));
      expect(await fileCount(UMBRELLA)).toBe(before + 1);
      expect(puts).toEqual([`${UMBRELLA}/${String(data['fileid'])}.pdf`]);
      expect(data).toMatchObject({ isnew: 1, siteid: TENANT_A.siteId, returnformat: 'self' });
    });

    it('keeps the named stored file values the request does not post', async () => {
      await insertFile(TENANT_B.tenantId, cfId('E', 1), { siteid: TENANT_B.siteId, filename: 'old.pdf', fileext: 'pdf', caption: 'Stored caption', credits: 'Stored credits' });
      const { call } = save({ params: { fileid: cfId('E', 1), credits: 'Posted credits' }, files: [part('new.pdf')] });
      const data = dataOf(await handlerOf(fileHandler, 'save')(ctx, call));
      expect(data['fileid']).not.toBe(cfId('E', 1));
      expect(data).toMatchObject({ caption: 'Stored caption', credits: 'Posted credits', filename: 'new.pdf' });
    });

    it.each(['photo.JPG', 'banner.png', 'clip.flv'])('halts the image upload %s with nothing written', async (fileName) => {
      const site = { ...TENANT_A, filePoolId: TENANT_UMBRELLA.siteId };
      const counts = [await fileCount(UMBRELLA), await fileCount(TENANT_A.tenantId)];
      const { call } = save({ site, actor: actorOf(TENANT_A), files: [part(fileName, 'image/jpeg')] });
      await expect(handlerOf(fileHandler, 'save')(ctx, call)).rejects.toBeInstanceOf(ImageUploadHaltedError);
      expect(puts).toEqual([]);
      expect([await fileCount(UMBRELLA), await fileCount(TENANT_A.tenantId)]).toEqual(counts);
    });

    it('answers invalidTokens for a failed CSRF check before anything else', async () => {
      const { call } = save({ actor: actorOf(TENANT_B, [Roles.member]), files: [part('a.pdf')], csrf: false });
      await expect(handlerOf(fileHandler, 'save')(ctx, call)).resolves.toEqual({ error: 'invalidTokens' });
      expect(puts).toEqual([]);
    });

    it('answers authorization without the module permission once the tokens pass', async () => {
      const { call, csrfCalls } = save({ actor: actorOf(TENANT_B, [Roles.member]), files: [part('a.pdf')] });
      await expect(handlerOf(fileHandler, 'save')(ctx, call)).resolves.toEqual({ error: 'authorization' });
      expect(csrfCalls()).toBe(1);
    });

    it.each([
      ['no posted part', {}, undefined],
      ['a part under another field', {}, [part('a.pdf', 'application/pdf', 'files')]],
      ['an empty fileField', { fileField: '' }, [part('a.pdf')]],
    ])('fails closed for %s', async (_name, params, files) => {
      const { call } = save({ params, ...(files === undefined ? {} : { files }) });
      await expect(handlerOf(fileHandler, 'save')(ctx, call)).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
      expect(puts).toEqual([]);
    });

    it('reads the part posted under the fileField the request names', async () => {
      const { call } = save({ params: { fileField: 'Files' }, files: [part('named.pdf', 'application/pdf', 'files')] });
      expect(dataOf(await handlerOf(fileHandler, 'save')(ctx, call))).toMatchObject({ isnew: 0, filename: 'named.pdf' });
    });

    it('answers a disallowed extension with the new bean of the fresh id, storing nothing', async () => {
      config = { ...CONTENT_CONFIG_DEFAULTS, fmAllowedExtensions: 'pdf' };
      const data = dataOf(await handlerOf(fileHandler, 'save')(ctx, save({ files: [part('notes.txt', 'text/plain')] }).call));
      expect(data).toMatchObject({ isnew: 1, filename: '', saveErrors: '', errors: {} });
      expect(isCfUuid(String(data['fileid']))).toBe(true);
      expect(puts).toEqual([]);
    });

    it('stores a posted remotePubDate', async () => {
      const { call } = save({ params: { remotePubDate: '2026-05-04T03:02:01' }, files: [part('dated.pdf')] });
      const data = dataOf(await handlerOf(fileHandler, 'save')(ctx, call));
      expect(data['remotepubdate']).toEqual(new Date(2026, 4, 4, 3, 2, 1));
    });
  });

  describe('delete', () => {
    const del = (input: Omit<CallInput, 'method'>): ReturnType<typeof callOf> => callOf({ method: 'delete', ...input });
    const stored = (fileId: string): Promise<unknown> => withTenant(handle.app, TENANT_B.tenantId, (tx) => repo.files.readFileAll(tx, fileId));

    beforeAll(async () => {
      await insertFile(TENANT_B.tenantId, cfId('D', 1), { siteid: TENANT_B.siteId, filename: 'd1.pdf', fileext: 'pdf' });
    });

    it('answers an empty data for a missing row without checking tokens', async () => {
      const { call, csrfCalls } = del({ id: cfId('D', 9) });
      await expect(handlerOf(fileHandler, 'delete')(ctx, call)).resolves.toEqual({ status: 200, data: '' });
      expect(csrfCalls()).toBe(0);
    });

    it.each([
      ['authorization without the module permission', { actor: actorOf(TENANT_B, [Roles.member]) }, { error: 'authorization' }],
      ['invalidTokens for a failed CSRF check', { csrf: false }, { error: 'invalidTokens' }],
      ['authorization for a call without a tenant', { site: { siteId: TENANT_B.siteId, tenantId: '' } }, { error: 'authorization' }],
    ] as const)('answers %s and keeps the row', async (_name, input, expected) => {
      await expect(handlerOf(fileHandler, 'delete')(ctx, del({ id: cfId('D', 1), ...input }).call)).resolves.toEqual(expected);
      expect(await stored(cfId('D', 1))).not.toBeNull();
    });

    it('removes the row named by a posted fileid', async () => {
      const { call } = del({ id: 'ignored', params: { fileid: cfId('D', 1) } });
      await expect(handlerOf(fileHandler, 'delete')(ctx, call)).resolves.toEqual({ status: 200, data: '' });
      expect(await stored(cfId('D', 1))).toBeNull();
    });
  });

  describe('fileMetaData', () => {
    const call = (input: Omit<CallInput, 'entity'>): ReturnType<typeof callOf> => callOf({ entity: 'fileMetaData', ...input });
    const metaRow = (metaId: string): Promise<unknown> =>
      withTenant(handle.app, TENANT_B.tenantId, async (tx) => (await repo.files.listFileMetadata(tx, { siteId: TENANT_B.siteId })).find((row) => row.metaid === metaId) ?? null);

    beforeAll(async () => {
      await insertFile(TENANT_B.tenantId, cfId('M', 1), { siteid: TENANT_B.siteId, filename: 'meta.pdf', fileext: 'pdf', filesize: 42, contenttype: 'application', contentsubtype: 'pdf' });
      await gated(TENANT_B.tenantId, async (tx) => {
        await repo.files.insertFileMetadata(tx, { metaid: META_ID, contentid: CONTENT_ID, contenthistid: HIST_ID, fileid: cfId('M', 1), siteid: TENANT_B.siteId, caption: 'Meta caption' });
        await repo.files.insertFileMetadata(tx, { metaid: cfId('O', 1), contentid: CONTENT_ID, contenthistid: HIST_ID, fileid: cfId('M', 9), siteid: TENANT_B.siteId });
      });
    });

    it('findOne joins the file columns', async () => {
      const data = dataOf(await handlerOf(fileMetaDataHandler, 'findOne')(ctx, call({ method: 'findOne', id: META_ID.toLowerCase() }).call));
      expect(data).toMatchObject({
        metaid: META_ID,
        isnew: 0,
        caption: 'Meta caption',
        filename: 'meta.pdf',
        filesize: 42,
        contenttype: 'application',
        fileext: 'pdf',
        directimages: true,
        entityname: 'fileMetaData',
      });
      expect((data['links'] as Struct)['file']).toMatch(new RegExp(`/file/${cfId('M', 1)}$`));
    });

    it('findOne of a row whose file is gone answers the new bean, as the load inner-joins tfiles', async () => {
      const data = dataOf(await handlerOf(fileMetaDataHandler, 'findOne')(ctx, call({ method: 'findOne', id: cfId('O', 1) }).call));
      expect(data).toMatchObject({ isnew: 1, fileid: '', metaid: cfId('O', 1) });
    });

    it('feed items carry no joined file columns', async () => {
      const data = dataOf(await handlerOf(fileMetaDataHandler, 'findAll')(ctx, call({ method: 'findAll' }).call));
      const item = (data['items'] as Struct[]).find((candidate) => candidate['metaid'] === META_ID);
      expect(item).toMatchObject({ caption: 'Meta caption', filename: '', filesize: 0, isnew: 0, entityname: 'fileMetaData' });
    });

    it('save updates the stored row with the posted values only, ignoring remotePubDate', async () => {
      const result = await handlerOf(fileMetaDataHandler, 'save')(ctx, call({ method: 'save', id: META_ID, params: { caption: ' Changed ', remotepubdate: '2026-01-01' } }).call);
      expect(dataOf(result)).toMatchObject({ metaid: META_ID, caption: 'Changed', remotepubdate: '', isnew: 0, saveErrors: '', errors: {} });
    });

    it('save of a new key inserts a row for the posted version and file', async () => {
      const params = { fileid: cfId('M', 1), contentid: CONTENT_ID, contenthistid: cfId('H', 2), alttext: 'Alt' };
      const data = dataOf(await handlerOf(fileMetaDataHandler, 'save')(ctx, call({ method: 'save', params }).call));
      expect(data).toMatchObject({ isnew: 0, contenthistid: cfId('H', 2), alttext: 'Alt', filename: 'meta.pdf', siteid: TENANT_B.siteId });
      expect(await metaRow(String(data['metaid']))).not.toBeNull();
    });

    it.each([
      ['invalidTokens', { csrf: false }, { error: 'invalidTokens' }],
      ['authorization', { actor: actorOf(TENANT_B, [Roles.member]) }, { error: 'authorization' }],
    ] as const)('save answers %s', async (_name, input, expected) => {
      await expect(handlerOf(fileMetaDataHandler, 'save')(ctx, call({ method: 'save', id: META_ID, ...input }).call)).resolves.toEqual(expected);
    });

    it('delete removes the row; a missing one answers an empty data', async () => {
      await expect(handlerOf(fileMetaDataHandler, 'delete')(ctx, call({ method: 'delete', id: META_ID }).call)).resolves.toEqual({ status: 200, data: '' });
      expect(await metaRow(META_ID)).toBeNull();
      const { call: again, csrfCalls } = call({ method: 'delete', id: META_ID });
      await expect(handlerOf(fileMetaDataHandler, 'delete')(ctx, again)).resolves.toEqual({ status: 200, data: '' });
      expect(csrfCalls()).toBe(0);
    });

    it("joins and saves a pooled site's row, whose file lives in the file pool tenant", async () => {
      const site = { ...TENANT_A, filePoolId: TENANT_UMBRELLA.siteId };
      const metaId = cfId('Q', 1);
      await insertFile(UMBRELLA, cfId('Q', 2), { siteid: TENANT_UMBRELLA.siteId, filename: 'pooled-meta.pdf', fileext: 'pdf' });
      await gated(TENANT_A.tenantId, (tx) =>
        repo.files.insertFileMetadata(tx, { metaid: metaId, contentid: CONTENT_ID, contenthistid: HIST_ID, fileid: cfId('Q', 2), siteid: TENANT_A.siteId }),
      );
      const pooled = (input: Omit<CallInput, 'entity' | 'site' | 'actor'>): JsonApiCall => call({ ...input, site, actor: actorOf(TENANT_A) }).call;

      expect(dataOf(await handlerOf(fileMetaDataHandler, 'findOne')(ctx, pooled({ method: 'findOne', id: metaId })))).toMatchObject({ isnew: 0, filename: 'pooled-meta.pdf' });
      const saved = dataOf(await handlerOf(fileMetaDataHandler, 'save')(ctx, pooled({ method: 'save', id: metaId, params: { credits: 'Pooled credits' } })));
      expect(saved).toMatchObject({ metaid: metaId, credits: 'Pooled credits', filename: 'pooled-meta.pdf', isnew: 0 });
    });

    it('delete answers authorization for a call without a tenant', async () => {
      const { call: noTenant } = call({ method: 'delete', id: META_ID, site: { siteId: TENANT_B.siteId, tenantId: '' } });
      await expect(handlerOf(fileMetaDataHandler, 'delete')(ctx, noTenant)).resolves.toEqual({ error: 'authorization' });
    });
  });

  describe('SQL-bounded feeds and keyed metadata reads', () => {
    const CORPUS = { siteId: 'Corpus-Site', tenantId: TENANT_B.tenantId };
    const EMPTY = { siteId: 'empty-corpus-site', tenantId: TENANT_B.tenantId };
    const POOLED = { ...TENANT_A, filePoolId: TENANT_UMBRELLA.siteId };
    const fileIdOf = (n: number): string => cfId('S', n);
    const metaIdOf = (n: number): string => cfId('T', n);
    // Stored ids equal to another stored id but for case, which the site scan and SQL Server both match.
    const LOWER_FILE = fileIdOf(6).toLowerCase();
    const LOWER_META = metaIdOf(1).toLowerCase();
    const at = (day: number): Date => new Date(2026, 0, day, 8, 30);
    // A zero-width space is ignorable under the id collation, so only the collation equates these ids with stored ones.
    const zeroWidth = (id: string): string => `${id.slice(0, 4)}\u200B${id.slice(4)}`;

    type Statement = { sql: string; rows: number };
    type Outcome = { value: JsonApiResult; url: Struct } | { error: { name: string; message: string; type: unknown } };

    /** SQL Server equality of two ids as the site scan compared them: trailing spaces dropped, case ignored. */
    const sameId = (a: string, b: string): boolean => a.replace(/ +$/u, '').toLowerCase() === b.replace(/ +$/u, '').toLowerCase();

    /** The `fileid`s or `metaid`s of a collection answer. */
    const itemIds = (result: JsonApiResult): unknown[] => (dataOf(result)['items'] as Struct[]).map((item) => item['id']);

    beforeAll(async () => {
      const files: [string, Omit<FileInput, 'fileid'>][] = [
        [fileIdOf(1), { siteid: 'corpus-site', filename: 'alpha.pdf', fileext: 'pdf', filesize: 10, caption: 'Alpha', created: at(1), remotepubdate: at(3) }],
        [fileIdOf(2), { siteid: 'CORPUS-SITE  ', filename: 'Beta.docx', fileext: 'docx', filesize: 200, credits: 'Ann', created: at(2), deleted: 1 }],
        [fileIdOf(3), { siteid: CORPUS.siteId, filename: 'gamma_1.pdf', fileext: 'pdf', caption: 'alpha  ', alttext: 'é', created: at(2) }],
        [fileIdOf(4), { siteid: CORPUS.siteId, filename: 'délta.txt', fileext: 'txt', filesize: 10, caption: 'Ünïcode', created: at(5) }],
        [fileIdOf(5), { siteid: CORPUS.siteId, filename: 'smile \u{1F600}.pdf', fileext: 'pdf', filesize: 55, created: at(4) }],
        [LOWER_FILE, { siteid: CORPUS.siteId, filename: 'lower.pdf', fileext: 'pdf', filesize: 0, created: at(6) }],
        [fileIdOf(7), { siteid: 'other-site', filename: 'other.pdf', fileext: 'pdf', filesize: 1 }],
      ];
      for (const [fileId, row] of files) await insertFile(TENANT_B.tenantId, fileId, row);
      const metas: FileMetadataInput[] = [
        { metaid: metaIdOf(1), siteid: 'corpus-site', fileid: fileIdOf(1), contentid: CONTENT_ID, contenthistid: HIST_ID, caption: 'Upper' },
        { metaid: LOWER_META, siteid: CORPUS.siteId, fileid: fileIdOf(3), contentid: CONTENT_ID, contenthistid: HIST_ID, caption: 'lower' },
        { metaid: metaIdOf(2), siteid: 'CORPUS-SITE', fileid: fileIdOf(1), contentid: CONTENT_ID, contenthistid: cfId('H', 3), alttext: 'Alt', remotepubdate: at(2) },
        { metaid: metaIdOf(3), siteid: CORPUS.siteId, fileid: fileIdOf(2), contentid: cfId('C', 2), contenthistid: cfId('H', 4), caption: 'beta', remoteid: 'R1', remotepubdate: at(9) },
        { metaid: metaIdOf(4), siteid: CORPUS.siteId, fileid: fileIdOf(4), contentid: cfId('C', 2), contenthistid: cfId('H', 4), caption: 'Gamma_x', credits: 'Ann' },
        { metaid: metaIdOf(5), siteid: 'other-site', fileid: fileIdOf(7), contentid: CONTENT_ID, contenthistid: HIST_ID, caption: 'Other' },
      ];
      await gated(TENANT_B.tenantId, async (tx) => {
        for (const row of metas) await repo.files.insertFileMetadata(tx, row);
      });
    });

    /** The rows the site-list feeds evaluated: the entity's site list in its tenant without the tenant column, findMany's narrowed to its ids. */
    async function siteListRows(entity: EntityHandler, call: JsonApiCall): Promise<Struct[]> {
      const listed: Struct[] =
        entity === fileHandler
          ? await withPoolTenant(handle.app, call.tenantId, 'file', (tx) => repo.files.listFiles(tx, call.siteId))
          : await withTenant(handle.app, call.tenantId, (tx) => repo.files.listFileMetadata(tx, { siteId: call.siteId }));
      const pk = entity.config.primaryKey;
      const ids = call.method === 'findMany' ? (call.ids ?? []) : undefined;
      return listed
        .map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'tenant_id')))
        .filter((row) => ids === undefined || ids.some((id) => sameId(String(row[pk]), id)));
    }

    /** `ctx` whose feed sources are the in-memory evaluator over `rows`. */
    function memoryCtx(rows: readonly Struct[]): ContentRouteContext {
      const repository = { ...repo, beanFeed: { source: () => rowsSource(rows) } };
      return { ...ctx, domain: { ...ctx.domain, repository } } as unknown as ContentRouteContext;
    }

    /** `ctx` whose tenant transactions record each statement and the number of rows it returned. */
    function recordingCtx(statements: Statement[]): ContentRouteContext {
      const record = (tx: TenantTx): TenantTx => ({
        kind: tx.kind,
        tenantId: tx.tenantId,
        schema: tx.schema,
        onCommit: (cb, onError) => {
          tx.onCommit(cb, onError);
        },
        query: (async (text: string | { text: string }, values?: unknown[]) => {
          const result = await tx.query(text, values);
          statements.push({ sql: typeof text === 'string' ? text : text.text, rows: result.rows.length });
          return result;
        }) as TenantTx['query'],
      });
      const db: TenantDb = {
        schema: handle.app.schema,
        withTenant: (tenantId, fn, options) => handle.app.withTenant(tenantId, (tx) => fn(record(tx)), options),
        withMetadata: (fn, options) => handle.app.withMetadata(fn, options),
        end: () => Promise.resolve(),
      };
      return { ...ctx, domain: { ...ctx.domain, db } };
    }

    /** What `entity` answers `input` with under `routeCtx` and the URL scope it left, or the error it raised. */
    async function outcomeOf(entity: EntityHandler, routeCtx: ContentRouteContext, input: CallInput): Promise<Outcome> {
      const { call } = callOf(input);
      try {
        const value = await handlerOf(entity, input.method as 'findAll')(routeCtx, call);
        return { value, url: { ...call.apiContext.url } };
      } catch (err) {
        const error = err as Error & { type?: unknown };
        return { error: { name: error.name, message: error.message, type: error.type } };
      }
    }

    const fileCase = (label: string, method: string, url: Struct, extra: Partial<CallInput> = {}): [string, EntityHandler, CallInput] => [
      `file ${label}`,
      fileHandler,
      { method, site: CORPUS, url, ...extra },
    ];
    const metaCase = (label: string, method: string, url: Struct, extra: Partial<CallInput> = {}): [string, EntityHandler, CallInput] => [
      `fileMetaData ${label}`,
      fileMetaDataHandler,
      { method, entity: 'fileMetaData', site: CORPUS, url, ...extra },
    ];
    const FILE_IDS = [fileIdOf(3), fileIdOf(1).toLowerCase(), fileIdOf(3), `${fileIdOf(2)}  `, cfId('S', 99), fileIdOf(6), 'x\u0000y', zeroWidth(fileIdOf(4))];
    const META_IDS = [metaIdOf(3), LOWER_META, metaIdOf(1), metaIdOf(3).toLowerCase(), metaIdOf(5), cfId('T', 99), zeroWidth(metaIdOf(4))];
    const FEED_CASES: [string, EntityHandler, CallInput][] = [
      fileCase('findAll', 'findAll', {}),
      fileCase('second page', 'findAll', { itemsPerPage: 2, pageIndex: 2 }),
      fileCase('page past the end', 'findAll', { itemsPerPage: 4, pageIndex: 9 }),
      fileCase('startIndex', 'findAll', { itemsPerPage: 2, startIndex: 3 }),
      fileCase('maxItems', 'findAll', { maxItems: 3 }),
      fileCase('countOnly', 'findAll', { countOnly: 'true' }),
      fileCase('fields', 'findAll', { fields: 'filename,caption,nosuch' }),
      fileCase('sort list', 'findAll', { sort: '-filesize,filename' }),
      fileCase('sortBy descending', 'findAll', { sortBy: 'created', sortDirection: 'desc' }),
      fileCase('sort over NULLs and trailing spaces', 'findAll', { sort: 'caption' }),
      fileCase('sort by a binary column', 'findAll', { sort: 'image' }),
      fileCase('sort by an unknown column', 'findAll', { sort: 'nosuch' }),
      fileCase('equality', 'findQuery', { fileext: 'PDF' }),
      fileCase('equality ignoring case and trailing spaces', 'findQuery', { caption: 'ALPHA' }),
      fileCase('like', 'findQuery', { filename: '*a*' }),
      fileCase('like with an underscore over astral text', 'findQuery', { filename: 'gamma_*' }),
      fileCase('null', 'findQuery', { caption: 'null' }),
      fileCase('numeric comparison', 'findQuery', { filesize: 'gt^50' }),
      fileCase('in list', 'findQuery', { fileext: 'in^pdf,docx' }),
      fileCase('or', 'findQuery', { fileext: 'txt', or: '', filesize: '200' }),
      fileCase('timestamp comparison', 'findQuery', { created: 'gte^2026-01-02' }),
      fileCase('timestamp null', 'findQuery', { remotepubdate: 'null' }),
      fileCase('id', 'findQuery', { id: LOWER_FILE.toUpperCase() }),
      fileCase('filtered countOnly', 'findQuery', { fileext: 'pdf', countOnly: 'true' }),
      fileCase('property without a column', 'findQuery', { filefield: 'x' }),
      fileCase('NUL in a criteria', 'findQuery', { filename: 'a\u0000b' }),
      fileCase('findMany', 'findMany', {}, { ids: FILE_IDS }),
      fileCase('findMany sorted', 'findMany', { sort: 'filename' }, { ids: FILE_IDS }),
      fileCase('findMany paged', 'findMany', { itemsPerPage: 1, pageIndex: 2 }, { ids: FILE_IDS }),
      fileCase('findMany without a match', 'findMany', {}, { ids: [cfId('S', 98)] }),
      fileCase('empty site with an unknown column', 'findQuery', { filefield: 'x', sort: 'nosuch' }, { site: EMPTY }),
      fileCase('empty site countOnly', 'findAll', { countOnly: 'true' }, { site: EMPTY }),
      fileCase('pooled site', 'findAll', {}, { site: POOLED, actor: actorOf(TENANT_A) }),
      metaCase('findAll', 'findAll', {}),
      metaCase('second page', 'findAll', { itemsPerPage: 2, pageIndex: 2 }),
      metaCase('countOnly', 'findAll', { countOnly: 'true' }),
      metaCase('fields', 'findAll', { fields: 'caption' }),
      metaCase('sort list', 'findAll', { sort: 'contenthistid,-caption' }),
      metaCase('sortBy a timestamp descending', 'findAll', { sortBy: 'remotepubdate', sortDirection: 'desc' }),
      metaCase('equality ignoring case', 'findQuery', { contentid: CONTENT_ID.toLowerCase() }),
      metaCase('like with an underscore', 'findQuery', { caption: '*a_*' }),
      metaCase('null', 'findQuery', { caption: 'null' }),
      metaCase('not null', 'findQuery', { remotepubdate: 'neq^null' }),
      metaCase('timestamp comparison', 'findQuery', { remotepubdate: 'lt^2026-01-05' }),
      metaCase('in list', 'findQuery', { caption: 'in^upper,BETA' }),
      metaCase('hinted property without a column', 'findQuery', { filesize: '1' }),
      metaCase('empty site with a hinted property without a column', 'findQuery', { filesize: '1' }, { site: EMPTY }),
      metaCase('findMany', 'findMany', {}, { ids: META_IDS }),
      metaCase('findMany sorted', 'findMany', { sort: '-caption' }, { ids: META_IDS }),
      metaCase('pooled site', 'findAll', {}, { site: POOLED, actor: actorOf(TENANT_A) }),
    ];

    it.each(FEED_CASES)('%s answers what the site list evaluated in memory answers', async (_label, entity, input) => {
      const rows = await siteListRows(entity, callOf(input).call);
      expect(await outcomeOf(entity, ctx, input)).toEqual(await outcomeOf(entity, memoryCtx(rows), input));
    });

    it('answers the corpus rows, so the comparison exercises the data', async () => {
      const files = await handlerOf(fileHandler, 'findAll')(ctx, callOf({ method: 'findAll', site: CORPUS }).call);
      expect(itemIds(files)).toEqual([fileIdOf(1), fileIdOf(2), fileIdOf(3), fileIdOf(4), fileIdOf(5), LOWER_FILE]);
      const metas = await handlerOf(fileMetaDataHandler, 'findAll')(ctx, callOf({ method: 'findAll', entity: 'fileMetaData', site: CORPUS }).call);
      expect(itemIds(metas)).toEqual([metaIdOf(1), metaIdOf(2), metaIdOf(3), metaIdOf(4), LOWER_META]);
      const many = await handlerOf(fileHandler, 'findMany')(ctx, callOf({ method: 'findMany', site: CORPUS, ids: FILE_IDS }).call);
      // findMany's ordering compares ids with CFML `eq`, which keeps trailing spaces, so the padded id orders no item.
      expect(itemIds(many)).toEqual([fileIdOf(3), fileIdOf(1), fileIdOf(3), LOWER_FILE]);
    });

    it('reads a page with a count and one LIMIT statement holding only the page rows', async () => {
      const statements: Statement[] = [];
      const call = callOf({ method: 'findAll', site: CORPUS, url: { itemsPerPage: 2, pageIndex: 2 } }).call;
      expect(itemIds(await handlerOf(fileHandler, 'findAll')(recordingCtx(statements), call))).toEqual([fileIdOf(3), fileIdOf(4)]);
      const reads = statements.filter((statement) => /\."file"(\s|$)/.test(statement.sql));
      expect(reads.filter((statement) => /\bLIMIT\b/.test(statement.sql)).map((statement) => statement.rows)).toEqual([2]);
      expect(Math.max(...reads.map((statement) => statement.rows))).toBeLessThanOrEqual(2);
    });

    it('reads only the requested rows for findMany', async () => {
      const statements: Statement[] = [];
      const call = callOf({ method: 'findMany', entity: 'fileMetaData', site: CORPUS, ids: [metaIdOf(4), metaIdOf(2)] }).call;
      expect(itemIds(await handlerOf(fileMetaDataHandler, 'findMany')(recordingCtx(statements), call))).toEqual([metaIdOf(4), metaIdOf(2)]);
      const reads = statements.filter((statement) => statement.sql.includes('."file_metadata"'));
      expect(Math.max(...reads.map((statement) => statement.rows))).toBeLessThanOrEqual(2);
    });

    it('reads one metadata row, not the site, for findOne', async () => {
      const statements: Statement[] = [];
      const call = callOf({ method: 'findOne', entity: 'fileMetaData', site: CORPUS, id: metaIdOf(2).toLowerCase() }).call;
      const data = dataOf(await handlerOf(fileMetaDataHandler, 'findOne')(recordingCtx(statements), call));
      expect(data).toMatchObject({ metaid: metaIdOf(2), isnew: 0, alttext: 'Alt', filename: 'alpha.pdf' });
      expect(statements.filter((statement) => statement.sql.includes('."file_metadata"')).map((statement) => statement.rows)).toEqual([1]);
    });

    it.each([
      ['the stored case', metaIdOf(2), CORPUS.siteId, metaIdOf(2)],
      ['another case with trailing spaces, under another case of the site', `${metaIdOf(2).toLowerCase()}  `, 'CORPUS-SITE', metaIdOf(2)],
      ['an id two stored rows equal, the first in id order', LOWER_META, CORPUS.siteId, metaIdOf(1)],
      ["another site's row", metaIdOf(5), CORPUS.siteId, null],
      ['a missing id', cfId('T', 99), CORPUS.siteId, null],
      ['an id holding NUL', `${metaIdOf(2)}\u0000`, CORPUS.siteId, null],
      ['an id only the collation equates', zeroWidth(metaIdOf(2)), CORPUS.siteId, null],
    ] as const)('findFileMetadata of %s answers the row the site scan found', async (_name, metaId, siteId, expected) => {
      const [found, listed] = await withTenant(handle.app, TENANT_B.tenantId, async (tx) => [
        await repo.files.findFileMetadata(tx, { siteId, metaId }),
        await repo.files.listFileMetadata(tx, { siteId }),
      ] as const);
      expect(found).toEqual(listed.find((row) => sameId(row.metaid, metaId)) ?? null);
      expect(found?.metaid ?? null).toBe(expected);
    });
  });
});
