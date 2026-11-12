/** `getHeaderPrompts` over a throwaway `content` schema: the five counts per role and tenant, auth denials and the contract operation. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, moduleRole } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, tenantRegistryConsumer, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { HeaderPrompts } from '../../src/domain/header-prompts.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { registerHeaderPromptRoutes } from '../../src/routes/v1/header-prompts.js';

type ContractOperation = Record<string, unknown>;
type Row = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const SERVICE = 'strategies-content';
const CONTRACT_PATH = '/v1/sites/{siteid}/header-prompts';
const urlFor = (siteId: string): string => `/v1/sites/${siteId}/header-prompts`;

/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const at = (stamp: string): Date => new Date(stamp);

/** Three months before it is 2026-03-30, so the draft window opens at that day's midnight. */
const NOW = new Date(2026, 5, 30, 12);
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
/** A site whose private user pool, and so its users' group memberships, is `umbrella`. */
const SITE_C = 'tenant-c';
/** A site the registry does not hold, so its private user pool is unknown. */
const SITE_D = 'tenant-d';
const SITE_MANAGER = '00000000000000000000000000000000000';
const CHANGESETS = '00000000000000000000000000000000014';

const USER = cfId('U', 1);
const OTHER = cfId('U', 2);
const NOBODY = cfId('U', 3);
const [G1, G2, G3] = [1, 2, 3].map((n) => cfId('G', n)) as [string, string, string];
const [CS1, CS2, CS3] = [1, 2, 3].map((n) => cfId('Q', n)) as [string, string, string];
const content = (n: number): string => cfId('C', n);
/** The id of version `version` of item `n`. */
const hist = (n: number, version = 0): string => cfId('H', n * 10 + version);

let handle: ThrowawaySchema;
let stateDir: string;
let app: FastifyInstance;

/** Inserts `rows` into `table` in the transaction tenant; each row names its own columns. */
async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

/** A live site-tree page version of `siteid`, last updated by OTHER; `fields` override any column. */
const page = (siteid: string, contentid: string, contenthistid: string, fields: Row = {}): Row => ({
  contentid,
  contenthistid,
  siteid,
  moduleid: SITE_MANAGER,
  type: 'Page',
  title: contentid,
  menutitle: contentid,
  active: 1,
  approved: 1,
  display: 1,
  lastupdate: at('2026-01-01T09:00'),
  lastupdatebyid: OTHER,
  ...fields,
});

const draft = { active: 0, approved: 0 };
const unpublished = { active: 1, approved: 0 };

/** A pending-or-decided approval request on `contenthistid`. */
const request = (n: number, contenthistid: string, userid: string, groupid: string, status: string, siteid = SITE_A): Row => ({
  requestid: cfId('R', n),
  siteid,
  userid,
  groupid,
  status,
  contenthistid,
});

