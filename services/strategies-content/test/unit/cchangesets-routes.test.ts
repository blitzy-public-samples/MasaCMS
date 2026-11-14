/** routes/v1/cchangesets over the recording pool: declarations, the circuit gate, screen models, token-gated writes, fail-closed site settings and the tag array. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Roles, collectRouteMatrix, moduleRole, type Role } from '@opt2/platform/auth';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { pendingApprovalCount, rollback } from '../../src/domain/changesets.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { CHANGESET_SITE_SETTINGS_REASON, cchangesetsRawActions, registerChangesetRoutes } from '../../src/routes/v1/cchangesets.js';
import { TEST_CLOCK, buildContentApp, userHeaders, type ContentTestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Json>>;
  'x-opt2-excluded': Array<{ key: string }>;
};

const SITE = TENANT_A.siteId;
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const CS = 'D1E2F3A4-0001-4A5B-8C7D9E0F1A2B3C4D';
const HIST = 'E1F2A3B4-0001-4A5B-8C7D9E0F1A2B3C4D';
const COMPONENT = 'F1A2B3C4-0001-4A5B-8C7D9E0F1A2B3C4D';
const COMPONENT_ROOT = '00000000000000000000000000000000003';
const CAT_A = 'A0000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const CAT_B = 'A0000000-0002-4A5B-8C7D9E0F1A2B3C4D';
const CAT_C = 'A0000000-0003-4A5B-8C7D9E0F1A2B3C4D';
const m = (digits: string): Role => moduleRole(`00000000000000000000000000000000${digits}`);
const MODULE_PAIR: readonly Role[] = [Roles.systemUser, m('014'), m('000')];
const TOKEN = { 'x-csrf_token': 'T0KEN', 'x-csrf_token_expires': '260630235959000' } as const;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const PUBLISHED_AT = new Date(2026, 5, 1, 9, 30, 0, 0);
const UPDATED_AT = new Date(2026, 5, 2, 14, 5, 6, 7);

const FEED_COUNT = /^SELECT count\(\*\)::integer AS total FROM \(SELECT \* FROM "content"\."changeset" WHERE/;
const FEED_PAGE = /^SELECT \* FROM "content"\."changeset" WHERE .* ORDER BY changesetid LIMIT \$\d+ OFFSET/;
const FIND_CHANGESET = /^SELECT \* FROM "content"\."changeset" WHERE .* LIMIT 1$/;
const CATEGORY_COUNT = /AS thecount FROM "content"\."category"/;
const CATEGORY_LEVEL = /AS haskids FROM "content"\."category" c/;
const PENDING = /AS pending FROM "content"\."content" c/;
const ASSIGNMENTS = /^SELECT c\.menutitle, c\.siteid, c\.parentid, c\.path/;
const CRUMBS = /FROM "content"\."content" tcontent LEFT JOIN/;
const ROLLBACK_ROWS = /FROM "content"\."changeset_rollback" WHERE/;
const VERSION = /"content"\."content"/;
const TAG_CLOUD = /^SELECT tag, count\(tag\)::integer AS tagcount FROM "content"\."changeset_tag_assign"/;

/** The s2 actor of tenant-a, as `actorFor` builds it from verified claims. */
const ADMIN = actorFromClaims(
  { iss: 'opt2-local-identity', aud: 'opt2-local', sub: USER_ID, sid: 'S1', tid: TENANT_A.tenantId, site: SITE, roles: [Roles.s2], s2: true, epoch: 0, iat: 0, exp: 0 },
  'Admin User',
);

let t: ContentTestApp;
let ctx: ContentRouteContext;
let csrfValid = true;
const consumed: CsrfConsumeRequest[] = [];

/** A stored tchangesets row of tenant-a. */
function changesetRow(overrides: Json = {}): Json {
  return {
    tenant_id: TENANT_A.tenantId,
    changesetid: CS,
    siteid: SITE,
    name: 'Summer',
    description: 'd',
    created: UPDATED_AT,
    publishdate: PUBLISHED_AT,
    published: 1,
    lastupdate: UPDATED_AT,
    lastupdateby: 'Admin User',
    lastupdatebyid: USER_ID,
    remoteid: '',
    remotepubdate: null,
    remotesourceurl: '',
    closedate: null,
    ...overrides,
  };
}

