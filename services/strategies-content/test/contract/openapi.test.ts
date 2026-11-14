/** Every registered strategies-content route against contracts/openapi.yaml: its declaration, and its responses through `app.inject`. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Roles, collectRouteMatrix, moduleRole, type RouteMatrixEntry } from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, type EventEnvelope } from '@opt2/platform/events';
import { WRITE_POSITION_HEADER_LC } from '@opt2/platform/migration-kit';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  poolTenantExpectation,
  pushTo,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
} from '@opt2/platform/testing';
import {
  GROUP_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
} from '../../src/events/consumers.js';
import { mappings } from '../../src/migration/mappings/index.js';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import { FAKE_XID, SERVICE, TEST_CLOCK, buildContentApp, serviceHeaders, userHeaders, type ContentTestApp } from '../helpers/app.js';
import { tasksHeaders } from '../helpers/tokens.js';

type Json = Record<string, unknown>;

interface OpenApiDoc {
  paths: Record<string, Record<string, Json>>;
}

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

/** The contract operations the service's source registers a route for. */
const SERVED_OPERATIONS = [
  'healthz',
  'getHeaderPrompts',
  'lookupFileExtensions',
  'commentsProxyGet',
  'commentsProxyPost',
  'migrationApply',
  'migrationExport',
  'migrationChanges',
  'migrationPosition',
  'migrationWatermarkGet',
  'migrationWatermarkPost',
  'migrationGate',
  'migrationPutObject',
  'migrationGetObject',
  'getFileDownloadUrl',
  'getLocalContentFile',
  'pushSiteChanged',
  'pushGroupChanged',
  'pushPermissionChanged',
  'pushMembershipChanged',
  'jobPublishScheduledChangesets',
  'jobFeedAutoImport',
  'queuePause',
  'queueResume',
  'queueEnsure',
] as const;

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const GROUP_ID = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const FILE_A = 'B1C2D3E4-0001-4A5B-8C7D9E0F1A2B3C4D';
const FILE_B = 'B1C2D3E4-0002-4A5B-8C7D9E0F1A2B3C4D';
const FILE_MISSING = 'B1C2D3E4-0003-4A5B-8C7D9E0F1A2B3C4D';
const CHANGESET_1 = 'D1E2F3A4-0001-4A5B-8C7D9E0F1A2B3C4D';
const CHANGESET_2 = 'D1E2F3A4-0002-4A5B-8C7D9E0F1A2B3C4D';
const contentId = (n: number): string => `E1F2A3B4-000${n}-4A5B-8C7D9E0F1A2B3C4D`;
const SITE_MANAGER = '00000000000000000000000000000000000';
const CHANGESETS = '00000000000000000000000000000000014';
const OWN_QUEUE = 'content-scheduled-publish';
const JSON_TYPE = { 'content-type': 'application/json' } as const;
const OCTET_TYPE = { 'content-type': 'application/octet-stream' } as const;
const OBJECT_BYTES = Buffer.from('legacy file-store bytes');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let t: ContentTestApp;

/** The request a test sends. */
interface Request {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: Json | Buffer | string;
}

/** Sends `request` and holds the answer to its contract operation; returns the response. */
async function call(request: Request): Promise<InjectResponse> {
  const { method, url, headers = {}, payload } = request;
  const res = await t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: url.split('?')[0] ?? url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

/** Parameters of the recorded statements whose SQL matches `pattern`. */
function paramsOf(pattern: RegExp): unknown[][] {
  return t.db.statements.filter((statement) => pattern.test(statement.sql)).map((statement) => [...statement.params]);
}

/** Every value of `params`, array parameters flattened. */
function flat(params: readonly unknown[]): unknown[] {
  return params.flatMap((value) => (Array.isArray(value) ? (value as unknown[]) : [value]));
}

/** The served operations as Fastify would register them: path parameters as `:name`, unless the contract names the Fastify path. */
function servedRoutes(): Record<string, unknown>[] {
  const routes: Record<string, unknown>[] = [];
  for (const [template, item] of Object.entries(OPENAPI.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method] as Json | undefined;
      if (operation === undefined || !(SERVED_OPERATIONS as readonly unknown[]).includes(operation.operationId)) continue;
      const fastifyPath = operation['x-opt2-fastify-path'];
      const requires = operation['x-opt2-requires'];
      routes.push({
        method: method.toUpperCase(),
        url: typeof fastifyPath === 'string' ? fastifyPath : template.replace(/\{(\w+)\}/g, ':$1'),
        transport: operation['x-opt2-transport'],
        ...(Array.isArray(requires) ? { requires: [...(requires as string[])].sort() } : {}),
        ...(operation['x-opt2-public'] === true ? { public: true } : {}),
      });
    }
  }
  return routes.sort(byRoute);
}

