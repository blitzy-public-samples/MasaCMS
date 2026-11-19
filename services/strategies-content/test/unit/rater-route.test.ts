/** `rater/ajax/saveRate.cfm` over a throwaway content schema: form binding, the saved rating and stats, the answer, tenancy, gates and onError's pages. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, collectRouteMatrix } from '@opt2/platform/auth';
import { LEGACY_ERROR_PAGE_HTML, LegacyFaultError, javaTrim, legacyDebugPageHtml } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, qualified } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withTenant, type TenantDb } from '@opt2/platform/tenancy';
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
import { CONTENT_CONFIG_DEFAULTS, type DomainDeps } from '../../src/domain/context.js';
import { esapiEncode } from '../../src/legacy/admin-markup.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { RATER_SAVE_PATH, registerRaterRoutes } from '../../src/routes/rater.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const SERVICE = 'strategies-content';
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const LATER = new Date(2026, 5, 30, 11, 2, 7, 456);
const SITE = TENANT_A.siteId;
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const [U1, U2, U3] = [1, 2, 3].map((n) => cfId('U', n)) as [string, string, string];
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
/** Own oracle's `MURA_DATABASE`, which SQL Server's messages qualify `tcontentratings` with. */
const DATABASE = 'muradb_c60';
const DRIVER = '[Macromedia][SQLServer JDBC Driver][SQLServer]';
const NOT_NUMERIC = new LegacyFaultError('The RATE argument passed to the saveRate function is not of type numeric.', 'Application', {
  detail:
    'If the component name is specified as a type of this argument, it is possible that either a definition file for the component cannot be found or is not accessible.',
});
const INT_CONVERSION = new LegacyFaultError(`${DRIVER}Arithmetic overflow error converting expression to data type int.`, 'java.sql.SQLDataException', {
  errorCode: '8115',
});
/** Msg 1007 for the decimal `literal`. */
const precision = (literal: string): LegacyFaultError =>
  new LegacyFaultError(`${DRIVER}The number '${literal}' is out of the range for numeric representation (maximum precision 38).`, 'java.sql.SQLDataException', {
    errorCode: '1007',
  });
/** Msg 515 for the NULL `column`. */
const nullFault = (column: string): LegacyFaultError =>
  new LegacyFaultError(
    `${DRIVER}Cannot insert the value NULL into column '${column}', table '${DATABASE}.dbo.tcontentratings'; column does not allow nulls. INSERT fails.`,
    'java.sql.SQLIntegrityConstraintViolationException',
    { errorCode: '515' },
  );
/** Msg 2628 for `column`, quoting `value`. */
const truncation = (column: string, value: string): LegacyFaultError =>
  new LegacyFaultError(
    `${DRIVER}String or binary data would be truncated in table '${DATABASE}.dbo.tcontentratings', column '${column}'. Truncated value: '${value}'.`,
    'java.sql.SQLException',
    { errorCode: '2628' },
  );

// Own oracle (site default, users U1 to U3 of one item): 4 by U1, then 1 by U2, then 5 by U1 again, then 2.7 by U3.
const ORACLE_FIRST =
  '{"recordcount":1,"columnlist":"DOWNVOTES,THEAVG,THECOUNT,UPVOTES","data":{"DOWNVOTES":[""],"THEAVG":[4],"THECOUNT":[1],"UPVOTES":[""]}}';
const ORACLE_SECOND =
  '{"recordcount":1,"columnlist":"DOWNVOTES,THEAVG,THECOUNT,UPVOTES","data":{"DOWNVOTES":[1],"THEAVG":[2],"THECOUNT":[2],"UPVOTES":[1]}}';
const ORACLE_UPDATED =
  '{"recordcount":1,"columnlist":"DOWNVOTES,THEAVG,THECOUNT,UPVOTES","data":{"DOWNVOTES":[1],"THEAVG":[3],"THECOUNT":[2],"UPVOTES":[1]}}';
const ORACLE_TRUNCATED =
  '{"recordcount":1,"columnlist":"DOWNVOTES,THEAVG,THECOUNT,UPVOTES","data":{"DOWNVOTES":[1],"THEAVG":[2],"THECOUNT":[3],"UPVOTES":[2]}}';