/** The route's answer, checked against the contract unless its status is one the operation does not declare. */
async function call(request: { method: 'GET' | 'POST'; url: string; roles?: readonly Role[] | null; site?: string; headers?: Json; payload?: string }): Promise<InjectResponse> {
  const { method, url, roles = [Roles.siteAdmin], site = SITE, headers = {}, payload } = request;
  const auth = roles === null ? {} : await userHeaders({ sub: USER_ID, site, roles });
  const res = await t.app.inject({ method, url, headers: { ...auth, ...(headers as Record<string, string>) }, ...(payload === undefined ? {} : { payload }) });
  if (res.statusCode !== 500) {
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url.split('?')[0] ?? url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  }
  return res;
}

const post = (url: string, form: Record<string, string>, headers: Json = TOKEN, roles: readonly Role[] = [Roles.siteAdmin]) =>
  call({ method: 'POST', url, roles, headers: { ...FORM, ...headers }, payload: new URLSearchParams(form).toString() });

/** A statement's parameters with array parameters flattened, as id lists bind them. */
const flat = (params: readonly unknown[]): unknown[] => params.flatMap((value) => (Array.isArray(value) ? (value as unknown[]) : [value]));

/** Whether any recorded statement matches `pattern`. */
const ran = (pattern: RegExp): boolean => t.db.statements.some((statement) => pattern.test(statement.sql));