function byRoute(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return `${String(a.method)} ${String(a.url)}` < `${String(b.method)} ${String(b.url)}` ? -1 : 1;
}

/** A registered route in the comparable form of servedRoutes. */
function registered(route: RouteMatrixEntry): Record<string, unknown> {
  return {
    method: route.method,
    url: route.url,
    transport: route.transport,
    ...(route.requires === undefined ? {} : { requires: [...route.requires].sort() }),
    ...(route.public === true ? { public: true } : {}),
  };
}

beforeAll(async () => {
  t = await buildContentApp();
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.db.reset();
  t.publisher.clear();
});

describe('route declarations', () => {
  it('names every served operation exactly once in the contract', () => {
    const operationIds = Object.values(OPENAPI.paths).flatMap((item) =>
      HTTP_METHODS.flatMap((method) => (item[method] === undefined ? [] : [item[method]?.operationId])),
    );
    expect(SERVED_OPERATIONS.map((id) => operationIds.filter((candidate) => candidate === id).length)).toEqual(SERVED_OPERATIONS.map(() => 1));
  });

  it('registers exactly the served operations, each with its contract transport and roles', () => {
    expect(collectRouteMatrix(t.app).routes.map(registered).sort(byRoute)).toEqual(servedRoutes());
  });
});

describe('healthz', () => {
  it.each<[string, () => Promise<Record<string, string>>, string, number]>([
    ['no credential', async () => ({}), '', 200],
    ['an unverifiable bearer token', async () => ({ authorization: 'Bearer not-a-token' }), '', 401],
    ['a tenant-a user naming tenant-b', () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser] }), `?siteid=${SITE_B}`, 403],
  ])('answers %s with the contract %i', async (_label, headers, query, status) => {
    const res = await call({ method: 'GET', url: `/healthz${query}`, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('getHeaderPrompts', () => {
  const url = `/v1/sites/${SITE_A}/header-prompts`;
  /** The groups the membership projection stores for the user, spelled as identity sent them. */
  const projectedGroup = GROUP_ID.toLowerCase();

  /** Answers each list the header counts with rows: duplicate and null content ids count once each. */
  function seedLists(): void {
    t.db.respond(/^SELECT \* FROM \(SELECT draft\.contenthistid, module\.title AS module, active\./, [
      { contentid: contentId(1) },
      { contentid: contentId(1) },
      { contentid: null },
    ]);
    t.db.respond(/^SELECT \* FROM \(SELECT DISTINCT draft\.contenthistid/, (_params, sql) =>
      sql.includes('tapprovalrequests.userid') ? [{ contentid: contentId(2) }] : [{ contentid: contentId(3) }, { contentid: contentId(4) }, { contentid: contentId(3) }],
    );
    t.db.respond(/^SELECT contentid FROM "content"\."content" WHERE lower\(rtrim\(lastupdatebyid\)\)/, [{ contentid: contentId(5) }]);
    t.db.respond(/FROM "content"\."membership_projection"/, [{ group_id: projectedGroup }]);
    t.db.respond(/FROM "content"\."changeset" WHERE/, [{ changesetid: CHANGESET_1 }, { changesetid: CHANGESET_2 }]);
    t.db.respond(/AS pending FROM "content"\."content" c/, (params) => [{ pending: flat(params).includes(CHANGESET_1) ? 2 : 1 }]);
  }

  it('counts a system user’s lists, approvals limited to the groups the membership projection holds', async () => {
    seedLists();
    const res = await call({ method: 'GET', url, headers: await userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser] }) });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: { drafts: 2, submissions: 1, approvals: 2, expires: 1, pendingChangesets: 0 },
    });
    expect(paramsOf(/tapprovalrequests\.groupid = ANY/).map(flat)).toEqual([expect.arrayContaining([projectedGroup])]);
  });

  it.each<[string, readonly string[], number]>([
    ['a site admin', [Roles.systemUser, Roles.siteAdmin], 3],
    ['a system user with the Change Sets and Site Manager modules', [Roles.systemUser, moduleRole(CHANGESETS), moduleRole(SITE_MANAGER)], 3],
    ['a system user with the Change Sets module only', [Roles.systemUser, moduleRole(CHANGESETS)], 0],
  ])('sums the versions awaiting approval in unpublished change sets for %s', async (_label, roles, pending) => {
    seedLists();
    const res = await call({ method: 'GET', url, headers: await userHeaders({ sub: USER_ID, site: SITE_A, roles }) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Json).pendingChangesets).toBe(pending);
  });

  it('reads no membership for a site admin, whose approvals cover every group', async () => {
    seedLists();
    await call({ method: 'GET', url, headers: await userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser, Roles.siteAdmin] }) });
    expect(paramsOf(/membership_projection/)).toEqual([]);
    expect(paramsOf(/tapprovalrequests\.groupid/)).toEqual([]);
  });

  it.each<[string, () => Promise<Record<string, string>>, string, number]>([
    ['no credential', async () => ({}), url, 401],
    ['a public member', () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.member] }), url, 403],
    ['a user of another site', () => userHeaders({ sub: USER_ID, site: SITE_B, roles: [Roles.s2] }), url, 403],
    ['a service without a user token', () => serviceHeaders('people'), url, 401],
  ])('refuses %s with the contract %i', async (_label, headers, target, status) => {
    const res = await call({ method: 'GET', url: target, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('lookupFileExtensions', () => {
  const url = '/internal/v1/files:lookup';
  const callerFor = (caller: string, site: string) => serviceHeaders(caller, { sub: USER_ID, site, roles: [Roles.systemUser] });
  const peopleFor = (site: string) => callerFor('people', site);

  it.each(['people', 'identity'])('answers %s the listed ids that name a stored file, in listed order and spelling', async (caller) => {
    t.db.respond(/^SELECT fileid, fileext FROM "content"\."file" WHERE fileid = ANY/, [
      { fileid: `${FILE_B} `, fileext: null },
      { fileid: FILE_A, fileext: 'jpg' },
    ]);
    const res = await call({
      method: 'POST',
      url,
      headers: { ...(await callerFor(caller, SITE_A)), ...JSON_TYPE },
      payload: { fileIds: [FILE_B, FILE_MISSING, FILE_A.toLowerCase()] },
    });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: { items: [{ fileId: FILE_B, fileExt: null }, { fileId: FILE_A.toLowerCase(), fileExt: 'jpg' }] },
    });
  });

  it.each<[string, Json | string]>([
    ['no ids', { fileIds: [] }],
    ['a repeated id', { fileIds: [FILE_A, FILE_A] }],
    ['an id longer than 35 characters', { fileIds: [`${FILE_A}0`] }],
    ['an unknown field', { fileIds: [FILE_A], siteId: SITE_A }],
    ['a body that is not JSON', 'fileIds=x'],
  ])('answers the contract 400 for %s', async (_label, payload) => {
    const res = await call({ method: 'POST', url, headers: { ...(await peopleFor(SITE_A)), ...JSON_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['people without a forwarded user token', () => serviceHeaders('people'), 401],
    ['another service', () => callerFor('programs-sites', SITE_A), 403],
    ['a browser user', () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.s2] }), 403],
  ])('refuses %s with the contract %i', async (_label, headers, status) => {
    const res = await call({ method: 'POST', url, headers: { ...(await headers()), ...JSON_TYPE }, payload: { fileIds: [FILE_A] } });
    expect(res.statusCode).toBe(status);
  });
});

describe('comments proxy', () => {
  const url = '/core/modules/v1/comments/ajax/commentsProxy.cfc';
  const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' } as const;
  const visitor = (site = SITE_A) => userHeaders({ sub: '', site, roles: [] });

  it.each<[string, Request['method'], string, string | undefined]>([
    ['get', 'GET', `?method=get&commentID=${contentId(1)}&siteid=${SITE_A}`, undefined],
    ['getContentStats', 'POST', '', `method=getContentStats&contentID=${contentId(1)}&siteid=${SITE_A}`],
    ['flag', 'POST', `?method=flag&commentID=${contentId(1)}`, undefined],
  ])('answers %s with the contract 200 text', async (_label, method, query, form) => {
    const headers = { ...(await visitor()), ...(form === undefined ? {} : FORM_TYPE) };
    const res = await call({ method, url: `${url}${query}`, headers, ...(form === undefined ? {} : { payload: form }) });
    expect({ status: res.statusCode, type: res.headers['content-type'] }).toEqual({ status: 200, type: 'text/html;charset=UTF-8' });
  });

  it.each<[string, Request['method'], string, () => Promise<Record<string, string>>, number]>([
    ['a siteid of another site', 'GET', `?method=get&commentID=${contentId(1)}&siteid=${SITE_B}`, () => visitor(), 403],
    ['a call without a user token', 'POST', `?method=flag&commentID=${contentId(1)}`, () => serviceHeaders('gateway'), 401],
    ['renderCommentsPage, which stays legacy-served', 'GET', `?method=renderCommentsPage&contentID=${contentId(1)}`, () => visitor(), 500],
    ['an argument the method does not declare', 'POST', `?method=get&commentID=${contentId(1)}&foo=1`, () => visitor(), 500],
  ])('answers %s with the contract %i', async (_label, method, query, headers, status) => {
    const res = await call({ method, url: `${url}${query}`, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('migration objects', () => {
  const url = '/internal/v1/migration/objects';
  const key = `${TENANT_A.tenantId}/${FILE_A}.png`;
  const putUrl = (overrides: Record<string, string> = {}): string =>
    `${url}?${new URLSearchParams({ tenantId: TENANT_A.tenantId, fileId: FILE_A, variant: '', ext: 'PNG', contentType: 'image/png', sha256: sha256(OBJECT_BYTES), ...overrides }).toString()}`;
  /** The `content.file_object` row of the stored object. */
  const objectRow = (): Json => ({
    tenant_id: TENANT_A.tenantId,
    file_id: FILE_A,
    variant: '',
    ext: 'png',
    object_key: key,
    size: String(OBJECT_BYTES.length),
    sha256: sha256(OBJECT_BYTES),
    content_type: 'image/png',
    orphan: true,
    created_at: new Date('2026-06-30T10:00:00Z'),
  });
  /** The publication's key-lock and intent-ledger statements, in order. */
  const publicationSteps = (): string[] =>
    t.db.statements.flatMap(({ sql }) => {
      if (/^SELECT pg_advisory_xact_lock\(/.test(sql)) return ['lock'];
      if (!/"content"\."staged_object"/.test(sql)) return [];
      if (/ WHERE recorded_at < /.test(sql)) return ['recover'];
      return [/^INSERT/.test(sql) ? 'stage' : /^SELECT/.test(sql) ? 'claim' : /^UPDATE/.test(sql) ? 'commit' : 'settle'];
    });

  it('stores a new object and records it, answering its FileObject and write position', async () => {
    const res = await call({ method: 'POST', url: putUrl(), headers: { ...(await serviceHeaders('migration')), ...OCTET_TYPE }, payload: OBJECT_BYTES });
    expect({ status: res.statusCode, body: res.json(), position: res.headers[WRITE_POSITION_HEADER_LC] }).toEqual({
      status: 200,
      body: { key, size: OBJECT_BYTES.length, sha256: sha256(OBJECT_BYTES), created: true },
      position: `${SERVICE}=${FAKE_XID}`,
    });
    expect(await t.storage.get(CONTENT_FILES_BUCKET, key)).toEqual(OBJECT_BYTES);
    expect(publicationSteps()).toEqual(['recover', 'stage', 'lock', 'claim', 'settle']);
  });

  it('answers created false, writing nothing, when the key already holds the same hash', async () => {
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'image/png' });
    t.db.respond(/FROM "content"\."file_object" WHERE "object_key" = \$1/, [objectRow()]);
    const res = await call({ method: 'POST', url: putUrl(), headers: { ...(await serviceHeaders('migration')), ...OCTET_TYPE }, payload: OBJECT_BYTES });
    expect({ status: res.statusCode, created: (res.json() as Json).created }).toEqual({ status: 200, created: false });
    expect(paramsOf(/^INSERT INTO "content"\."(?!staged_object")/)).toEqual([]);
    expect(publicationSteps()).toEqual(['recover', 'stage', 'lock', 'claim', 'settle']);
  });

  it.each<[string, string, Buffer | Json]>([
    ['a body whose hash differs', putUrl({ sha256: sha256(Buffer.from('other bytes')) }), OBJECT_BYTES],
    ['a file id that is not a CF UUID', putUrl({ fileId: 'not-a-file-id' }), OBJECT_BYTES],
    ['a variant leaving the key’s directory', putUrl({ variant: '_x/../y' }), OBJECT_BYTES],
    ['an upper-case hash', putUrl({ sha256: sha256(OBJECT_BYTES).toUpperCase() }), OBJECT_BYTES],
  ])('answers the contract 400 for %s', async (_label, target, payload) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await serviceHeaders('migration')), ...OCTET_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it('reads the stored bytes back as an octet stream', async () => {
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'image/png' });
    t.db.respond(/FROM "content"\."file_object" WHERE "object_key" = \$1/, [objectRow()]);
    const res = await call({ method: 'GET', url: `${url}?key=${encodeURIComponent(key)}`, headers: await serviceHeaders('migration') });
    expect({ status: res.statusCode, type: res.headers['content-type'], bytes: res.rawPayload }).toEqual({
      status: 200,
      type: 'application/octet-stream',
      bytes: OBJECT_BYTES,
    });
  });

  it.each<[string, string, number]>([
    ['a key no row records', `${TENANT_B.tenantId}/${FILE_MISSING}.png`, 404],
    ['a key outside the contract pattern', `${TENANT_A.tenantId}/../${FILE_A}.png`, 400],
  ])('answers %s with the contract %i', async (_label, objectKey, status) => {
    const res = await call({ method: 'GET', url: `${url}?key=${encodeURIComponent(objectKey)}`, headers: await serviceHeaders('migration') });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', async () => ({}), 401],
    ['another service', () => serviceHeaders('people'), 403],
  ])('refuses %s with the contract %i', async (_label, headers, status) => {
    const res = await call({ method: 'POST', url: putUrl(), headers: { ...(await headers()), ...OCTET_TYPE }, payload: OBJECT_BYTES });
    expect(res.statusCode).toBe(status);
  });
});

describe('signed file downloads', () => {
  const filePool = poolTenantExpectation(TENANT_A, 'file');
  const key = `${filePool}/${FILE_A}.pdf`;
  const downloadUrl = (fileId: string, query = ''): string => `/v1/sites/${SITE_A}/files/${fileId}/download-url${query}`;
  const admin = () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser, Roles.siteAdmin] });
  /** Answers the file read of FILE_A with a PDF named `report.pdf`. */
  const seedFile = (): void => {
    t.db.respond(/ FROM "content"\."file" WHERE /, [
      { fileid: FILE_A, siteid: SITE_A, filename: 'report.pdf', contenttype: 'application', contentsubtype: 'pdf', fileext: 'pdf' },
    ]);
  };

  it('issues a 900 s SignedUrl that streams the stored bytes under the signed disposition', async () => {
    seedFile();
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'application/pdf' });
    const res = await call({ method: 'GET', url: downloadUrl(FILE_A, '?method=inline'), headers: await admin() });
    const body = res.json() as { url: string; expiresAt: string };
    expect({ status: res.statusCode, expiresAt: body.expiresAt }).toEqual({
      status: 200,
      expiresAt: new Date(TEST_CLOCK.now().getTime() + 900_000).toISOString(),
    });
    expect(body.url.startsWith(`/opt2/files/content-files/${filePool}/${FILE_A}.pdf?expires=`)).toBe(true);

    const file = await call({ method: 'GET', url: body.url });
    expect({ status: file.statusCode, type: file.headers['content-type'], disposition: file.headers['content-disposition'], bytes: file.rawPayload }).toEqual({
      status: 200,
      type: 'application/pdf',
      disposition: 'inline;filename="report.pdf"',
      bytes: OBJECT_BYTES,
    });
  });

  it.each<[string, () => void, string, number]>([
    ['a file id no row records', () => undefined, downloadUrl(FILE_MISSING), 404],
    ['a stored row whose rendition is not stored', seedFile, downloadUrl(FILE_A, '?variant=_small'), 404],
    ['a file id that is not a CF UUID', () => undefined, downloadUrl('not-a-file-id'), 404],
    ['a variant leaving the key’s directory', seedFile, downloadUrl(FILE_A, `?variant=${encodeURIComponent('_x/../y')}`), 400],
    ['a method outside the enum', seedFile, downloadUrl(FILE_A, '?method=download'), 400],
  ])('answers %s with the contract %i', async (_label, seed, url, status) => {
    seed();
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'application/pdf' });
    const res = await call({ method: 'GET', url, headers: await admin() });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, () => Promise<Record<string, string>>, string, number]>([
    ['no credential', async () => ({}), SITE_A, 401],
    ['a system user without Site Manager access', () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser] }), SITE_A, 403],
    ['a tenant-b site admin naming tenant-a', () => userHeaders({ sub: USER_ID, site: SITE_B, roles: [Roles.siteAdmin] }), SITE_A, 403],
  ])('refuses %s with the contract %i', async (_label, headers, site, status) => {
    const res = await call({ method: 'GET', url: `/v1/sites/${site}/files/${FILE_A}/download-url`, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, () => Promise<string>, number]>([
    ['a tampered signature', async () => (await t.storage.signedUrl(CONTENT_FILES_BUCKET, key)).replace(/sig=[0-9a-f]/, (m) => `sig=${m.endsWith('0') ? '1' : '0'}`), 403],
    ['an expired signature', () => t.storage.signedUrl(CONTENT_FILES_BUCKET, key, { expiresS: -1 }), 403],
    ['a malformed signature', async () => `/opt2/files/content-files/${key}?expires=1&sig=xyz`, 403],
    ['a signed key that stores nothing', () => t.storage.signedUrl(CONTENT_FILES_BUCKET, `${filePool}/${FILE_MISSING}.pdf`), 404],
  ])('answers getLocalContentFile for %s with the contract %i', async (_label, signed, status) => {
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'application/pdf' });
    const res = await call({ method: 'GET', url: await signed() });
    expect(res.statusCode).toBe(status);
  });
});

