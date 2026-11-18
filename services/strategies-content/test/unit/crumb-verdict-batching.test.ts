/** Crumbs and node verdicts of carch assocfiles, loadrelatedcontent, loadselectedrelatedcontent and cChangesets.assignments over PostgreSQL: read per site and tenant, with the per-row results. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { sendLegacyResponse, type FastifyInstance, type FastifyRequest, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { tenantRegistryConsumer, withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, pgAvailable, registryPayloads, type InjectResponse, type ThrowawaySchema } from '@opt2/platform/testing';
import { getActiveContent, getActiveContents, getCrumbList, getCrumbLists } from '../../src/domain/content-tree.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type DomainDeps } from '../../src/domain/context.js';
import { getNodePerm, getNodePerms, loadMemberships } from '../../src/domain/permissions.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CHANGESET, CONTENT, CONTENT_RELATED, FILE } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { carchRawActions } from '../../src/routes/v1/carch.js';
import { registerChangesetRoutes } from '../../src/routes/v1/cchangesets.js';
import {
  DEPLOYMENT_SETTINGS,
  SITE_CONFIG_FLAGS_PATH,
  TEST_CLOCK,
  buildContentApp,
  openContentGates,
  siteConfigFlagsAnswer,
  userHeaders,
  withPgSchema,
  type ContentTestApp,
} from '../helpers/app.js';
import { roundTripCounter, type RoundTripCounter } from '../helpers/round-trips.js';
import { changesetRow, contentRow, fileRow, seedRows, seedTenantRegistry, type SeedRow } from '../helpers/seed.js';

const SITE = TENANT_A.siteId;
const HOME = '00000000000000000000000000000000001';
const END = '00000000000000000000000000000000END';
const SITE_TREE = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';
const CHANGESETS_MODULE = '00000000000000000000000000000000014';
const ROLES = [Roles.systemUser, moduleRole(SITE_TREE), moduleRole(CHANGESETS_MODULE)];

/** A CF-format id whose eight-character first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(8 - prefix.length, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

const USER = cfId('U', 1);
const EDITORS = cfId('G', 1);
const SECTION = cfId('S', 1);
/** The node each related-content panel opens: one with a single related row, one with fifty. */
const NODES = { 1: { contentId: cfId('N', 1), contentHistId: cfId('H', 1) }, 50: { contentId: cfId('N', 50), contentHistId: cfId('H', 50) } } as const;
const SOLO = cfId('P', 0);
const MANY = Array.from({ length: 50 }, (_, i) => cfId('P', i + 1));
const COMPONENT_ONE = cfId('C', 0);
const COMPONENT_MANY = Array.from({ length: 50 }, (_, i) => cfId('C', i + 1));
const CHANGESETS = { 1: cfId('D', 1), 50: cfId('D', 50) } as const;
const B_SOLO = cfId('B', 0);
const B_MANY = Array.from({ length: 50 }, (_, i) => cfId('B', i + 1));

type Size = 1 | 50;
const pagesOf = (n: Size): readonly string[] => (n === 1 ? [SOLO] : MANY);

/** The editor the suites run as: Site Manager and Change Sets module roles, a member of `Editors` of tenant-a's private pool. */
const EDITOR: Actor = { userId: USER, fullName: 'Edit Or', isLoggedIn: true, s2: false, roles: ROLES, siteId: SITE, tenantId: TENANT_A.tenantId };
const ADMIN: Actor = { ...EDITOR, userId: cfId('U', 2), s2: true, roles: [Roles.s2] };
const NOBODY: Actor = { ...EDITOR, userId: cfId('U', 3) };
const ANONYMOUS: Actor = { ...EDITOR, userId: '', isLoggedIn: false, roles: [] };

let handle: ThrowawaySchema;
let counter: RoundTripCounter;
let repository: ContentRepository;
let deps: DomainDeps;
let t: ContentTestApp;
const ctx = {
  clock: TEST_CLOCK,
  legacySettings: DEPLOYMENT_SETTINGS,
  actorFor: (request: FastifyRequest) => Promise.resolve(actorFromClaims(request.opt2Auth.user, 'Edit Or')),
} as Pick<ContentRouteContext, 'clock' | 'legacySettings' | 'actorFor'> as ContentRouteContext;