async function seedTenantA(tx: TenantTx): Promise<void> {
  await insert(tx, 'content', [
    page(SITE_A, SITE_MANAGER, cfId('M', 1), { type: 'Module' }),
    // Drafts: two newer versions of one item, an unpublished item on the window's first day, one the day before
    // and one assigned to USER.
    page(SITE_A, content(1), hist(1, 1)),
    page(SITE_A, content(1), hist(1, 2), { ...draft, lastupdate: at('2026-05-01T09:00'), lastupdatebyid: USER }),
    page(SITE_A, content(1), hist(1, 3), { ...draft, lastupdate: at('2026-06-01T09:00'), lastupdatebyid: USER }),
    page(SITE_A, content(2), hist(2), { ...unpublished, lastupdate: at('2026-03-30T08:00'), lastupdatebyid: USER }),
    page(SITE_A, content(3), hist(3), { ...unpublished, lastupdate: at('2026-03-29T23:00'), lastupdatebyid: USER }),
    page(SITE_A, content(4), hist(4), { ...unpublished, lastupdate: at('2026-06-10T09:00') }),
    // Approval requests: two versions of one item and three single versions.
    page(SITE_A, content(5), hist(5, 1), draft),
    page(SITE_A, content(5), hist(5, 2), draft),
    page(SITE_A, content(6), hist(6), draft),
    page(SITE_A, content(7), hist(7), draft),
    page(SITE_A, content(8), hist(8), draft),
    // Change-set versions: CS1 and CS2 unpublished, CS3 published.
    page(SITE_A, content(9), hist(9), { ...draft, changesetid: CS1 }),
    page(SITE_A, content(10), hist(10), { ...draft, changesetid: CS1 }),
    page(SITE_A, content(11), hist(11), { ...draft, changesetid: CS1 }),
    page(SITE_A, content(12), hist(12), { ...draft, changesetid: CS2 }),
    page(SITE_A, content(13), hist(13), { ...draft, changesetid: CS3 }),
    // Expiring: own within a month, own over a year ago, and another's that USER is notified about.
    page(SITE_A, content(21), hist(21), { lastupdatebyid: USER, expires: at('2026-07-15T00:00') }),
    page(SITE_A, content(22), hist(22), { lastupdatebyid: USER, expires: at('2025-06-01T00:00') }),
    page(SITE_A, content(23), hist(23), { expires: at('2026-07-01T00:00') }),
  ]);
  await insert(tx, 'content_assignment', [
    { contentid: content(4), contenthistid: hist(4), siteid: SITE_A, userid: USER, type: 'draft' },
    { contentid: content(21), contenthistid: hist(21), siteid: SITE_A, userid: USER, type: 'expire' },
    { contentid: content(23), contenthistid: hist(23), siteid: SITE_A, userid: USER, type: 'expire' },
  ]);
  await insert(tx, 'approval_request', [
    request(1, hist(5, 1), USER, G1, 'Pending'),
    request(2, hist(5, 2), USER, G2, 'Pending'),
    request(3, hist(6), USER, G2, 'Pending'),
    request(4, hist(7), OTHER, G1, 'Pending'),
    request(5, hist(8), USER, G1, 'Approved'),
    request(6, hist(9), OTHER, G3, 'Pending'),
    request(7, hist(10), OTHER, G3, 'Approved'),
    request(8, hist(11), OTHER, G3, 'Rejected'),
    request(9, hist(12), OTHER, G3, 'Rejected'),
    request(10, hist(13), OTHER, G3, 'Rejected'),
  ]);
  await insert(tx, 'changeset', [
    { changesetid: CS1, siteid: SITE_A, name: 'Spring', published: 0, publishdate: at('2026-07-01T00:00') },
    { changesetid: CS2, siteid: SITE_A, name: 'Summer', published: 0, publishdate: null },
    { changesetid: CS3, siteid: SITE_A, name: 'Winter', published: 1, publishdate: at('2026-01-01T00:00') },
  ]);
  await insert(tx, 'membership_projection', [
    { user_id: USER, site_id: SITE_A, group_id: G1 },
    { user_id: OTHER, site_id: SITE_A, group_id: G2 },
  ]);
}

async function seedTenantB(tx: TenantTx): Promise<void> {
  await insert(tx, 'content', [
    page(SITE_B, SITE_MANAGER, cfId('M', 2), { type: 'Module' }),
    page(SITE_B, content(1), hist(1, 2), { ...unpublished, lastupdate: at('2026-06-01T09:00'), lastupdatebyid: USER }),
  ]);
}

/** One version of `siteid` awaiting group G1's approval. */
async function seedPendingForG1(tx: TenantTx, siteid: string, n: number): Promise<void> {
  await insert(tx, 'content', [page(siteid, SITE_MANAGER, cfId('M', n), { type: 'Module' }), page(siteid, content(n), hist(n), draft)]);
  await insert(tx, 'approval_request', [request(n, hist(n), OTHER, G1, 'Pending', siteid)]);
}