let handle: ThrowawaySchema;
let stateDir: string;
let app: FastifyInstance;
/** The service with configBean `debuggingEnabled` false. */
let quietApp: FastifyInstance;
let repository: ContentRepository;
let current = NOW;
const clock: Clock = { now: () => current };

/** A visitor's token of `site`, as identity mints one for the gateway, with the gateway's invocation credential. */
async function visitorHeaders(site = SITE): Promise<Record<string, string>> {
  const [user, invocation] = await Promise.all([
    mintUserToken({ sub: '', site, roles: [] }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** Posts `payload` to the rater and checks the answer against the contract. */
async function save(payload: string, opts: { headers?: Record<string, string>; query?: string; contentType?: string } = {}): Promise<InjectResponse> {
  const headers = { 'content-type': opts.contentType ?? FORM['content-type'], ...(opts.headers ?? (await visitorHeaders())) };
  const res = await app.inject({ method: 'POST', url: `${RATER_SAVE_PATH}${opts.query ?? ''}`, headers, payload });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: RATER_SAVE_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** The rater form for `contentId`. */
function rateForm(contentId: string, userId: string, rate: string, site = SITE): string {
  return new URLSearchParams({ contentID: contentId, siteID: site, userID: userId, rate }).toString();
}

/** The item's stored ratings in `tenantId`, by user. */
async function ratings(contentId: string, tenantId = TENANT_A.tenantId): Promise<Array<{ userid: string; siteid: string; rate: number | null; entered: Date | null }>> {
  const { rows } = await withTenant(handle.app, tenantId, (tx) =>
    tx.query<{ userid: string; siteid: string; rate: number | null; entered: Date | null }>(
      `SELECT rtrim(userid) AS userid, rtrim(siteid) AS siteid, rate, entered FROM ${qualified(handle.schema, 'content_rating')} WHERE contentid = $1 ORDER BY userid`,
      [contentId],
    ),
  );
  return rows;
}

/** The item's stored vote stats in tenant-a, or undefined without a row. */
async function votes(contentId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
    tx.query(`SELECT rating, totalvotes, upvotes, downvotes, views, comments FROM ${qualified(handle.schema, 'content_stats')} WHERE contentid = $1`, [contentId]),
  );
  return rows[0];
}

/** The changelog rows naming `contentId` in tenant-a, in write order. */
async function changes(contentId: string): Promise<Array<{ table: string; op: string; origin: string; actor_service: string }>> {
  const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
    tx.query<{ table: string; op: string; origin: string; actor_service: string }>(
      `SELECT "table", op, origin, actor_service FROM ${qualified(handle.schema, 'changelog')} WHERE strpos(key, $1) > 0 ORDER BY seq`,
      [contentId],
    ),
  );
  return rows;
}

/** Changelog rows of both tenants and of `others`: every write logs one, so an unchanged count means nothing was written. */
async function writeCount(...others: string[]): Promise<number> {
  let total = 0;
  for (const tenantId of [TENANT_A.tenantId, TENANT_B.tenantId, ...others]) {
    const { rows } = await withTenant(handle.app, tenantId, (tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${qualified(handle.schema, 'changelog')}`),
    );
    total += rows[0]?.n ?? 0;
  }
  return total;
}

/** Stores a rating row in tenant-a as legacy left it. */
async function seedRating(contentId: string, userId: string, rate: number): Promise<void> {
  await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
    repository.platform.insert(tx, 'content_rating', { contentid: contentId, userid: userId, siteid: SITE, rate, entered: NOW }),
  );
}

/** Expects onError's page at 500 `An Error Occurred`: `body`, the debugging-off error.html unless given. */
function expectErrorPage(res: InjectResponse, body: string = LEGACY_ERROR_PAGE_HTML): void {
  expect({ status: res.statusCode, message: res.statusMessage, type: res.headers['content-type'], body: res.body }).toEqual({
    status: 500,
    message: 'An Error Occurred',
    type: 'text/html;charset=UTF-8',
    body,
  });
}

/** Expects onError's debugging-on page naming `fault`. */
function expectFaultPage(res: InjectResponse, fault: LegacyFaultError): void {
  expectErrorPage(res, legacyDebugPageHtml(fault, (text) => esapiEncode('html', text)));
}

/** Expects onError's debugging-on page for the undefined form field `name`, as the template reads it. */
function expectUndefinedFieldPage(res: InjectResponse, name: string): void {
  const message = `Element ${name} is undefined in FORM.`;
  expectErrorPage(res, legacyDebugPageHtml(new LegacyFaultError(message), (text) => text));
  expect(res.body).toContain(`<h1>500 Error</h1><h2>${message}<br /></h2><h3>Type:Expression<br /></h3></div>`);
}

describe.skipIf(!(await pgAvailable()))('rater save route', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'rater-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'rater-test', state: 'open' });
    repository = createContentRepository({ clock, schema: handle.schema });
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    const deps: DomainDeps = { db, repository, clock, config: CONTENT_CONFIG_DEFAULTS };
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-rater-'));
    await writeTestSecrets(stateDir);
    /** The service with the rater routes, under the given configBean `debuggingEnabled` or the settings template's. */
    const start = async (debuggingEnabled?: boolean): Promise<FastifyInstance> => {
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
          OPT2_STATE_DIR: stateDir,
          TZ: 'UTC',
        }),
        clock,
        verifierOverride: testVerifier(SERVICE),
        pool: db,
        logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
      });
      registerRaterRoutes(service, { domain: deps }, debuggingEnabled, DATABASE);
      await service.ready();
      return service;
    };
    // Unset, MURA_DEBUGGINGENABLED takes the settings template's `debuggingenabled=true`.
    vi.stubEnv('MURA_DEBUGGINGENABLED', undefined);
    app = await start();
    vi.unstubAllEnvs();
    quietApp = await start(false);
  });

  afterAll(async () => {
    await quietApp?.opt2.shutdown();
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares GET and POST as the contract does: public on the service transport, the site checked by the handler', () => {
    const methods = ['GET', 'POST'] as const;
    const operations = methods.map((method) => OPENAPI.paths[RATER_SAVE_PATH]?.[method.toLowerCase()] ?? {});
    expect(operations.map((operation) => operation['x-opt2-public'])).toEqual([true, true]);
    expect(collectRouteMatrix(app).routes.filter((route) => route.url === RATER_SAVE_PATH)).toEqual(
      methods.map((method, n) => ({ method, url: RATER_SAVE_PATH, transport: operations[n]?.['x-opt2-transport'], public: true, siteCheck: false })),
    );
  });

  it('saves a new rating and answers the average as Mura.json encodes the getAvgRating query, in the legacy text/html content type', async () => {
    const item = cfId('C', 1);
    const res = await save(rateForm(item, U1, '4'));
    expect({ status: res.statusCode, type: res.headers['content-type'], generator: res.headers.generator, body: res.body }).toEqual({
      status: 200,
      type: 'text/html;charset=UTF-8',
      generator: 'Masa CMS 7.6.1',
      body: ORACLE_FIRST,
    });
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
    expect(await ratings(item)).toEqual([{ userid: U1, siteid: SITE, rate: 4, entered: NOW }]);
    // Own oracle: the item's new stats row after one rating of 4.
    expect(await votes(item)).toEqual({ rating: 4, totalvotes: 1, upvotes: 1, downvotes: 0, views: 0, comments: 0 });
  });

  it("updates the rater's existing rating and its entered time, then refreshes the item's stats votes", async () => {
    const item = cfId('C', 2);
    expect((await save(rateForm(item, U1, '4'))).body).toBe(ORACLE_FIRST);
    expect((await save(rateForm(item, U2, '1'))).body).toBe(ORACLE_SECOND);
    await withTenant(handle.app, TENANT_A.tenantId, (tx) => repository.stats.upsertStats(tx, { contentId: item, siteId: SITE, views: 7, comments: 2 }));
    current = LATER;
    try {
      const res = await save(rateForm(item, U1, '5'));
      expect({ status: res.statusCode, body: res.body }).toEqual({ status: 200, body: ORACLE_UPDATED });
    } finally {
      current = NOW;
    }
    expect(await ratings(item)).toEqual([
      { userid: U1, siteid: SITE, rate: 5, entered: LATER },
      { userid: U2, siteid: SITE, rate: 1, entered: NOW },
    ]);
    // Own oracle after the same three saves: rating 3.0, 2 votes, 1 up, 1 down; the stats bean keeps the other columns.
    expect(await votes(item)).toEqual({ rating: 3, totalvotes: 2, upvotes: 1, downvotes: 1, views: 7, comments: 2 });
  });

  it('truncates a fractional rate to the stored integer, as SQL Server does', async () => {
    const item = cfId('C', 3);
    await seedRating(item, U1, 5);
    await seedRating(item, U2, 1);
    const res = await save(rateForm(item, U3, '2.7'));
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 200, body: ORACLE_TRUNCATED });
    expect((await ratings(item)).map((row) => [row.userid, row.rate])).toEqual([
      [U1, 5],
      [U2, 1],
      [U3, 2],
    ]);
    expect(await votes(item)).toMatchObject({ rating: 2, totalvotes: 3, upvotes: 2, downvotes: 1 });
  });

  it("binds the form fields in any case and updates the rating SQL Server's case-insensitive match finds", async () => {
    const item = cfId('C', 4);
    await seedRating(item, U1, 2);
    // Own oracle: `contentid`, `SITEID` and `USERID` spelled in another case update the stored row.
    const res = await save(`contentid=${item.toLowerCase()}&SITEID=${SITE.toUpperCase()}&USERID=${U1.toLowerCase()}&RATE=4`);
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 200, body: ORACLE_FIRST });
    expect((await ratings(item)).map((row) => [row.userid, row.siteid, row.rate])).toEqual([[U1, SITE, 4]]);
  });

  it("updates every stored row the rating's case-insensitive match finds, as rateBean's update does", async () => {
    const item = cfId('C', 5);
    await seedRating(item, U1, 2);
    await seedRating(item, U1.toLowerCase(), 3);
    const res = await save(rateForm(item, U1, '4'));
    expect(res.statusCode).toBe(200);
    expect((await ratings(item)).map((row) => row.rate)).toEqual([4, 4]);
  });

  it('reads the form from a multipart body, as the form scope holds its fields', async () => {
    const item = cfId('C', 6);
    const boundary = 'opt2-rater-boundary';
    const fields = { contentID: item, siteID: SITE, userID: U1, rate: '4' };
    const payload = `${Object.entries(fields)
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join('')}--${boundary}--\r\n`;
    const res = await save(payload, { contentType: `multipart/form-data; boundary=${boundary}` });
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 200, body: ORACLE_FIRST });
  });

  it('rates the item a space-padded contentID names, as the start-up scan trims the form fields getAvgRating reads', async () => {
    const item = cfId('C', 17);
    expect((await save(rateForm(item, U1, '3'))).statusCode).toBe(200);
    const res = await save(rateForm(` ${item} `, U2, '4'));
    // Own oracle: SQL Server's int avg of 3 and 4 is 3, with no up or down vote rows.
    expect({ status: res.statusCode, body: res.body }).toEqual({
      status: 200,
      body: '{"recordcount":1,"columnlist":"DOWNVOTES,THEAVG,THECOUNT,UPVOTES","data":{"DOWNVOTES":[""],"THEAVG":[3],"THECOUNT":[2],"UPVOTES":[""]}}',
    });
    expect((await ratings(item)).map((row) => [row.userid, row.rate])).toEqual([
      [U1, 3],
      [U2, 4],
    ]);
    expect(await votes(item)).toMatchObject({ rating: 3, totalvotes: 2, upvotes: 2, downvotes: 0 });
  });

  it("answers a GET with legacy's debug page of the undefined form.contentID and writes nothing, as its url fields fill no form scope", async () => {
    const before = await writeCount();
    const res = await app.inject({ method: 'GET', url: `${RATER_SAVE_PATH}?${rateForm(cfId('C', 18), U1, '4')}`, headers: await visitorHeaders() });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: RATER_SAVE_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    expectUndefinedFieldPage(res, 'CONTENTID');
    expect(await writeCount()).toBe(before);
  });

  it("answers legacy's debug page of the first of contentID, siteID, userID and rate missing from the form, with nothing written", async () => {
    const item = cfId('C', 7);
    const complete = { contentID: item, siteID: SITE, userID: U1, rate: '4' };
    const before = await writeCount();
    for (const missing of Object.keys(complete)) {
      const fields = Object.entries(complete).filter(([name]) => name !== missing);
      expectUndefinedFieldPage(await save(new URLSearchParams(fields).toString()), missing.toUpperCase());
      // Own oracle: the template reads the form scope only, so the field in the query string still leaves it undefined.
      expectUndefinedFieldPage(
        await save(new URLSearchParams(fields).toString(), { query: `?${new URLSearchParams([[missing, complete[missing as keyof typeof complete]]]).toString()}` }),
        missing.toUpperCase(),
      );
    }
    // The template passes the fields in order, so the first undefined one fails the call.
    expectUndefinedFieldPage(await save(new URLSearchParams({ siteID: SITE, rate: '4' }).toString()), 'CONTENTID');
    expectUndefinedFieldPage(await save(new URLSearchParams({ contentID: item, siteID: SITE }).toString()), 'USERID');
    // A JSON body fills no form scope.
    expectUndefinedFieldPage(await save(JSON.stringify(complete), { contentType: 'application/json' }), 'CONTENTID');
    expect(await writeCount()).toBe(before);
    expect(await ratings(item)).toEqual([]);
  });

  it('answers the error page for a missing form field when debugging is off, with nothing written', async () => {
    const before = await writeCount();
    const res = await quietApp.inject({
      method: 'POST',
      url: RATER_SAVE_PATH,
      headers: { ...FORM, ...(await visitorHeaders()) },
      payload: new URLSearchParams({ siteID: SITE, userID: U1, rate: '4' }).toString(),
    });
    expectErrorPage(res);
    expect(await writeCount()).toBe(before);
  });

  it("answers legacy's debug page of the numeric rate argument with nothing written for a rate it refuses", async () => {
    const item = cfId('C', 8);
    const before = await writeCount();
    // Own oracle: the `numeric` rate argument refuses each, the repeated field joined as `3,4`.
    for (const form of ['abc', '', '1d', '0x10', '1,000', '1e309'].map((rate) => rateForm(item, U1, rate)).concat(`${rateForm(item, U1, '3')}&rate=4`)) {
      expectFaultPage(await save(form), NOT_NUMERIC);
    }
    expect(await writeCount()).toBe(before);
  });

  // Own oracle: scratch captures saverate-rate-overflow, -negover, -exp10 and -digits39.
  it.each([
    ['3000000000', INT_CONVERSION],
    ['-2147483649', INT_CONVERSION],
    ['1e10', new LegacyFaultError(`${DRIVER}Arithmetic overflow error for type int, value = 10000000000.000000.`, 'java.sql.SQLDataException', { errorCode: '232' })],
    [`1${'0'.repeat(38)}`, precision(`1${'0'.repeat(38)}`)],
  ])("answers SQL Server's fault with nothing written for the rate %s, which it cannot store as an int", async (rate, fault) => {
    const before = await writeCount();
    expectFaultPage(await save(rateForm(cfId('C', 9), U1, rate)), fault);
    expect(await writeCount()).toBe(before);
  });

  // Own oracle: the headings after `<h1>500 Error</h1>` of scratch captures saverate-rate-overflow and -rate-nonnumeric.
  it.each([
    [
      '99999999999',
      '<h2>&#x5b;Macromedia&#x5d;&#x5b;SQLServer JDBC Driver&#x5d;&#x5b;SQLServer&#x5d;Arithmetic overflow error converting expression to data type int.<br /></h2>' +
        '<h3>Code:8115<br /></h3><h3>Type:java.sql.SQLDataException<br /></h3>',
    ],
    [
      'abc',
      '<h2>The RATE argument passed to the saveRate function is not of type numeric.<br /></h2><h3>Type:Application<br /></h3>' +
        '<h3>If the component name is specified as a type of this argument, it is possible that either a definition file for the component cannot be found or is not accessible.<br /></h3>',
    ],
  ])('prints the headings of the debug page legacy answers the rate %j with, esapi-encoded', async (rate, headings) => {
    const res = await save(rateForm(cfId('C', 9), U1, rate));
    expect(res.body.endsWith(`<h1>500 Error</h1>${headings}</div>`)).toBe(true);
  });

  it.each([
    ['contentID', ''],
    ['siteID', ''],
    ['userID', ''],
    ['contentID', '   '],
  ])("answers SQL Server's NULL insert fault with nothing written for the %s %j, which the rating insert binds as NULL once trimmed", async (field, value) => {
    const before = await writeCount();
    const fields = new URLSearchParams({ contentID: cfId('C', 10), siteID: SITE, userID: U1, rate: '4', [field]: value });
    expectFaultPage(await save(fields.toString()), nullFault(field));
    expect(await writeCount()).toBe(before);
  });

  // The token names the posted site, as identity mints it for the requested siteid.
  it.each([
    ['contentID', `${cfId('C', 19)}F`, cfId('C', 19)],
    ['userID', `${U1}F`, U1],
    ['siteID', 's'.repeat(26), 's'.repeat(25)],
  ])("answers SQL Server's truncation fault with nothing written for the %s %j, longer than its tcontentratings column", async (field, value, quoted) => {
    const form = { contentID: cfId('C', 19), siteID: SITE, userID: U1, rate: '4', [field]: value };
    const tenantId = tenantIdForSite(form.siteID);
    const before = await writeCount(tenantId);
    expectFaultPage(await save(new URLSearchParams(form).toString(), { headers: await visitorHeaders(form.siteID) }), truncation(field, quoted));
    expect(await writeCount(tenantId)).toBe(before);
  });

  // Own oracle: scratch captures saverate-cid36_digits41, -cid36_uidempty, -uid36_sid26, -cidempty_uid36, -cid36_rateover, -uidempty_rateover.
  it.each([
    ['a decimal of 41 digits before a long contentID', { contentID: 'X'.repeat(36), rate: `1${'0'.repeat(40)}` }, precision(`1${'0'.repeat(40)}`)],
    ['a long contentID before an empty userID', { contentID: 'X'.repeat(36), userID: ' ' }, truncation('contentID', 'X'.repeat(35))],
    ['a long userID before a long siteID', { userID: 'U'.repeat(36), siteID: 'S'.repeat(26) }, truncation('userID', 'U'.repeat(35))],
    ['an empty contentID before a long userID', { contentID: '', userID: 'U'.repeat(36) }, nullFault('contentID')],
    ['a long contentID before a rate outside int', { contentID: 'X'.repeat(36), rate: '99999999999' }, truncation('contentID', 'X'.repeat(35))],
    ['an empty userID before a rate outside int', { userID: ' ', rate: '99999999999' }, nullFault('userID')],
  ])('answers the fault SQL Server raises first for %s, as the statement compiles and then binds in insert order', async (_label, overrides, fault) => {
    const form = { contentID: cfId('C', 22), siteID: SITE, userID: U1, rate: '4', ...overrides };
    const before = await writeCount(tenantIdForSite(form.siteID));
    expectFaultPage(await save(new URLSearchParams(form).toString(), { headers: await visitorHeaders(form.siteID) }), fault);
    expect(await writeCount(tenantIdForSite(form.siteID))).toBe(before);
  });

  it("answers SQL Server's rate fault for an existing rating, whose update binds no id", async () => {
    const item = cfId('C', 23);
    await seedRating(item, U1, 2);
    const before = await writeCount();
    expectFaultPage(await save(rateForm(item, U1, '99999999999')), INT_CONVERSION);
    expect(await writeCount()).toBe(before);
    expect((await ratings(item)).map((row) => row.rate)).toEqual([2]);
  });

  it('answers the error page for a save SQL Server fails when debugging is off, with nothing written', async () => {
    const before = await writeCount();
    const res = await quietApp.inject({
      method: 'POST',
      url: RATER_SAVE_PATH,
      headers: { ...FORM, ...(await visitorHeaders()) },
      payload: rateForm(cfId('C', 24), '', '4'),
    });
    expectErrorPage(res);
    expect(await writeCount()).toBe(before);
  });

  it.each([
    ['contentID', cfId('C', 20)],
    ['userID', ` ${cfId('U', 4)} `],
    ['siteID', 's'.repeat(25)],
  ])('saves the rating whose %s %j is, trimmed, exactly as long as its tcontentratings column', async (field, value) => {
    const form = { contentID: cfId('C', 21), siteID: SITE, userID: U1, rate: '4', [field]: value };
    const res = await save(new URLSearchParams(form).toString(), { headers: await visitorHeaders(form.siteID) });
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 200, body: ORACLE_FIRST });
    expect(await ratings(form.contentID, tenantIdForSite(form.siteID))).toEqual([
      { userid: javaTrim(form.userID), siteid: form.siteID, rate: 4, entered: NOW },
    ]);
  });

  it("refuses a siteID other than the token's site with 403 and writes nothing", async () => {
    const before = await writeCount();
    const res = await save(rateForm(cfId('C', 11), U1, '4', TENANT_B.siteId));
    expect(res.statusCode).toBe(403);
    expect(await writeCount()).toBe(before);
  });

  it.each([
    {
      label: 'no user token accompanies the call',
      form: rateForm(cfId('C', 12), U1, '4'),
      headers: async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` }),
    },
    // A form the handler answers with its 500 page, so a 401 shows the refusal came before the handler.
    { label: 'the call carries no invocation credential', form: rateForm(cfId('C', 12), '', '4', TENANT_B.siteId), headers: async () => ({}) },
  ])('answers 401 when $label and writes nothing', async ({ form, headers }) => {
    const before = await writeCount();
    const res = await save(form, { headers: await headers() });
    expect(res.statusCode).toBe(401);
    expect(await writeCount()).toBe(before);
  });

  it("writes the rating in the token's tenant only", async () => {
    const item = cfId('C', 13);
    const res = await save(rateForm(item, U1, '4', TENANT_B.siteId), { headers: await visitorHeaders(TENANT_B.siteId) });
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 200, body: ORACLE_FIRST });
    expect(await ratings(item, TENANT_B.tenantId)).toEqual([{ userid: U1, siteid: TENANT_B.siteId, rate: 4, entered: NOW }]);
    expect(await ratings(item)).toEqual([]);
  });

  it('fails the save closed with the legacy 503 while its units are legacy-authoritative', async () => {
    const before = await writeCount();
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'rater-legacy' });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'rater-legacy', state: 'legacy' });
    try {
      const res = await save(rateForm(cfId('C', 14), U1, '4'));
      expect(res.statusCode).toBe(503);
    } finally {
      await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'rater-reopen', allowLegacy: true });
      await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'rater-reopen', state: 'open' });
    }
    expect(await writeCount()).toBe(before);
  });

  it('writes one changelog row per rating and stats row it writes', async () => {
    const item = cfId('C', 15);
    await save(rateForm(item, U1, '4'));
    await save(rateForm(item, U1, '5'));
    const logged = (op: string, table: string) => ({ table, op, origin: 'target', actor_service: SERVICE });
    expect(await changes(item)).toEqual([
      logged('insert', 'content_rating'),
      logged('insert', 'content_stats'),
      logged('update', 'content_rating'),
      logged('update', 'content_stats'),
    ]);
  });

  it("computes the item's stats from every rating when different users rate it concurrently", async () => {
    const item = cfId('C', 16);
    const responses = await Promise.all(([[U1, '4'], [U2, '1'], [U3, '5']] as const).map(([user, rate]) => save(rateForm(item, user, rate))));
    const answers = responses.map((res) => ({ status: res.statusCode, data: (JSON.parse(res.body) as { data: Record<string, unknown[]> }).data }));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(answers.map((answer) => Number(answer.data.THECOUNT?.[0])).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // Own oracle: SQL Server's int avg of 4, 1 and 5 is 3, with one down vote (rate 1) and two up.
    expect(answers.find((answer) => answer.data.THECOUNT?.[0] === 3)?.data).toEqual({ DOWNVOTES: [1], THEAVG: [3], THECOUNT: [3], UPVOTES: [2] });
    expect((await ratings(item)).map((row) => [row.userid, row.rate])).toEqual([
      [U1, 4],
      [U2, 1],
      [U3, 5],
    ]);
    expect(await votes(item)).toEqual({ rating: 3, totalvotes: 3, upvotes: 2, downvotes: 1, views: 0, comments: 0 });
  });
});