/** A version of tenant-a under `parentid`, its stored path from the home page. */
function page(contentid: string, parentid: string, overrides: Parameters<typeof contentRow>[0] = {}): SeedRow {
  const path = parentid === HOME ? `${HOME},${contentid}` : `${HOME},${parentid},${contentid}`;
  return { table: CONTENT, row: contentRow({ contentid, parentid, path, title: contentid, ...overrides }) };
}

/** The tree: home, a section holding the searched pages, the two panel nodes, the component module and the assigned components. */
function treeRows(): SeedRow[] {
  const updated = (n: number): Date => new Date(2026, 5, 29, 10, 0, n);
  return [
    { table: CONTENT, row: contentRow({ contentid: HOME, parentid: END, path: HOME, title: 'Home', filename: '' }) },
    page(SECTION, HOME, { type: 'Folder', title: 'Section' }),
    ...([1, 50] as const).map((n) => page(NODES[n].contentId, HOME, { contenthistid: NODES[n].contentHistId, title: `Node ${n}` })),
    page(SOLO, SECTION, { title: 'Solo Batch', fileid: cfId('F', 0), lastupdate: updated(0) }),
    ...MANY.map((id, i) => page(id, SECTION, { title: `Many Batch ${i}`, fileid: cfId('F', i + 1), lastupdate: updated(i + 1) })),
    { table: CONTENT, row: contentRow({ contentid: COMPONENTS, parentid: END, moduleid: COMPONENTS, type: 'Module', path: COMPONENTS, title: 'Components' }) },
    ...[COMPONENT_ONE, ...COMPONENT_MANY].map(
      (id, i): SeedRow => ({
        table: CONTENT,
        row: contentRow({ contentid: id, parentid: COMPONENTS, moduleid: COMPONENTS, type: 'Component', path: `${COMPONENTS},${id}`, title: `Component ${i}`, changesetid: i === 0 ? CHANGESETS[1] : CHANGESETS[50] }),
      }),
    ),
    ...([1, 50] as const).map((n): SeedRow => ({ table: CHANGESET, row: changesetRow({ changesetid: CHANGESETS[n], name: `Set ${n}`, published: 1, publishdate: new Date(2026, 5, 1) }) })),
    ...([1, 50] as const).flatMap((n) =>
      pagesOf(n).map(
        (id, i): SeedRow => ({
          table: CONTENT_RELATED,
          row: { tenant_id: TENANT_A.tenantId, contenthistid: NODES[n].contentHistId, relatedid: id, contentid: NODES[n].contentId, siteid: SITE, relatedcontentsetid: SITE_TREE, orderno: i + 1 },
        }),
      ),
    ),
  ];
}

