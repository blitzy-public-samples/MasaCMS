/** Site Manager tree reads of carch loadsitemanager and loadsitesection over PostgreSQL: a level's statements flat in its rows, its values those of the per-row reads. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { sendLegacyResponse, type FastifyInstance, type FastifyRequest, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, pgAvailable, type InjectResponse, type ThrowawaySchema } from '@opt2/platform/testing';
import { getKidsCount, getKidsCounts } from '../../src/domain/content-tree.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type DomainDeps } from '../../src/domain/context.js';
import { getPerm, getPerms, loadMemberships } from '../../src/domain/permissions.js';
import { nest } from '../../src/repo/content-queries.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT, FILE_METADATA } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { carchRawActions } from '../../src/routes/v1/carch.js';
import { TEST_CLOCK, buildContentApp, openContentGates, userHeaders, withPgSchema, type ContentTestApp } from '../helpers/app.js';
import { roundTripCounter, type RoundTripCounter } from '../helpers/round-trips.js';
import { contentRow, seedRows, seedTenantRegistry, type SeedRow } from '../helpers/seed.js';

const SITE = TENANT_A.siteId;
const OTHER_SITE = 'other-site';
const HOME = '00000000000000000000000000000000001';
const END = '00000000000000000000000000000000END';
const SITE_TREE = '00000000000000000000000000000000000';
const ROLES = [Roles.systemUser, moduleRole(SITE_TREE)];

/** A CF-format id whose eight-character first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(8 - prefix.length, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
/** The id with its first character replaced by `prefix`: a node's version or child id. */
const as = (prefix: string, id: string): string => `${prefix}${id.slice(1)}`;

const USER = cfId('U', 1);
const EDITORS = cfId('G', 1);
/** The sections whose trees print one row and fifty rows; each row has one child, and the first row's section is open. */
const PARENTS = { 1: cfId('S', 1), 50: cfId('S', 50) } as const;
const ROWS = { 1: [cfId('P', 0)], 50: Array.from({ length: 50 }, (_, i) => cfId('P', i + 1)) } as const;
const OPEN = [ROWS[1][0], ROWS[50][0]].join(',');
/** A section whose rows hold every haskids and getKidsCount case. */
const CASES = cfId('S', 99);
const A = cfId('A', 1);
const B = cfId('B', 1);
const C = cfId('C', 1);
const FILE = cfId('F', 1);

type Size = 1 | 50;

/** An active, approved version of tenant-a under `parentid`. */
function page(contentid: string, parentid: string, extra: Parameters<typeof contentRow>[0] = {}): SeedRow {
  return { table: CONTENT, row: contentRow({ contentid, contenthistid: as('H', contentid), parentid, title: contentid, ...extra }) };
}

/**
 * The tree: the two sized sections, and the cases section whose rows A, B and C have children of every kind: A an
 * active and an older version of D1, D2 in another site and D3 naming A in lower case; B one child and two
 * equal-alttext metadata rows of its file; C one child shown in the default display window only.
 */
function treeRows(): SeedRow[] {
  const metadata = (n: number): SeedRow => ({
    table: FILE_METADATA,
    row: { tenant_id: TENANT_A.tenantId, metaid: cfId('M', n), fileid: FILE, contenthistid: as('H', B), contentid: B, siteid: SITE, alttext: 'same' },
  });
  return [
    page(HOME, END, { title: 'Home', filename: '' }),
    page(PARENTS[1], HOME, { type: 'Folder' }),
    page(PARENTS[50], HOME, { type: 'Folder', orderno: 2 }),
    page(CASES, HOME, { type: 'Folder', orderno: 3 }),
    ...([1, 50] as const).flatMap((n) => ROWS[n].flatMap((id, i) => [page(id, PARENTS[n], { orderno: i }), page(as('K', id), id)])),
    page(A, CASES, { orderno: 1 }),
    page(B, CASES, { orderno: 2, fileid: FILE }),
    page(C, CASES, { orderno: 3 }),
    page(cfId('D', 1), A),
    page(cfId('D', 1), A, { contenthistid: cfId('E', 1), active: 0 }),
    page(cfId('D', 2), A, { siteid: OTHER_SITE }),
    page(cfId('D', 3), A.toLowerCase()),
    page(cfId('D', 4), B),
    page(cfId('D', 5), C, { display: 2, displaystart: new Date(2020, 0, 1) }),
    metadata(1),
    metadata(2),
  ];
}

