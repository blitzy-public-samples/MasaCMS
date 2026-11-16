/** `rater/ajax/saveRate.cfm` over a throwaway content schema: form binding, the saved rating and stats, the answer, tenancy, gates and the error page. */
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
import { createService, loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
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
import { CONTENT_CONFIG_DEFAULTS, type DomainDeps } from '../../src/domain/context.js';
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

/** Changelog rows of both tenants: every write logs one, so an unchanged count means nothing was written. */
async function writeCount(): Promise<number> {
  let total = 0;
  for (const tenantId of [TENANT_A.tenantId, TENANT_B.tenantId]) {
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

/** Expects the ColdFusion error page. */
function expectErrorPage(res: InjectResponse): void {
  expect({ status: res.statusCode, message: res.statusMessage, type: res.headers['content-type'], body: res.body }).toEqual({
    status: 500,
    message: 'An Error Occurred',
    type: 'text/html;charset=UTF-8',
    body: LEGACY_ERROR_PAGE_HTML,
  });
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
    registerRaterRoutes(app, { domain: deps });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares POST as the contract does: public on the service transport, the site checked by the handler', () => {
    const operation = OPENAPI.paths[RATER_SAVE_PATH]?.post ?? {};
    expect(operation['x-opt2-public']).toBe(true);
    expect(collectRouteMatrix(app).routes.filter((route) => route.url === RATER_SAVE_PATH)).toEqual([
      { method: 'POST', url: RATER_SAVE_PATH, transport: operation['x-opt2-transport'], public: true, siteCheck: false },
    ]);
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

  it('answers the ColdFusion error page with nothing written when contentID, siteID, userID or rate is missing from the form', async () => {
    const item = cfId('C', 7);
    const complete = { contentID: item, siteID: SITE, userID: U1, rate: '4' };
    const before = await writeCount();
    for (const missing of Object.keys(complete)) {
      const fields = Object.entries(complete).filter(([name]) => name !== missing);
      expectErrorPage(await save(new URLSearchParams(fields).toString()));
      // Own oracle: the template reads the form scope only, so the field in the query string still leaves it undefined.
      expectErrorPage(await save(new URLSearchParams(fields).toString(), { query: `?${new URLSearchParams([[missing, complete[missing as keyof typeof complete]]]).toString()}` }));
    }
    // A JSON body fills no form scope.
    expectErrorPage(await save(JSON.stringify(complete), { contentType: 'application/json' }));
    expect(await writeCount()).toBe(before);
    expect(await ratings(item)).toEqual([]);
  });

  it('answers the ColdFusion error page with nothing written for a non-numeric rate', async () => {
    const item = cfId('C', 8);
    const before = await writeCount();
    // Own oracle: the `numeric` rate argument refuses each, the repeated field joined as `3,4`.
    for (const form of ['abc', '', '1d', '0x10', '1,000', '1e309'].map((rate) => rateForm(item, U1, rate)).concat(`${rateForm(item, U1, '3')}&rate=4`)) {
      expectErrorPage(await save(form));
    }
    expect(await writeCount()).toBe(before);
  });

  it.each(['3000000000', '-2147483649', '1e10', '0.000000000000000000000000000000000000001'])(
    'answers the ColdFusion error page with nothing written for the rate %s, which SQL Server cannot store as an int',
    async (rate) => {
      const before = await writeCount();
      expectErrorPage(await save(rateForm(cfId('C', 9), U1, rate)));
      expect(await writeCount()).toBe(before);
    },
  );

  it.each(['contentID', 'siteID', 'userID'])('answers the ColdFusion error page with nothing written for an empty %s, which the rating insert binds as NULL', async (field) => {
    const before = await writeCount();
    const fields = new URLSearchParams({ contentID: cfId('C', 10), siteID: SITE, userID: U1, rate: '4', [field]: '' });
    expectErrorPage(await save(fields.toString()));
    expect(await writeCount()).toBe(before);
  });

  it("refuses a siteID other than the token's site with 403 and writes nothing", async () => {
    const before = await writeCount();
    const res = await save(rateForm(cfId('C', 11), U1, '4', TENANT_B.siteId));
    expect(res.statusCode).toBe(403);
    expect(await writeCount()).toBe(before);
  });

  it('answers 401 when no user token accompanies the call', async () => {
    const before = await writeCount();
    const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` };
    const res = await save(rateForm(cfId('C', 12), U1, '4'), { headers });
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