/** The service calls the panels make: identity's admin session state, session user and CSRF tokens of the printed contexts, and programs-sites' site flags. */
function answerIdentity(req: ServiceRequest): ServiceResponse | Promise<ServiceResponse> {
  if (req.service === 'programs-sites' && req.method === 'POST' && req.path === SITE_CONFIG_FLAGS_PATH) return siteConfigFlagsAnswer()(req);
  if (req.service === 'identity' && req.method === 'GET' && req.path === '/v1/sessions/current/admin-state') return { status: 200, headers: {}, body: {} };
  if (req.service === 'identity' && req.method === 'GET' && req.path === '/v1/sessions/current') return { status: 200, headers: {}, body: { user: { userID: USER, fname: 'Edit', lname: 'Or' } } };
  if (req.service === 'identity' && req.method === 'POST' && req.path === '/v1/csrf/tokens') {
    const { contexts } = req.json as { contexts: string[] };
    return { status: 200, headers: {}, body: { tokens: contexts.map((context) => ({ context, csrf_token: `ISSUED-${context}`, csrf_token_expires: '260630235959000' })) } };
  }
  throw new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`);
}

/** Injects `url` as the editor. */
async function get(url: string): Promise<InjectResponse> {
  return t.app.inject({ method: 'GET', url, headers: await userHeaders({ sub: USER, site: SITE, roles: ROLES, s2: false }) });
}

/** The carch raw action's GET with `query` and the site. */
const raw = (action: string, query: Record<string, string>): Promise<InjectResponse> => get(`/v1/raw/carch/${action}?${new URLSearchParams({ siteid: SITE, ...query }).toString()}`);

/** The response of `call` and the round trips it took. */
async function measured(call: () => Promise<InjectResponse>): Promise<{ res: InjectResponse; trips: Awaited<ReturnType<RoundTripCounter['measure']>> }> {
  let res: InjectResponse | undefined;
  const trips = await counter.measure(async () => {
    res = await call();
  });
  if (res === undefined) throw new Error('the request did not answer');
  return { res, trips };
}

/** The ad-hoc set's client rows of `ids` in `siteId`, as loadselectedrelatedcontent posts them. */
const clientRows = (ids: readonly string[], siteId: string): Array<Record<string, string>> =>
  ids.map((contentid) => ({ contentid, siteid: siteId, type: 'Page', subtype: 'Default', url: '', title: contentid }));

/** The items loadselectedrelatedcontent prints, in order. */
const selectedItems = (body: string): string[] => [...body.matchAll(/<li class="item" data-contentid="([^"]+)"/g)].map((m) => m[1] ?? '');

/** One panel read of 1 or 50 rows, and the ids it prints. */
interface BatchCase {
  call(n: Size): Promise<InjectResponse>;
  printed(res: InjectResponse): string[];
  expected(n: Size): string[];
}

const CASES: ReadonlyArray<[string, BatchCase]> = [
  [
    'assocfiles',
    {
      call: (n) => raw('assocfiles', { type: 'Page', property: 'fileid', keywords: n === 1 ? 'Solo' : 'Many' }),
      printed: (res) => [...res.body.matchAll(/<input type="radio" name="fileid" value="([^"]+)"\/>/g)].map((m) => m[1] ?? ''),
      expected: (n) => (n === 1 ? [cfId('F', 0)] : MANY.map((_, i) => cfId('F', i + 1))).sort(),
    },
  ],
  [
    'loadrelatedcontent results',
    {
      call: (n) => raw('loadrelatedcontent', { contenthistid: NODES[n].contentHistId, contentid: NODES[n].contentId, isNew: '0', keywords: n === 1 ? 'Solo' : 'Many' }),
      printed: (res) => [...res.body.matchAll(/<li class="item" data-content-type="[^"]*" data-contentid="([^"]+)">/g)].map((m) => m[1] ?? ''),
      // The search feed sorts by lastupdate descending.
      expected: (n) => [...pagesOf(n)].reverse(),
    },
  ],
  [
    'loadselectedrelatedcontent set rows',
    {
      call: (n) => raw('loadselectedrelatedcontent', { contenthistid: NODES[n].contentHistId, type: 'Page', subtype: 'Default' }),
      printed: (res) => selectedItems(res.body),
      expected: (n) => [...pagesOf(n)],
    },
  ],
  [
    'loadselectedrelatedcontent listed ids',
    {
      call: (n) => raw('loadselectedrelatedcontent', { contenthistid: NODES[n].contentHistId, type: 'Page', subtype: 'Default', relatedcontentsetid: 'calendar', relateditems: [...pagesOf(n), cfId('X', 1)].join(',') }),
      printed: (res) => selectedItems(res.body),
      expected: (n) => [...pagesOf(n)],
    },
  ],
  [
    'loadselectedrelatedcontent client rows',
    {
      call: (n) => raw('loadselectedrelatedcontent', { contenthistid: NODES[n].contentHistId, type: 'Page', subtype: 'Default', relatedcontentsetid: 'custom', relateditems: JSON.stringify(clientRows(pagesOf(n), SITE)) }),
      printed: (res) => selectedItems(res.body),
      expected: (n) => [...pagesOf(n)],
    },
  ],
  [
    'cChangesets.assignments',
    {
      call: (n) => get(`/v1/sites/${SITE}/changesets/${CHANGESETS[n]}/assignments`),
      printed: (res) => ((res.json() as { rc: { componentAssignments: Array<{ contentid: string; verdict: string; crumbdata: unknown[] }> } }).rc.componentAssignments ?? []).map((row) => `${row.contentid}:${row.verdict}:${row.crumbdata.length}`),
      expected: (n) => (n === 1 ? [COMPONENT_ONE] : COMPONENT_MANY).map((id) => `${id}:author:2`),
    },
  ],
];

describe.skipIf(!(await pgAvailable()))('crumb and verdict reads batched per site and tenant', () => {
  beforeAll(async () => {
    handle = await withPgSchema();
    await seedTenantRegistry(handle);
    await openContentGates(handle);
    counter = roundTripCounter(handle);
    repository = createContentRepository({ clock: TEST_CLOCK, schema: handle.schema });
    await seedRows(handle, TENANT_A, treeRows());
    // tenant-a keeps its files in the umbrella file pool, where the search matches the pages' files.
    const fileIds = [0, ...MANY.map((_, i) => i + 1)].map((n) => cfId('F', n));
    await seedRows(
      handle,
      TENANT_UMBRELLA,
      fileIds.map((fileid): SeedRow => ({ table: FILE, row: fileRow({ tenant_id: TENANT_UMBRELLA.tenantId, siteid: TENANT_UMBRELLA.siteId, fileid, filename: `${fileid}.pdf`, fileext: 'pdf' }) })),
    );
    await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      await repository.projections.upsertGroupProjection(tx, { groupId: EDITORS, siteId: SITE, groupName: 'Editors', isPublic: 0, deleted: false });
      await repository.projections.replaceUserMemberships(tx, USER, SITE, [EDITORS]);
      await repository.projections.replaceGroupPermissions(tx, EDITORS, SITE, [
        { contentId: HOME, siteId: SITE, type: 'Read' },
        { contentId: SECTION, siteId: SITE, type: 'Editor' },
        { contentId: NODES[1].contentId, siteId: SITE, type: 'Deny' },
        { contentId: COMPONENTS, siteId: SITE, type: 'Author' },
      ]);
    });
    t = await buildContentApp({
      declare: (app: FastifyInstance) => {
        for (const action of ['assocfiles', 'loadrelatedcontent', 'loadselectedrelatedcontent'] as const) {
          const spec = carchRawActions[action];
          app.get(`/v1/raw/carch/${action}`, { config: circuitRouteConfig('carch') }, async (request, reply) => {
            const actor = await requireCircuitAccess(request, ctx, 'carch', SITE);
            const out = await spec.run(request, ctx, actor);
            return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...out.headers }, body: out.body });
          });
        }
        return registerChangesetRoutes(app, ctx);
      },
    });
    deps = { db: counter.db, repository, clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS };
    Object.assign(ctx, { domain: deps, storage: t.storage });
    const request = (req: ServiceRequest): Promise<ServiceResponse> => new Promise((resolve) => resolve(answerIdentity(req)));
    Object.defineProperty(t.app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await t?.close();
    await handle?.drop();
  });

  describe('getCrumbLists', () => {
    const items = (): Array<{ contentId: string; path?: string }> => [
      { contentId: SOLO },
      { contentId: MANY[0] ?? '', path: `${HOME},${SECTION},${MANY[0] ?? ''}` },
      { contentId: MANY[1] ?? '', path: '' },
      { contentId: MANY[2] ?? '', path: `${MANY[2] ?? ''},,${HOME}` },
      { contentId: '' },
      { contentId: cfId('X', 2) },
      { contentId: HOME },
      { contentId: SOLO.toLowerCase() },
      { contentId: SOLO },
    ];

    it.each([['node to root', undefined], ['root first', 'desc'], ['root first, any case', 'DESC']])('gives each item its getCrumbList, %s', async (_label, sort) => {
      const batched = await getCrumbLists(deps, EDITOR, { siteId: SITE, items: items(), sort });
      const single = [];
      for (const item of items()) single.push(await getCrumbList(deps, EDITOR, { ...item, siteId: SITE, sort }));
      expect(batched).toEqual(single);
      expect(batched.map((crumbs) => crumbs.length)).toEqual([3, 3, 3, 2, 0, 0, 1, 3, 3]);
    });

    it('reads fifty items with the round trips of one, and no item without any', async () => {
      const read = (ids: readonly string[]) => counter.measure(() => getCrumbLists(deps, EDITOR, { siteId: SITE, items: ids.map((contentId) => ({ contentId })) }));
      expect(await read(MANY)).toEqual(await read([SOLO]));
      expect(await read([])).toEqual({ transactions: 0, statements: 0 });
    });
  });

  describe('getNodePerms', () => {
    const lists = () => getCrumbLists(deps, EDITOR, { siteId: SITE, items: [SOLO, MANY[0] ?? '', HOME, NODES[1].contentId, NODES[50].contentId, '', COMPONENT_ONE].map((contentId) => ({ contentId })) });

    it.each([
      ['an S2 administrator', ADMIN, true, ['editor', 'editor', 'editor', 'editor', 'editor', 'none', 'editor']],
      ['a member of the granted group', EDITOR, true, ['editor', 'editor', 'read', 'none', 'read', 'none', 'author']],
      ['a member, reading the memberships itself', EDITOR, false, ['editor', 'editor', 'read', 'none', 'read', 'none', 'author']],
      ['a system user without memberships', NOBODY, true, ['none', 'none', 'none', 'none', 'none', 'none', 'none']],
      ['an anonymous visitor', ANONYMOUS, true, ['none', 'none', 'none', 'none', 'none', 'none', 'none']],
    ] as Array<[string, Actor, boolean, string[]]>)('gives %s each list’s getNodePerm verdict', async (_label, actor, passMemberships, expected) => {
      const crumbLists = await lists();
      const memberships = passMemberships ? await loadMemberships(deps, actor) : undefined;
      const batched = await getNodePerms(deps, actor, crumbLists, memberships);
      const single = [];
      for (const crumbs of crumbLists) single.push(await getNodePerm(deps, actor, crumbs, memberships));
      expect(batched).toEqual(single);
      expect(batched).toEqual(expected);
    });

    it('judges fifty crumb lists with the round trips of one, and none without any', async () => {
      const memberships = await loadMemberships(deps, EDITOR);
      const judge = async (ids: readonly string[]) => {
        const crumbLists = await getCrumbLists(deps, EDITOR, { siteId: SITE, items: ids.map((contentId) => ({ contentId })) });
        return counter.measure(() => getNodePerms(deps, EDITOR, crumbLists, memberships));
      };
      const one = await judge([SOLO]);
      expect(one.statements).toBeGreaterThan(0);
      expect(await judge(MANY)).toEqual(one);
      expect(await judge([])).toEqual({ transactions: 0, statements: 0 });
    });
  });

  describe('getActiveContents', () => {
    it('gives each listed id with an active version its getActiveContent version, keyed by the id as given', async () => {
      const ids = [SOLO, SOLO.toLowerCase(), '', cfId('X', 3), MANY[0] ?? ''];
      const found = await getActiveContents(deps, EDITOR, { siteId: SITE, contentIds: ids });
      const single = new Map();
      for (const contentId of ids) {
        const bean = await getActiveContent(deps, EDITOR, { contentId, siteId: SITE });
        if (bean.isNew === 0) single.set(contentId, bean.version);
      }
      expect(found).toEqual(single);
      expect([...found.keys()]).toEqual([SOLO, SOLO.toLowerCase(), MANY[0]]);
      expect(await getActiveContents(deps, EDITOR, { siteId: TENANT_B.siteId, contentIds: [SOLO] })).toEqual(new Map());
    });
  });

  it.each(CASES)('%s prints fifty rows with the round trips of one', async (_label, batch) => {
    const one = await measured(() => batch.call(1));
    const many = await measured(() => batch.call(50));
    expect([one.res.statusCode, many.res.statusCode], `${one.res.body.slice(0, 300)}\n${many.res.body.slice(0, 300)}`).toEqual([200, 200]);
    expect(batch.printed(one.res)).toEqual(batch.expected(1));
    expect([...batch.printed(many.res)].sort()).toEqual([...batch.expected(50)].sort());
    expect(batch.printed(many.res)).toHaveLength(50);
    expect(many.trips).toEqual(one.trips);
  });

  describe('rows of content-pool sites', () => {
    beforeAll(async () => {
      const payload = registryPayloads().find((candidate) => candidate.siteId === SITE);
      if (payload === undefined) throw new Error('registryPayloads() has no tenant-a entry');
      await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
        tenantRegistryConsumer.apply(tx, { tenantId: TENANT_A.tenantId, aggregateVersion: 2, payload: { ...payload, contentPoolIds: [SITE, TENANT_B.siteId] } }),
      );
      const bRow = (contentid: string, parentid: string, path: string, title: string = contentid): SeedRow => ({
        table: CONTENT,
        row: contentRow({ tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId, contentid, parentid, path, title }),
      });
      await seedRows(handle, TENANT_B, [bRow(HOME, END, HOME, 'Home B'), ...[B_SOLO, ...B_MANY].map((id) => bRow(id, HOME, `${HOME},${id}`))]);
    });

    it('reads each pool site’s client rows in its own tenant, fifty rows with the round trips of one', async () => {
      const call = (n: Size) => {
        const rows = [...clientRows(pagesOf(n), SITE), ...clientRows(n === 1 ? [B_SOLO] : B_MANY, TENANT_B.siteId)];
        return raw('loadselectedrelatedcontent', { contenthistid: NODES[n].contentHistId, type: 'Page', subtype: 'Default', relatedcontentsetid: 'custom', relateditems: JSON.stringify(rows) });
      };
      const one = await measured(() => call(1));
      const many = await measured(() => call(50));
      expect([one.res.statusCode, many.res.statusCode]).toEqual([200, 200]);
      expect(selectedItems(one.res.body)).toEqual([SOLO, B_SOLO]);
      expect(selectedItems(many.res.body)).toEqual([...MANY, ...B_MANY]);
      // A pool row's crumbs end at its own site's home page, which only tenant-b's transaction reads.
      expect(one.res.body.match(new RegExp(`data-contentid="${B_SOLO}"[\\s\\S]*?</ul>`))?.[0]).toContain('Home B');
      expect(many.trips).toEqual(one.trips);
    });

    it.each([
      ['first', [TENANT_UMBRELLA.siteId, SITE]],
      ['last', [SITE, TENANT_B.siteId, TENANT_UMBRELLA.siteId]],
    ] as Array<[string, string[]]>)('answers 403 site-mismatch for a client row of a site outside the pool, %s among the rows', async (_label, sites) => {
      const rows = sites.map((siteId, i) => clientRows([siteId === TENANT_B.siteId ? B_SOLO : MANY[i] ?? ''], siteId)[0]);
      const res = await raw('loadselectedrelatedcontent', { contenthistid: NODES[1].contentHistId, type: 'Page', subtype: 'Default', relatedcontentsetid: 'custom', relateditems: JSON.stringify(rows) });
      expect(res.statusCode, res.body).toBe(403);
    });

    it('answers the row error of a client row before the site-mismatch of a later row', async () => {
      const rows = [{ contentid: SOLO, siteid: SITE, type: 'Page', subtype: 'Default', title: 'no url' }, ...clientRows([MANY[0] ?? ''], TENANT_UMBRELLA.siteId)];
      const res = await raw('loadselectedrelatedcontent', { contenthistid: NODES[1].contentHistId, type: 'Page', subtype: 'Default', relatedcontentsetid: 'custom', relateditems: JSON.stringify(rows) });
      expect(res.statusCode, res.body).toBe(500);
    });
  });
});
