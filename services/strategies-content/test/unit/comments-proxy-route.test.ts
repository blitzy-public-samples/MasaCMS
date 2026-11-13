/** `commentsProxy.cfc` get, flag and getContentStats over a throwaway content schema: remote argument binding, bodies, tenancy, gates and the error page. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, collectRouteMatrix } from '@opt2/platform/auth';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, qualified } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
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
  type InjectResponse,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { getCommentValues } from '../../src/domain/comments.js';
import { CONTENT_CONFIG_DEFAULTS, type DomainDeps } from '../../src/domain/context.js';
import { STATS_DEFAULTS, statsValues } from '../../src/domain/stats.js';
import { muraJsonEncode } from '../../src/legacy/cfjson.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { COMMENTS_PROXY_PATH, registerCommentsProxyRoutes } from '../../src/routes/comments-proxy.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const SERVICE = 'strategies-content';
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const SITE = TENANT_A.siteId;
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const CONTENT = cfId('C', 1);
const NO_STATS = cfId('C', 2);
const COMMENT = cfId('M', 1);
const FLAGGED = cfId('M', 2);
const USER = cfId('U', 1);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;

let handle: ThrowawaySchema;
let stateDir: string;
let app: FastifyInstance;
let deps: DomainDeps;

/** A tenant-a anonymous visitor's token, as identity mints one for the gateway, with the gateway's invocation credential. */
async function visitorHeaders(site = SITE): Promise<Record<string, string>> {
  const [user, invocation] = await Promise.all([
    mintUserToken({ sub: '', site, roles: [] }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** Sends one proxy call and checks the answer against the contract. */
async function call(method: 'GET' | 'POST', query: string, opts: { headers?: Record<string, string>; payload?: string } = {}): Promise<InjectResponse> {
  const headers = opts.headers ?? (await visitorHeaders());
  const res = await app.inject({
    method,
    url: `${COMMENTS_PROXY_PATH}${query}`,
    headers: opts.payload === undefined ? headers : { ...FORM, ...headers },
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: COMMENTS_PROXY_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** The `get` body for `commentId` with the bean instance id the response carries, which every load draws afresh. */
async function expectedGetBody(body: string, commentId: string): Promise<string> {
  const instanceID = /"instanceid":"([^"]+)"/.exec(body)?.[1];
  const values = await getCommentValues(deps, TENANT_A.tenantId, commentId, { scheme: 'http' });
  return muraJsonEncode({ ...values, instanceID });
}

async function flagCount(commentId: string): Promise<number | null> {
  const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
    tx.query<{ flagcount: number | null }>(`SELECT flagcount FROM ${qualified(handle.schema, 'comment')} WHERE commentid = $1`, [commentId]),
  );
  return rows[0]?.flagcount ?? null;
}

describe.skipIf(!(await pgAvailable()))('commentsProxy routes', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-proxy-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-proxy-test', state: 'open' });
    const clock = fixedClock(NOW);
    const repository = createContentRepository({ clock, schema: handle.schema });
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    deps = { db, repository, clock, config: CONTENT_CONFIG_DEFAULTS };
    await withTenant(db, TENANT_A.tenantId, async (tx) => {
      const version = { siteid: SITE, type: 'Page', subtype: 'Default', moduleid: '00000000000000000000000000000000000', approved: 1, display: 1, active: 1 };
      await repository.content.insertVersion(tx, { ...version, contentid: CONTENT, contenthistid: cfId('H', 1), title: 'Commented' });
      await repository.content.insertVersion(tx, { ...version, contentid: NO_STATS, contenthistid: cfId('H', 2), title: 'Quiet' });
      const comment = { contentid: CONTENT, siteid: SITE, email: 'ann@x.test', entered: new Date(2026, 5, 1, 9, 0, 0), isapproved: 1, isspam: 0, isdeleted: 0, subscribe: 0 };
      await repository.comments.insertComment(tx, { ...comment, commentid: COMMENT, name: 'Ann', comments: 'First', url: 'ann.example', userid: USER, flagcount: 0 });
      await repository.comments.insertComment(tx, { ...comment, commentid: FLAGGED, name: 'Bob', comments: 'Second', flagcount: 2 });
    });

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-comments-proxy-'));
    await writeTestSecrets(stateDir);
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
      clock,
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerCommentsProxyRoutes(app, { domain: deps });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares GET and POST as the contract does: public on the service transport, the site checked by the handler', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url === COMMENTS_PROXY_PATH);
    expect(declared).toEqual(
      ['GET', 'POST'].map((method) => {
        const operation = OPENAPI.paths[COMMENTS_PROXY_PATH]?.[method.toLowerCase()] ?? {};
        expect(operation['x-opt2-public']).toBe(true);
        return { method, url: COMMENTS_PROXY_PATH, transport: operation['x-opt2-transport'], public: true, siteCheck: false };
      }),
    );
  });

  it('answers get with the comment bean values as Mura.json encodes them, in the legacy text/html content type', async () => {
    const res = await call('GET', `?method=get&commentID=${COMMENT}&siteid=${SITE}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.body).toContain(`"commentid":"${COMMENT}"`);
    expect(res.body).toContain('"url":"http://ann.example"');
    expect(res.body).toBe(await expectedGetBody(res.body, COMMENT));
  });

  it.each<[string, string, string | undefined, string]>([
    ['a url commentID over a form one', `?commentID=${COMMENT}`, `method=get&commentID=${FLAGGED}`, COMMENT],
    ['a url method over a form one', `?method=get&commentID=${FLAGGED}`, 'method=flag', FLAGGED],
    ['the method and argument names in any case', `?METHOD=%20Get%20&COMMENTID=${COMMENT}`, undefined, COMMENT],
    ['an argumentCollection member below the url', `?method=get&commentID=${COMMENT}&argumentCollection=${encodeURIComponent(JSON.stringify({ commentID: FLAGGED }))}`, undefined, COMMENT],
    ['an argumentCollection member alone', `?method=get&argumentCollection=${encodeURIComponent(JSON.stringify({ COMMENTID: 'x', commentid: FLAGGED }))}`, undefined, FLAGGED],
    ['invocation fields and `_` names ColdFusion leaves unbound', `?method=get&commentID=${COMMENT}&returnFormat=json&queryformat=row&_=1&_cf_nodebug=true`, undefined, COMMENT],
  ])('binds %s as ColdFusion does', async (_label, query, form, commentId) => {
    const res = await call(form === undefined ? 'GET' : 'POST', query, form === undefined ? {} : { payload: form });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(await expectedGetBody(res.body, commentId));
    expect(await flagCount(FLAGGED)).toBe(2);
  });

  it('binds an argumentCollection boolean as YES, as ColdFusion converts it', async () => {
    const res = await call('GET', `?method=get&argumentCollection=${encodeURIComponent('{"commentID":true}')}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"commentid":"YES"');
  });

  it('answers get of an unknown comment with a new bean holding the id', async () => {
    const res = await call('GET', '?method=get&commentID=ABC');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"commentid":"ABC"');
    expect(res.body).toContain('"isnew":1');
  });

  it('prefixes a schemeless url with https when the gateway forwarded an HTTPS request', async () => {
    const headers = { ...(await visitorHeaders()), 'x-forwarded-proto': 'HTTPS' };
    const res = await call('GET', `?method=get&commentID=${COMMENT}`, { headers });
    expect(res.body).toContain('"url":"https://ann.example"');
    const frontEnd = await call('GET', `?method=get&commentID=${COMMENT}`, { headers: { ...(await visitorHeaders()), 'front-end-https': 'yes' } });
    expect(frontEnd.body).toContain('"url":"https://ann.example"');
  });

  it('flags a comment with an empty body, adding one to its flag count, without CSRF or a signed-in user', async () => {
    const before = await flagCount(COMMENT);
    const res = await call('POST', '', { payload: `method=flag&commentID=${COMMENT}&siteid=${SITE}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(await flagCount(COMMENT)).toBe((before ?? 0) + 1);
  });

  it('answers getContentStats of an item without stats with the stats defaults, defaulting siteid to the token site', async () => {
    const res = await call('GET', `?method=getContentStats&contentID=${NO_STATS}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(muraJsonEncode(statsValues({ ...STATS_DEFAULTS, contentID: NO_STATS, siteID: SITE })));
  });

  it('counts the flagged item’s comments in getContentStats', async () => {
    const res = await call('GET', `?method=getcontentstats&contentid=${CONTENT}&siteid=${SITE}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"comments":2');
  });

  it.each<[string, 'GET' | 'POST', string, string | undefined]>([
    ['renderCommentsPage, which stays legacy-served', 'GET', `?method=renderCommentsPage&contentID=${CONTENT}`, undefined],
    ['no method', 'GET', `?commentID=${COMMENT}`, undefined],
    ['an empty method', 'GET', `?method=&commentID=${COMMENT}`, undefined],
    ['a repeated method', 'GET', `?method=get&method=flag&commentID=${COMMENT}`, undefined],
    ['an argument get does not declare', 'GET', `?method=get&commentID=${COMMENT}&contentID=${CONTENT}`, undefined],
    ['a form argument flag does not declare', 'POST', '', `method=flag&commentID=${COMMENT}&callback=cb`],
    ['no commentID', 'GET', '?method=flag', undefined],
    ['no contentID', 'GET', '?method=getContentStats', undefined],
    ['a JSON body, which binds nothing', 'POST', '', undefined],
    ['an argumentCollection that is not a JSON object', 'GET', `?method=get&commentID=${COMMENT}&argumentCollection=%5B1%5D`, undefined],
    ['an argumentCollection that is not JSON', 'GET', `?method=get&commentID=${COMMENT}&argumentCollection=x`, undefined],
    ['an argumentCollection struct member', 'GET', `?method=get&argumentCollection=${encodeURIComponent('{"commentID":{"a":1}}')}`, undefined],
    ['an argumentCollection null member', 'GET', `?method=get&argumentCollection=${encodeURIComponent('{"commentID":null}')}`, undefined],
    ['an argumentCollection undeclared member', 'GET', `?method=get&commentID=${COMMENT}&argumentCollection=${encodeURIComponent('{"foo":1}')}`, undefined],
  ])('answers %s with the ColdFusion error page and no write', async (label, method, query, form) => {
    const before = await flagCount(COMMENT);
    const res = label.startsWith('a JSON body')
      ? await app.inject({
          method,
          url: COMMENTS_PROXY_PATH,
          headers: { ...(await visitorHeaders()), 'content-type': 'application/json' },
          payload: JSON.stringify({ method: 'flag', commentID: COMMENT }),
        })
      : await call(method, query, form === undefined ? {} : { payload: form });
    expect(res.statusCode).toBe(500);
    expect(res.statusMessage).toBe('An Error Occurred');
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(await flagCount(COMMENT)).toBe(before);
  });

  it.each<[string, string, string | undefined]>([
    ['a url siteid of another site', `?method=flag&commentID=${COMMENT}&siteid=${TENANT_B.siteId}`, undefined],
    ['a form siteid of another site', '', `method=flag&commentID=${COMMENT}&siteid=${TENANT_B.siteId}`],
    ['a url siteid of another site over the token site in the form', `?siteid=${TENANT_B.siteId}`, `method=flag&commentID=${COMMENT}&siteid=${SITE}`],
  ])('refuses %s with 403 and no write', async (_label, query, form) => {
    const before = await flagCount(COMMENT);
    const res = await call('POST', query, form === undefined ? {} : { payload: form });
    expect(res.statusCode).toBe(403);
    expect(await flagCount(COMMENT)).toBe(before);
  });

  it('serves a form siteid of another site when the url names the token site, as the url value binds', async () => {
    const res = await call('POST', `?siteid=${SITE}`, { payload: `method=getContentStats&contentID=${NO_STATS}&siteid=${TENANT_B.siteId}` });
    expect(res.statusCode).toBe(200);
  });

  it('answers a call without a user token with 401, since it has no tenant', async () => {
    const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` };
    const res = await call('GET', `?method=get&commentID=${COMMENT}`, { headers });
    expect(res.statusCode).toBe(401);
  });

  it('reads only the token tenant: a tenant-b visitor does not find a tenant-a comment', async () => {
    const res = await call('GET', `?method=get&commentID=${COMMENT}`, { headers: await visitorHeaders(TENANT_B.siteId) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"isnew":1');
  });

  it('fails a flag closed with the legacy 503 while its units are legacy-authoritative', async () => {
    const before = await flagCount(COMMENT);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-proxy-legacy' });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-proxy-legacy', state: 'legacy' });
    try {
      const res = await call('GET', `?method=flag&commentID=${COMMENT}`);
      expect(res.statusCode).toBe(503);
    } finally {
      await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-proxy-reopen', allowLegacy: true });
      await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-proxy-reopen', state: 'open' });
    }
    expect(await flagCount(COMMENT)).toBe(before);
  });
});