describe('migration handlers over the content mappings', () => {
  const migration = (): Promise<Record<string, string>> => serviceHeaders('migration');

  it('answers the position', async () => {
    const res = await call({ method: 'GET', url: '/internal/v1/migration/position', headers: await migration() });
    expect({ status: res.statusCode, owner: (res.json() as Json).owner }).toEqual({ status: 200, owner: SERVICE });
  });

  it('exports the content.file unit with the object manifest of content.file_object', async () => {
    const row = { object_key: `${TENANT_A.tenantId}/${FILE_A}.png`, size: '23', sha256: sha256(OBJECT_BYTES), content_type: 'image/png' };
    t.db.respond(/^SELECT "object_key", .* FROM "content"\."file_object" ORDER BY/, [row, { ...row, object_key: `${TENANT_A.tenantId}/${FILE_A}_small.png`, content_type: null }]);
    const res = await call({ method: 'GET', url: `/internal/v1/migration/export?unit=content.file&tenantId=${TENANT_A.tenantId}`, headers: await migration() });
    const body = res.json() as Json;
    expect({ status: res.statusCode, tables: (body.tables as Json[]).map((table) => table.legacyTable), objects: body.objects }).toEqual({
      status: 200,
      tables: ['tfiles'],
      objects: [
        { key: row.object_key, size: 23, sha256: row.sha256, contentType: 'image/png' },
        { key: `${TENANT_A.tenantId}/${FILE_A}_small.png`, size: 23, sha256: row.sha256 },
      ],
    });
  });

  it.each(['content.comment', 'content.commenter', 'content.content_stats', 'content.content_rating'])(
    'exports the %s unit as the tables its content mappings declare',
    async (unit) => {
      const res = await call({ method: 'GET', url: `/internal/v1/migration/export?unit=${unit}&tenantId=${TENANT_A.tenantId}`, headers: await migration() });
      const tables = ((res.json() as Json).tables as Json[]).map((table) => [table.legacyTable, table.targetTable]);
      expect({ status: res.statusCode, tables }).toEqual({
        status: 200,
        tables: mappings.filter((mapping) => mapping.unit === unit).map((mapping) => [mapping.legacyTable, mapping.targetTable]),
      });
    },
  );

  it.each<[string, string, number]>([
    ['the changes after the start', `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`, 200],
    ['a malformed changes cursor', `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}&after=x`, 400],
    ['an export without a unit', `/internal/v1/migration/export?tenantId=${TENANT_A.tenantId}`, 400],
    ['an export of a unit the service does not own', `/internal/v1/migration/export?unit=people.person&tenantId=${TENANT_A.tenantId}`, 400],
  ])('answers %s with the contract %i', async (_label, target, status) => {
    const res = await call({ method: 'GET', url: target, headers: await migration() });
    expect(res.statusCode).toBe(status);
  });

  it('lists and records feed watermarks', async () => {
    const stored = { legacy_table: 'tcontentcomments', direction: 'forward', snapshot_seq: '3', backup_lsn: null, finished_at: '2026-06-30T11:00:00.000' };
    t.db.respond(/FROM "content"\."migration_watermark"/, [stored]);
    t.db.respond(/^INSERT INTO "content"\."migration_watermark"/, [stored]);
    const listed = await call({ method: 'GET', url: '/internal/v1/migration/watermark', headers: await migration() });
    const recorded = await call({
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      headers: { ...(await migration()), ...JSON_TYPE },
      payload: { legacyTable: 'tcontentcomments', direction: 'forward', snapshotSeq: 3, finishedAt: '2026-06-30 11:00:00' },
    });
    const record = { legacyTable: 'tcontentcomments', direction: 'forward', snapshotSeq: 3, backupLsn: null, finishedAt: '2026-06-30T11:00:00.000' };
    expect([listed.statusCode, listed.json(), recorded.statusCode, recorded.json()]).toEqual([200, [record], 200, record]);
  });

  it('reads the unit gates of this owner', async () => {
    t.db.setGate('content.comment', { state: 'closed', holder_id: 'window-1', phase: 'executing' });
    const res = await call({
      method: 'POST',
      url: '/internal/v1/migration/gate',
      headers: { ...(await migration()), ...JSON_TYPE },
      payload: { op: 'status', units: ['content.comment', 'content.content_stats'] },
    });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: {
        units: [
          { unit: 'content.comment', state: 'closed', holderId: 'window-1', phase: 'executing' },
          { unit: 'content.content_stats', state: 'open', holderId: null, phase: 'quiet' },
        ],
      },
    });
  });

  it.each<[string, string, Json]>([
    ['an apply batch without rows', '/internal/v1/migration/apply', { batchId: 'b-1', origin: 'backfill', legacyTable: 'tcontentstats', tenantId: TENANT_A.tenantId, columns: [{ name: 'contentID', type: 's' }], rows: [] }],
    ['a watermark without its finish time', '/internal/v1/migration/watermark', { legacyTable: 'tfiles', direction: 'forward' }],
    ['an unknown gate operation', '/internal/v1/migration/gate', { op: 'read' }],
  ])('answers the contract 400 for %s', async (_label, target, payload) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await migration()), ...JSON_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', async () => ({}), 401],
    ['the operator', () => serviceHeaders('operator'), 403],
  ])('refuses %s with the contract %i', async (_label, headers, status) => {
    const res = await call({ method: 'GET', url: '/internal/v1/migration/position', headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('push subscriptions', () => {
  const site = registryPayloads().find((payload) => payload.siteId === SITE_A);
  /** A contract-valid tenant-a envelope per subscription. */
  const ENVELOPES: Readonly<Record<string, () => EventEnvelope>> = {
    [SITE_CHANGED_SUBSCRIPTION]: () => testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload: site }),
    [GROUP_CHANGED_SUBSCRIPTION]: () =>
      testEnvelope({
        topic: GROUP_CHANGED_TOPIC,
        tenantId: TENANT_A.tenantId,
        aggregateId: GROUP_ID,
        payload: { groupId: GROUP_ID, siteId: SITE_A, groupName: 'Editors', type: 1, isPublic: 0, poolTenantId: TENANT_A.tenantId, deleted: false },
      }),
    [PERMISSION_CHANGED_SUBSCRIPTION]: () =>
      testEnvelope({
        topic: PERMISSION_CHANGED_TOPIC,
        tenantId: TENANT_A.tenantId,
        aggregateType: 'group',
        aggregateId: GROUP_ID,
        payload: { groupId: GROUP_ID, siteId: SITE_A, rows: [] },
      }),
    [MEMBERSHIP_CHANGED_SUBSCRIPTION]: () =>
      testEnvelope({
        topic: MEMBERSHIP_CHANGED_TOPIC,
        tenantId: TENANT_A.tenantId,
        aggregateType: 'user',
        aggregateId: USER_ID,
        payload: { userId: USER_ID, siteId: SITE_A, groupIds: [] },
      }),
  };
  const SUBSCRIPTIONS = Object.keys(ENVELOPES);
  const envelopeOf = (subscription: string): EventEnvelope => {
    const build = ENVELOPES[subscription];
    if (build === undefined) throw new TypeError(`No envelope for ${subscription}`);
    return build();
  };
  /** Holds a push answer to the subscription's contract operation. */
  const held = (subscription: string, res: InjectResponse): InjectResponse => {
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'POST',
      path: `/internal/v1/events/${subscription}`,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  };

  it.each(SUBSCRIPTIONS)('acknowledges an applied, a repeated and a dead-lettered delivery to %s with the contract 204', async (subscription) => {
    const envelope = envelopeOf(subscription);
    const applied = held(subscription, await pushTo(t.app, subscription, envelope));
    const repeated = held(subscription, await pushTo(t.app, subscription, envelope));
    const invalid = held(subscription, await pushTo(t.app, subscription, { ...envelopeOf(subscription), payload: { unexpected: true } }));
    expect([applied.statusCode, repeated.statusCode, invalid.statusCode]).toEqual([204, 204, 204]);
    expect(t.publisher.deadLetters(subscription)).toHaveLength(1);
    // The service declares no event contract of its own, so a delivery publishes nothing but its dead letter.
    expect(t.publisher.published).toEqual([]);
  });

  it.each(SUBSCRIPTIONS)('answers the contract 400 nack for a body that is not a push delivery to %s', async (subscription) => {
    const res = await t.app.inject({ method: 'POST', url: `/internal/v1/events/${subscription}?key=opt2-test-push-key`, headers: JSON_TYPE, payload: { data: 'x' } });
    expect(held(subscription, res).statusCode).toBe(400);
  });

  it.each(SUBSCRIPTIONS)('refuses a delivery to %s without the push key with the contract 401', async (subscription) => {
    const body = buildPushBody({ data: encodeEnvelope(envelopeOf(subscription)), messageId: randomUUID(), subscription });
    const res = await t.app.inject({ method: 'POST', url: `/internal/v1/events/${subscription}`, headers: JSON_TYPE, payload: { ...body } });
    expect(held(subscription, res).statusCode).toBe(401);
  });
});

describe('site-monitor job steps', () => {
  const PUBLISH_PATH = '/internal/v1/jobs/publish-scheduled-changesets';
  const FEED_PATH = '/internal/v1/jobs/feed-auto-import';
  const stepTask = (queue: string, step: string, tenantId: string | null = null): Json => ({
    queue,
    name: `${queue}-1782820800`,
    tenantId,
    payload: { step, theTime: '2026-06-30T12:00:00.000', lastMonitored: '2026-06-30T11:45:00.000' },
  });

  it('publishes the due change sets of every registered tenant, skipping one awaiting approval', async () => {
    t.db.respond(/FROM "content"\."changeset" WHERE tenant_id = \$1 AND published = 0 /, (params) => (params[0] === TENANT_A.tenantId ? [{ changesetid: CHANGESET_1 }] : []));
    t.db.respond(/ AS pending FROM /, [{ pending: 1 }]);
    const res = await call({
      method: 'POST',
      url: PUBLISH_PATH,
      headers: { ...(await tasksHeaders(PUBLISH_PATH)), ...JSON_TYPE },
      payload: stepTask('content-scheduled-publish', 'publishScheduledChangesets'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      step: 'publishScheduledChangesets',
      changesets: [{ tenantId: TENANT_A.tenantId, siteId: SITE_A, changesetId: CHANGESET_1, published: false }],
    });
  });

  it('imports the remote feeds of the ?siteid= site', async () => {
    const res = await call({
      method: 'POST',
      url: `${FEED_PATH}?siteid=${SITE_A}`,
      headers: { ...(await tasksHeaders(FEED_PATH)), ...JSON_TYPE },
      payload: stepTask('content-feed-import', 'feedAutoImport'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ step: 'feedAutoImport', siteId: SITE_A, feeds: 0 });
  });

  it.each<[string, string, Json]>([
    ['a feed step without a site', FEED_PATH, stepTask('content-feed-import', 'feedAutoImport')],
    ['a task body carrying a tenant', PUBLISH_PATH, stepTask('content-scheduled-publish', 'publishScheduledChangesets', TENANT_A.tenantId)],
  ])('answers the contract 400 to %s', async (_label, target, payload) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await tasksHeaders(target)), ...JSON_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a user token with the contract 401', async () => {
    const res = await call({
      method: 'POST',
      url: PUBLISH_PATH,
      headers: { ...(await userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.s2], s2: true })), ...JSON_TYPE },
      payload: stepTask('content-scheduled-publish', 'publishScheduledChangesets'),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('queue control', () => {
  it.each<[string, string, number, Json | undefined]>([
    ['pauses', `/internal/v1/task-queues/${OWN_QUEUE}/pause`, 200, { queue: OWN_QUEUE, service: SERVICE, paused: true, running: 0 }],
    ['resumes', `/internal/v1/task-queues/${OWN_QUEUE}/resume`, 200, { queue: OWN_QUEUE, service: SERVICE, paused: false }],
    ['refuses to ensure the non-recurring', `/internal/v1/task-queues/${OWN_QUEUE}/ensure`, 400, undefined],
    ['refuses to pause another service’s', '/internal/v1/task-queues/surveys-launch/pause', 400, undefined],
    ['refuses to pause an unknown', '/internal/v1/task-queues/no-such-queue/pause', 400, undefined],
  ])('%s queue with the contract answer', async (_label, target, status, body) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await serviceHeaders('operator')), ...JSON_TYPE }, payload: {} });
    expect(res.statusCode).toBe(status);
    if (body !== undefined) expect(res.json()).toEqual(body);
  });

  it('refuses a service that is neither migration nor operator with the contract 403', async () => {
    const res = await call({ method: 'POST', url: `/internal/v1/task-queues/${OWN_QUEUE}/pause`, headers: { ...(await serviceHeaders('programs-sites')), ...JSON_TYPE }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