const EDITOR: Actor = { userId: USER, fullName: 'Edit Or', isLoggedIn: true, s2: false, roles: ROLES, siteId: SITE, tenantId: TENANT_A.tenantId };
const ADMIN: Actor = { ...EDITOR, userId: cfId('U', 2), s2: true, roles: [Roles.s2] };
const SITE_ADMIN: Actor = { ...EDITOR, userId: cfId('U', 3), roles: [...ROLES, Roles.siteAdmin] };
const NOBODY: Actor = { ...EDITOR, userId: cfId('U', 4) };
const ANONYMOUS: Actor = { ...EDITOR, userId: '', isLoggedIn: false, roles: [] };

let handle: ThrowawaySchema;
let counter: RoundTripCounter;
let deps: DomainDeps;
let t: ContentTestApp;
let adminState: Record<string, unknown> = {};
const ctx = {
  clock: TEST_CLOCK,
  actorFor: (request: FastifyRequest) => Promise.resolve(actorFromClaims(request.opt2Auth.user, 'Edit Or')),
} as Pick<ContentRouteContext, 'clock' | 'actorFor'> as ContentRouteContext;

/** The identity calls the tree makes: the admin session state, the session user and the CSRF tokens of the printed contexts. */
function answerIdentity(req: ServiceRequest): ServiceResponse {
  if (req.service === 'identity' && req.path === '/v1/sessions/current/admin-state') return { status: 200, headers: {}, body: req.method === 'GET' ? adminState : {} };
  if (req.service === 'identity' && req.method === 'GET' && req.path === '/v1/sessions/current') return { status: 200, headers: {}, body: { user: { userID: USER, fname: 'Edit', lname: 'Or' } } };
  if (req.service === 'identity' && req.method === 'POST' && req.path === '/v1/csrf/tokens') {
    const { contexts } = req.json as { contexts: string[] };
    return { status: 200, headers: {}, body: { tokens: contexts.map((context) => ({ context, csrf_token: `ISSUED-${context}`, csrf_token_expires: '260630235959000' })) } };
  }
  throw new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`);
}

/** The tree actions over `PARENTS[n]`: the Site Manager under it as top, and the section it opens. */
const TREES: ReadonlyArray<[string, string, (n: Size) => Record<string, string>]> = [
  ['loadsitemanager', 'loadsitemanager', (n) => ({ topid: PARENTS[n], moduleid: SITE_TREE, sortby: 'orderno', sortdirection: 'asc', startrow: '1' })],
  ['loadsitesection', 'loadsitesection', (n) => ({ contentid: PARENTS[n], moduleid: SITE_TREE, sortby: 'orderno', sortdirection: 'asc', startrow: '1' })],
];

describe.skipIf(!(await pgAvailable()))('Site Manager tree reads batched per level', () => {
  beforeAll(async () => {
    handle = await withPgSchema();
    await seedTenantRegistry(handle);
    await openContentGates(handle);
    counter = roundTripCounter(handle);
    const repository = createContentRepository({ clock: TEST_CLOCK, schema: handle.schema });
    await seedRows(handle, TENANT_A, treeRows());
    await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      await repository.projections.upsertGroupProjection(tx, { groupId: EDITORS, siteId: SITE, groupName: 'Editors', isPublic: 0, deleted: false });
      await repository.projections.replaceUserMemberships(tx, USER, SITE, [EDITORS]);
      await repository.projections.replaceGroupPermissions(tx, EDITORS, SITE, [
        ...[...ROWS[1], ...ROWS[50]].map((contentId, i) => ({ contentId, siteId: SITE, type: ['Author', 'Read', 'Deny', 'Editor'][i % 4] ?? 'Read' })),
        { contentId: A, siteId: SITE, type: 'Editor' },
        { contentId: B.toLowerCase(), siteId: SITE, type: 'Author' },
      ]);
    });
    t = await buildContentApp({
      declare: (app: FastifyInstance) => {
        for (const action of ['loadsitemanager', 'loadsitesection'] as const) {
          const spec = carchRawActions[action];
          app.get(`/v1/raw/carch/${action}`, { config: circuitRouteConfig('carch') }, async (request, reply) => {
            const actor = await requireCircuitAccess(request, ctx, 'carch', SITE);
            const out = await spec.run(request, ctx, actor);
            return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...out.headers }, body: out.body });
          });
        }
      },
    });
    deps = { db: counter.db, repository, clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS };
    Object.assign(ctx, { domain: { ...deps, storage: t.storage }, storage: t.storage });
    const request = (req: ServiceRequest): Promise<ServiceResponse> => new Promise((resolve) => resolve(answerIdentity(req)));
    Object.defineProperty(t.app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await t?.close();
    await handle?.drop();
  });

  describe.each(TREES)('%s', (_label, action, query) => {
    it.each([
      ['an editor whose verdicts are read from the projections', EDITOR],
      ['an S2 administrator', ADMIN],
    ] as Array<[string, Actor]>)('prints 1 and 50 rows with their open section for %s in the same statements', async (_who, actor) => {
      adminState = { openSectionList: OPEN, mura: { nextN: 100 } };
      const headers = await userHeaders({ sub: actor.userId, site: SITE, roles: actor.roles, s2: actor.s2 });
      const trips = [];
      for (const n of [1, 50] as const) {
        let res: InjectResponse | undefined;
        trips.push(
          await counter.measure(async () => {
            res = await t.app.inject({ method: 'GET', url: `/v1/raw/carch/${action}?${new URLSearchParams({ siteid: SITE, ...query(n) }).toString()}`, headers });
          }),
        );
        expect(res?.statusCode, res?.body).toBe(200);
        expect([...ROWS[n], as('K', ROWS[n][0] ?? '')].filter((id) => !(res?.body ?? '').includes(id))).toEqual([]);
      }
      expect(trips[1]).toEqual(trips[0]);
    });
  });

  it.each([
    ['merely active children', { liveOnly: false }],
    ['live children in the default window, which legacy’s unparenthesised menu clause widens to every row shown in it', { liveOnly: true }],
    ['live children in the fixed window', { liveOnly: true, menuType: 'fixed' }],
    ['live children in the calendar window', { liveOnly: true, menuType: 'calendar' }],
  ] as Array<[string, { liveOnly: boolean; menuType?: string }]>)('getKidsCounts gives each parent its getKidsCount of %s, in one transaction', async (_label, options) => {
    const parents = [A, B, C, A.toLowerCase(), cfId('X', 9), '', HOME, A].map((parentId) => ({ parentId, siteId: SITE }));
    parents.push({ parentId: A, siteId: OTHER_SITE }, { parentId: ROWS[50][0] ?? '', siteId: SITE });
    const single: number[] = [];
    for (const parent of parents) single.push(await getKidsCount(deps, EDITOR, { ...parent, ...options }));
    const trips = await counter.measure(async () => {
      expect(await getKidsCounts(deps, EDITOR, { parents, ...options })).toEqual(single);
    });
    expect(trips.transactions).toBe(1);
  });

  it('getKidsCounts reads nothing for no parents', async () => {
    const trips = await counter.measure(async () => {
      expect(await getKidsCounts(deps, EDITOR, { parents: [], liveOnly: false })).toEqual([]);
    });
    expect(trips).toEqual({ transactions: 0, statements: 0 });
  });

  it.each([
    ['an editor', EDITOR],
    ['an S2 administrator', ADMIN],
    ['a site administrator', SITE_ADMIN],
    ['a user without memberships', NOBODY],
    ['an anonymous visitor', ANONYMOUS],
  ] as Array<[string, Actor]>)('getPerms gives %s the getPerm of each node, with and without loaded memberships', async (_label, actor) => {
    const nodes = [...ROWS[50], A, B, C, A.toLowerCase(), HOME, cfId('X', 9), ''].map((contentId) => ({ contentId, siteId: SITE }));
    nodes.push({ contentId: A, siteId: OTHER_SITE });
    const memberships = await loadMemberships(deps, actor);
    for (const held of [undefined, memberships]) {
      const single = [];
      for (const node of nodes) single.push(await getPerm(deps, actor, node.contentId, node.siteId, held));
      expect(await getPerms(deps, actor, nodes, held)).toEqual(single);
    }
  });

  it.each([
    ['an editor', EDITOR],
    ['an S2 administrator', ADMIN],
  ] as Array<[string, Actor]>)('getPerms reads 1 and 50 nodes for %s in the same statements', async (_label, actor) => {
    const memberships = await loadMemberships(deps, actor);
    const trips = [];
    for (const n of [1, 50] as const) {
      trips.push(await counter.measure(() => getPerms(deps, actor, ROWS[n].map((contentId) => ({ contentId, siteId: SITE })), memberships)));
    }
    expect(trips[1]).toEqual(trips[0]);
  });

  it('nest counts haskids as legacy’s child join does: every version in any site, the exact parent id, once per row a group collapses', async () => {
    const read = (offset: number, limit?: number) =>
      withTenant(handle.app, TENANT_A.tenantId, (tx) => nest(tx, { parentId: CASES, siteId: SITE, offset, ...(limit === undefined ? {} : { limit }) }));
    const rows = await read(0);
    expect(rows.map((row) => [row.contentid, row.haskids])).toEqual([
      [A, 3],
      [B, 2],
      [C, 1],
    ]);
    expect([...(await read(0, 1)), ...(await read(1, 2))]).toEqual(rows);
    expect(await getKidsCounts(deps, EDITOR, { parents: rows.map((row) => ({ parentId: row.contentid ?? '', siteId: SITE })), liveOnly: false })).toEqual([2, 1, 1]);
  });
});