/** A user token of `site` with the gateway's invocation credential, as the relay forwards web's calls. */
async function headersFor(
  roles: readonly string[],
  opts: { sub?: string; site?: string; s2?: boolean } = {},
): Promise<Record<string, string>> {
  const { sub = USER, site = SITE_A, s2 } = opts;
  const [user, invocation] = await Promise.all([
    mintUserToken({ sub, site, roles: [...roles], ...(s2 === undefined ? {} : { s2 }) }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** GETs `url` and checks the answer against the contract. */
async function getPrompts(headers: Record<string, string>, url: string = urlFor(SITE_A)) {
  const res = await app.inject({ method: 'GET', url, headers });
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'GET',
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

const counts = (drafts: number, submissions: number, approvals: number, expires: number, pendingChangesets: number): HeaderPrompts => ({
  drafts,
  submissions,
  approvals,
  expires,
  pendingChangesets,
});

describe.skipIf(!(await pgAvailable()))('getHeaderPrompts', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await seedRegistry(handle.app);
    const tenantC = tenantIdForSite(SITE_C);
    await withTenant(handle.app, tenantC, (tx) =>
      tenantRegistryConsumer.apply(tx, {
        tenantId: tenantC,
        aggregateVersion: 1,
        payload: { siteId: SITE_C, publicUserPoolId: SITE_C, privateUserPoolId: TENANT_UMBRELLA.siteId, filePoolId: SITE_C },
      }),
    );
    await withTenant(handle.app, TENANT_A.tenantId, seedTenantA);
    await withTenant(handle.app, TENANT_B.tenantId, seedTenantB);
    await withTenant(handle.app, tenantC, (tx) => seedPendingForG1(tx, SITE_C, 31));
    await withTenant(handle.app, tenantIdForSite(SITE_D), (tx) => seedPendingForG1(tx, SITE_D, 41));
    await withTenant(handle.app, TENANT_UMBRELLA.tenantId, (tx) =>
      insert(tx, 'membership_projection', [{ user_id: USER, site_id: TENANT_UMBRELLA.siteId, group_id: G1 }]),
    );

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-header-prompts-'));
    await writeTestSecrets(stateDir);
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
    await registerHeaderPromptRoutes(app, {
      domain: { db, repository: createContentRepository({ clock, schema: handle.schema }), clock },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares the contract operation', () => {
    const operation = OPENAPI.paths[CONTRACT_PATH]?.get ?? {};
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.endsWith('/header-prompts'));
    expect(declared).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: CONTRACT_PATH.replace(/\{(\w+)\}/g, ':$1'),
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
      }),
    ]);
  });

  it.each<[string, readonly string[], { sub?: string; site?: string; s2?: boolean }, HeaderPrompts]>([
    ['a system user, approvals limited to their groups and no change-set count', [Roles.systemUser], {}, counts(3, 2, 2, 2, 0)],
    [
      'a system user with the Change Sets and Site Manager modules',
      [Roles.systemUser, moduleRole(CHANGESETS), moduleRole(SITE_MANAGER)],
      {},
      counts(3, 2, 2, 2, 3),
    ],
    ['a system user with the Change Sets module only', [Roles.systemUser, moduleRole(CHANGESETS)], {}, counts(3, 2, 2, 2, 0)],
    ['a system user with the Site Manager module only', [Roles.systemUser, moduleRole(SITE_MANAGER)], {}, counts(3, 2, 2, 2, 0)],
    ['a site admin, approvals of every group', [Roles.siteAdmin], {}, counts(3, 2, 4, 2, 3)],
    ['an S2 user', [Roles.s2], {}, counts(3, 2, 4, 2, 3)],
    ['a system user whose token is S2', [Roles.systemUser], { s2: true }, counts(3, 2, 4, 2, 3)],
    ['a user with no content, groups or requests', [Roles.systemUser], { sub: NOBODY }, counts(0, 0, 0, 0, 0)],
    ['the same user in another tenant', [Roles.systemUser], { site: SITE_B }, counts(1, 0, 0, 0, 0)],
    ['a system user whose groups are projected in a shared private user pool', [Roles.systemUser], { site: SITE_C }, counts(0, 0, 1, 0, 0)],
    ['a system user of a site with no registered private user pool', [Roles.systemUser], { site: SITE_D }, counts(0, 0, 0, 0, 0)],
    ['an S2 user of a site with no registered private user pool', [Roles.s2], { site: SITE_D }, counts(0, 0, 1, 0, 0)],
  ])('counts the prompts of %s', async (_label, roles, opts, expected) => {
    const res = await getPrompts(await headersFor(roles, opts), urlFor(opts.site ?? SITE_A));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expected);
  });

  it('answers a site id in another case as the token site', async () => {
    const res = await getPrompts(await headersFor([Roles.systemUser]), urlFor(SITE_A.toUpperCase()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(counts(3, 2, 2, 2, 0));
  });

  it.each([
    ['no user token', async () => ({ [INVOCATION_HEADER]: (await headersFor([Roles.systemUser]))[INVOCATION_HEADER] ?? '' }), urlFor(SITE_A), 401],
    ['no invocation credential', async () => ({ authorization: (await headersFor([Roles.systemUser])).authorization ?? '' }), urlFor(SITE_A), 401],
    ['a public member', () => headersFor([Roles.member]), urlFor(SITE_A), 403],
    ['a site other than the token site', () => headersFor([Roles.s2]), urlFor(SITE_B), 403],
  ])('denies a call with %s', async (_label, headers, url, status) => {
    const res = await getPrompts(await headers(), url);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});