/** The identity CSRF consume answering `csrfValid`; any other service call fails the test. */
function stubIdentity(app: FastifyInstance): void {
  const request = <T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> => {
    if (req.service === IDENTITY_SERVICE && req.method === 'POST' && req.path === CSRF_CONSUME_PATH) {
      consumed.push(req.json as CsrfConsumeRequest);
      return Promise.resolve({ status: 200, headers: {}, body: { valid: csrfValid } as T });
    }
    return Promise.reject(new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`));
  };
  Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
}

beforeAll(async () => {
  t = await buildContentApp({
    declare: (app) => {
      const db = app.opt2.db;
      if (db === undefined) throw new TypeError('the test app has no pool');
      ctx = {
        domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
        clock: TEST_CLOCK,
        actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Admin User'),
      } as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;
      return registerChangesetRoutes(app, ctx);
    },
  });
  stubIdentity(t.app);
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.db.reset();
  consumed.length = 0;
  csrfValid = true;
});

describe('route declarations', () => {
  const contract = Object.entries(OPENAPI.paths)
    .filter(([path]) => path.startsWith('/v1/sites/'))
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) => ((op['x-opt2-legacy-actions'] as string[] | undefined) ?? [])[0]?.startsWith('cchangesets.') === true)
        .map(([method, op]) => ({
          method: method.toUpperCase(),
          url: path.replace(/\{(\w+)\}/g, ':$1'),
          transport: op['x-opt2-transport'],
          requires: [...(op['x-opt2-requires'] as string[])].sort(),
        })),
    );
  const byKey = (a: Json, b: Json): number => (`${String(a.method)} ${String(a.url)}` < `${String(b.method)} ${String(b.url)}` ? -1 : 1);

  it('registers exactly the contract cchangesets operations with their roles and transport', () => {
    const registered = collectRouteMatrix(t.app)
      .routes.filter((route) => route.url.startsWith('/v1/sites/:siteid/changesets'))
      .map((route) => ({ method: route.method, url: route.url, transport: route.transport, requires: [...(route.requires ?? [])].sort() }));
    expect(contract).toHaveLength(7);
    expect(registered.sort(byKey)).toEqual([...contract].sort(byKey));
  });

  it('builds nothing for the withheld publish action', async () => {
    expect(OPENAPI['x-opt2-excluded'].map(({ key }) => key)).toContain('admin:cchangesets.publish');
    const res = await t.app.inject({ method: 'POST', url: `/v1/sites/${SITE}/changesets/${CS}/publish`, headers: await userHeaders({ sub: USER_ID, site: SITE, roles: [Roles.s2] }) });
    expect(res.statusCode).toBe(404);
    expect(consumed).toEqual([]);
  });

  it('exposes the loadtagarray raw entry without a CSRF context', () => {
    expect(Object.keys(cchangesetsRawActions)).toEqual(['loadtagarray']);
    expect('csrfContext' in cchangesetsRawActions.loadtagarray).toBe(false);
  });
});

describe('circuit gate', () => {
  const ROUTES: ReadonlyArray<readonly [string, 'GET' | 'POST', string]> = [
    ['list', 'GET', `/v1/sites/${SITE}/changesets`],
    ['save', 'POST', `/v1/sites/${SITE}/changesets`],
    ['edit', 'GET', `/v1/sites/${SITE}/changesets/${CS}`],
    ['delete', 'POST', `/v1/sites/${SITE}/changesets/${CS}/delete`],
    ['rollback', 'POST', `/v1/sites/${SITE}/changesets/${CS}/rollback`],
    ['assignments', 'GET', `/v1/sites/${SITE}/changesets/${CS}/assignments`],
    ['removeitem', 'POST', `/v1/sites/${SITE}/changesets/${CS}/items/${HIST}/remove`],
  ];

  it.each(ROUTES)('%s refuses m:014 without m:000 before reading data or consuming a token', async (_action, method, url) => {
    const res = await call({ method, url, roles: [Roles.systemUser, m('014')], headers: { ...FORM, ...TOKEN }, ...(method === 'POST' ? { payload: `changesetid=${CS}` } : {}) });
    expect(res.statusCode).toBe(403);
    expect([t.db.statements, consumed]).toEqual([[], []]);
  });

  it.each([
    ['s2', [Roles.systemUser, Roles.s2], SITE, 200],
    ['a site admin', [Roles.systemUser, Roles.siteAdmin], SITE, 200],
    ['m:014 with m:000', MODULE_PAIR, SITE, 200],
    ['m:000 alone', [Roles.systemUser, m('000')], SITE, 403],
    ['a member', [Roles.member], SITE, 403],
    ['a token of another site', [Roles.systemUser, Roles.s2], TENANT_B.siteId, 403],
    ['no credential', null, SITE, 401],
  ] as const)('list admits %s with %i', async (_name, roles, site, status) => {
    t.db.respond(FEED_COUNT, [{ total: 0 }]);
    const res = await call({ method: 'GET', url: `/v1/sites/${SITE}/changesets`, roles, site });
    expect(res.statusCode, res.body).toBe(status);
  });
});

describe('screen models', () => {
  /** A category level row as categoryGateway.getCategories selects it. */
  const category = (categoryid: string, name: string, extra: Json = {}): Json => ({
    siteid: 'umbrella',
    categoryid,
    name,
    parentid: null,
    isopen: 1,
    restrictgroups: '',
    haskids: 0,
    ...extra,
  });

  /** Two top-level categories, the first with one child; the second restricted to a group. */
  function seedCategories(): void {
    t.db.respond(CATEGORY_COUNT, [{ thecount: 3 }]);
    t.db.respond(CATEGORY_LEVEL, (params) =>
      flat(params).includes(CAT_A)
        ? [category(CAT_C, 'Child', { parentid: CAT_A, isopen: 0 })]
        : [category(CAT_A, 'Alpha', { haskids: 1 }), category(CAT_B, 'Beta', { restrictgroups: 'Insiders' })],
    );
  }

  it('lists a page of published change sets with the iterator paging and the category tree', async () => {
    t.db.respond(FEED_COUNT, [{ total: 25 }]);
    t.db.respond(FEED_PAGE, [changesetRow()]);
    seedCategories();
    const res = await call({ method: 'GET', url: `/v1/sites/${SITE}/changesets?page=2&keywords=Sum`, roles: MODULE_PAIR });
    expect(res.statusCode, res.body).toBe(200);
    const { rc } = res.json() as { rc: Json };
    expect(rc.changesets).toEqual({
      pageIndex: 2,
      pageCount: 2,
      recordCount: 25,
      firstRecordOnPageIndex: 21,
      lastRecordOnPageIndex: 25,
      items: [
        expect.objectContaining({
          changesetID: CS,
          siteID: SITE,
          name: 'Summer',
          published: 1,
          publishDate: '2026-06-01T09:30:00.000',
          lastUpdate: '2026-06-02T14:05:06.007',
          closeDate: '',
          isNew: 1,
        }),
      ],
    });
    expect(rc.categoryCount).toBe(3);
    expect(rc.categories).toEqual([
      {
        categoryID: CAT_A,
        parentID: '',
        name: 'Alpha',
        isOpen: true,
        permitted: true,
        children: [{ categoryID: CAT_C, parentID: CAT_A, name: 'Child', isOpen: false, permitted: true, children: [] }],
      },
      // The module pair holds no Insiders membership, so the restricted category's checkbox is disabled.
      { categoryID: CAT_B, parentID: '', name: 'Beta', isOpen: true, permitted: false, children: [] },
    ]);
  });

  it('answers an empty list without the category tree when the site has no categories', async () => {
    t.db.respond(FEED_COUNT, [{ total: 0 }]);
    const res = await call({ method: 'GET', url: `/v1/sites/${SITE}/changesets` });
    expect(res.json()).toEqual({
      rc: {
        changesets: { pageIndex: 1, pageCount: 0, recordCount: 0, firstRecordOnPageIndex: 1, lastRecordOnPageIndex: 0, items: [] },
        categoryCount: 0,
        categories: [],
      },
    });
    expect(ran(CATEGORY_LEVEL)).toBe(false);
  });

  it.each([
    ['a list page holding an unpublished change set', 'GET', `/v1/sites/${SITE}/changesets`, () => {
      t.db.respond(FEED_COUNT, [{ total: 1 }]);
      t.db.respond(FEED_PAGE, [changesetRow({ published: 0 })]);
    }],
    ['the edit view of a stored unpublished change set', 'GET', `/v1/sites/${SITE}/changesets/${CS}`, () => {
      t.db.respond(FIND_CHANGESET, [changesetRow({ published: 0 })]);
    }],
    ['the assignments of an unpublished change set', 'GET', `/v1/sites/${SITE}/changesets/${CS}/assignments`, () => {
      t.db.respond(FIND_CHANGESET, [changesetRow({ published: 0 })]);
    }],
    ['published assignments holding a site architecture row', 'GET', `/v1/sites/${SITE}/changesets/${CS}/assignments`, () => {
      t.db.respond(FIND_CHANGESET, [changesetRow()]);
      t.db.respond(ASSIGNMENTS, (params) => (flat(params).includes('00000000000000000000000000000000000') ? [{ contentid: HIST, contenthistid: HIST, path: null }] : []));
    }],
  ] as const)('fails closed on %s, whose preview URLs need site settings', async (_name, method, url, seed) => {
    seed();
    const res = await call({ method, url });
    expect(res.statusCode, res.body).toBe(503);
    expect(CHANGESET_SITE_SETTINGS_REASON).toBe('changeset-site-settings');
  });

  it('edits a new change set with its pending-approval count and no categories', async () => {
    t.db.respond(PENDING, [{ pending: 0 }]);
    const res = await call({ method: 'GET', url: `/v1/sites/${SITE}/changesets/${CS}` });
    expect(res.statusCode, res.body).toBe(200);
    const { rc } = res.json() as { rc: Json };
    expect(rc).toMatchObject({ changeset: { isNew: 1, published: 0, lastUpdateBy: 'Admin User', errors: {} }, hasPendingApprovals: 0, categoryCount: 0, categories: [] });
    expect(ran(PENDING)).toBe(true);
  });

  it('edits a published change set as flat category rows, without asking for pending approvals', async () => {
    t.db.respond(FIND_CHANGESET, [changesetRow()]);
    seedCategories();
    const res = await call({ method: 'GET', url: `/v1/sites/${SITE}/changesets/${CS}`, roles: [Roles.s2] });
    expect(res.statusCode, res.body).toBe(200);
    const { rc } = res.json() as { rc: Json };
    expect(rc).not.toHaveProperty('hasPendingApprovals');
    expect(rc.changeset).toMatchObject({ changesetID: CS, isNew: 0, publishDate: '2026-06-01T09:30:00.000' });
    expect(rc.categories).toEqual([
      { categoryID: CAT_A, parentID: '', name: 'Alpha', isOpen: true, permitted: true },
      { categoryID: CAT_C, parentID: CAT_A, name: 'Child', isOpen: false, permitted: true },
      { categoryID: CAT_B, parentID: '', name: 'Beta', isOpen: true, permitted: true },
    ]);
    expect(ran(PENDING)).toBe(false);
  });

  it('lists a published change set’s component rows with their crumbs, icons and node verdict', async () => {
    t.db.respond(FIND_CHANGESET, [changesetRow()]);
    t.db.respond(ASSIGNMENTS, (params) =>
      flat(params).includes(COMPONENT_ROOT)
        ? [{ contentid: COMPONENT, contenthistid: HIST, changesetid: CS, type: 'Component', moduleid: COMPONENT_ROOT, path: `${COMPONENT_ROOT},${COMPONENT}`, menutitle: 'Promo', approved: 1, active: 0, lastupdate: UPDATED_AT, approvalstatus: null }]
        : [],
    );
    t.db.respond(CRUMBS, [
      { contentid: COMPONENT, siteid: SITE, type: 'Component', subtype: 'Default', menutitle: 'Promo', restricted: 0, moduleid: COMPONENT_ROOT, contenthistid: HIST },
      { contentid: COMPONENT_ROOT, siteid: SITE, type: 'Module', subtype: 'Default', menutitle: 'Components', restricted: 0, moduleid: COMPONENT_ROOT, contenthistid: HIST },
    ]);
    const res = await call({ method: 'GET', url: `/v1/sites/${SITE}/changesets/${CS}/assignments?keywords=pro` });
    expect(res.statusCode, res.body).toBe(200);
    const { rc } = res.json() as { rc: Json };
    expect(rc).not.toHaveProperty('variationAssignments');
    expect(rc).toMatchObject({ changeset: { changesetID: CS, published: 1 }, siteAssignments: [], formAssignments: [] });
    expect(rc.componentAssignments).toEqual([
      expect.objectContaining({
        contenthistid: HIST,
        menutitle: 'Promo',
        lastupdate: '2026-06-02T14:05:06.007',
        verdict: 'editor',
        crumbdata: [
          expect.objectContaining({ contentid: COMPONENT, type: 'Component', icon: 'mi-align-justify' }),
          expect.objectContaining({ contentid: COMPONENT_ROOT, type: 'Module', icon: 'mi-cog' }),
        ],
      }),
    ]);
  });
});

describe('token-gated writes', () => {
  const SAVE_URL = `/v1/sites/${SITE}/changesets`;
  const NEW_ID = 'D1E2F3A4-0009-4A5B-8C7D9E0F1A2B3C4D';
  const CHANGESET_WRITE = /^(INSERT INTO|UPDATE|DELETE FROM) "content"\."changeset"/;

  it('saves a valid change set and redirects to the list with the saved id and the site', async () => {
    const res = await post(SAVE_URL, { changesetID: NEW_ID, siteid: SITE, name: 'Autumn', muraAction: 'cChangesets.save' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      saved: true,
      errors: {},
      redirect: { circuit: 'cChangesets', action: 'list', params: [['changesetID', NEW_ID], ['siteID', SITE]] },
    });
    expect(consumed).toEqual([expect.objectContaining({ context: NEW_ID, token: TOKEN['x-csrf_token'] })]);
    expect(ran(/^INSERT INTO "content"\."changeset" /)).toBe(true);
  });

  it('re-renders the edit view with the bean’s errors when the save is invalid', async () => {
    t.db.respond(PENDING, [{ pending: 0 }]);
    const res = await post(SAVE_URL, { changesetID: NEW_ID, siteid: SITE, name: '' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { saved: boolean; errors: Json; redirect: unknown; data: { rc: Json } };
    const errors = { name: "The property named 'name' is not valid" };
    expect(body).toMatchObject({ saved: false, errors, redirect: null });
    expect(body.data.rc).toMatchObject({ changeset: { changesetID: NEW_ID, isNew: 1, errors }, hasPendingApprovals: 0, categoryCount: 0, categories: [] });
    expect(ran(CHANGESET_WRITE)).toBe(false);
  });

  it('skips the save of a refused token and leaves no change set for the view', async () => {
    csrfValid = false;
    const res = await post(SAVE_URL, { changesetID: NEW_ID, siteid: SITE, name: 'Autumn' });
    expect(res.json()).toEqual({ saved: false, errors: {}, redirect: null, data: { rc: {} } });
    expect(t.db.statements).toEqual([]);
  });

  it('fails as legacy does on a save without a change-set id, before consuming a token', async () => {
    const res = await post(SAVE_URL, { siteid: SITE, name: 'Autumn' });
    expect(res.statusCode).toBe(500);
    expect([consumed, t.db.statements]).toEqual([[], []]);
  });

  it.each([
    ['delete', `/v1/sites/${SITE}/changesets/${CS}/delete`, 'list', ['changesetID', 'siteID'], /^INSERT INTO "content"\."trash" /],
    ['rollback', `/v1/sites/${SITE}/changesets/${CS}/rollback`, 'edit', ['changesetID', 'siteID'], CHANGESET_WRITE],
    ['removeitem', `/v1/sites/${SITE}/changesets/${CS}/items/${HIST}/remove`, 'assignments', ['changesetID', 'siteID', 'keywords'], VERSION],
  ] as const)('%s writes only with a valid token and redirects either way', async (_action, url, action, keys, write) => {
    t.db.respond(FIND_CHANGESET, [changesetRow({ published: 0 })]);
    const expected = (saved: boolean) => ({
      saved,
      errors: {},
      redirect: { circuit: 'cChangesets', action, params: keys.map((key) => [key, { changesetID: CS, siteID: SITE, keywords: '' }[key]]) },
    });
    csrfValid = false;
    expect((await post(url, { changesetID: CS })).json()).toEqual(expected(false));
    expect(t.db.statements).toEqual([]);
    csrfValid = true;
    expect((await post(url, { changesetID: CS })).json()).toEqual(expected(true));
    expect(consumed.map(({ context }) => context)).toEqual([CS, CS]);
    expect(ran(write)).toBe(true);
  });

  it('fails closed, writing nothing, when a published rollback must re-save a version', async () => {
    t.db.respond(FIND_CHANGESET, [changesetRow()]);
    t.db.respond(ROLLBACK_ROWS, [{ rollbackid: 'R1', changesetid: CS, siteid: SITE, previoushistid: HIST, changesethistid: HIST }]);
    t.db.respond(/^SELECT .* FROM "content"\."content" .*contenthistid/, [{ contenthistid: HIST, contentid: COMPONENT, siteid: SITE }]);
    const res = await post(`/v1/sites/${SITE}/changesets/${CS}/rollback`, { changesetID: CS });
    expect(res.statusCode, res.body).toBe(503);
    expect(ran(/^ROLLBACK/)).toBe(true);
    expect(ran(CHANGESET_WRITE)).toBe(false);
  });

  it('refuses a posted siteid of another site before consuming a token', async () => {
    const res = await post(`/v1/sites/${SITE}/changesets/${CS}/delete`, { changesetID: CS, siteID: TENANT_B.siteId });
    expect(res.statusCode).toBe(403);
    expect([consumed, t.db.statements]).toEqual([[], []]);
  });
});

describe('loadtagarray', () => {
  it('renders the tenant’s tag cloud as the cchangesets view does, a NULL tag as empty', async () => {
    t.db.respond(TAG_CLOUD, [{ tag: 'Promo', tagcount: 2 }, { tag: null, tagcount: 0 }, { tag: "o'brien", tagcount: 1 }]);
    const out = await cchangesetsRawActions.loadtagarray.run({} as FastifyRequest, ctx, ADMIN);
    const item = (tag: string): string => `{id: '${tag}', toString: function() { return '${tag}'; } }`;
    expect(out).toEqual({ status: 200, contentType: 'text/html;charset=UTF-8', body: `[${item('Promo')},${item('')},${item('o\\x27brien')}]` });
    expect(t.db.statements.find((statement) => TAG_CLOUD.test(statement.sql))?.tenantId).toBe(TENANT_A.tenantId);
  });
});

describe('domain reads and the rollback site source', () => {
  it('counts the pending approvals of a change set in the actor’s tenant', async () => {
    t.db.respond(PENDING, [{ pending: 2 }]);
    expect(await pendingApprovalCount(ctx.domain, ADMIN, CS)).toBe(2);
    expect(t.db.statements.find((statement) => PENDING.test(statement.sql))?.tenantId).toBe(TENANT_A.tenantId);
  });

  it('calls a site provider only for a version to re-save, and writes nothing when it throws', async () => {
    let calls = 0;
    const site = (): never => {
      calls += 1;
      throw new Error('no site settings');
    };
    t.db.respond(FIND_CHANGESET, [changesetRow({ published: 0 })]);
    await rollback(ctx.domain, ADMIN, site, CS);
    expect(calls).toBe(0);
    t.db.reset();
    t.db.respond(FIND_CHANGESET, [changesetRow()]);
    t.db.respond(ROLLBACK_ROWS, [{ rollbackid: 'R1', changesetid: CS, siteid: SITE, previoushistid: HIST, changesethistid: HIST }]);
    t.db.respond(/^SELECT .* FROM "content"\."content" .*contenthistid/, [{ contenthistid: HIST, contentid: COMPONENT, siteid: SITE }]);
    await expect(rollback(ctx.domain, ADMIN, site, CS)).rejects.toThrow('no site settings');
    expect(calls).toBe(1);
    expect(ran(/^ROLLBACK/)).toBe(true);
  });
});
