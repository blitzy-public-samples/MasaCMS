/** The cchain admin routes through `app.inject`: contract declarations, the before() gate, screen models, saves and deletes. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { Roles, collectRouteMatrix, moduleRole, type Role } from '@opt2/platform/auth';
import { CSRF_CONSUME_PATH, type CsrfConsumeRequest } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { CCHAIN_PENDING_PREVIEW_EXCEPTION, CCHAIN_SITE_SETTINGS_REASON, registerChainRoutes } from '../../src/routes/v1/cchain.js';
import { TEST_CLOCK, buildContentApp, serviceHeaders, userHeaders, type ContentTestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Json>>;
};
const OPERATIONS = ['listApprovalChains', 'saveApprovalChain', 'getApprovalChain', 'deleteApprovalChain', 'listPendingApprovals'];
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const CHAIN = 'A9B8C7D6-0001-4A5B-8C7D9E0F1A2B3C4D';
const GROUP_1 = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const GROUP_2 = 'A1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D';
const REQUEST_ID = 'B9B8C7D6-0001-4A5B-8C7D9E0F1A2B3C4D';
const HIST_ID = 'C9B8C7D6-0001-4A5B-8C7D9E0F1A2B3C4D';
const CONTENT_ID = 'D9B8C7D6-0001-4A5B-8C7D9E0F1A2B3C4D';
const CHANGESET = 'E9B8C7D6-0001-4A5B-8C7D9E0F1A2B3C4D';
const COMPONENTS = '00000000000000000000000000000000003';
const FORMS = '00000000000000000000000000000000004';
const ROOT_PARENT = '00000000000000000000000000000000END';
const REQUESTS = /FROM "content"\."approval_request" WHERE/i;
const VERSIONS = /tapprovalrequests\.status AS approvalstatus/i;
const CHANGESETS = /FROM "content"\."changeset" WHERE/i;
const CRUMBS = /tapprovalassignments\.chainid/i;
const SUBTYPES = /FROM "content"\."extend_subtype"/i;
const CHAINS_URL = `/v1/sites/${SITE_A}/approval-chains`;
const CHAIN_URL = `${CHAINS_URL}/${CHAIN}`;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const TOKEN = 'csrf_token=tok&csrf_token_expires=exp';
const LIST_REDIRECT = { circuit: 'cchain', action: 'list', params: [['siteid', SITE_A]] };
const ADMIN_ROLES: readonly Role[] = [Roles.systemUser, Roles.siteAdmin];

let t: ContentTestApp;
let csrfValid = true;
const consumed: CsrfConsumeRequest[] = [];
/** The errors the routes raised, as the error handler receives them. */
const routeErrors: Error[] = [];

function adminHeaders(roles: readonly Role[] = ADMIN_ROLES, site = SITE_A, s2?: boolean): Promise<Record<string, string>> {
  return userHeaders({ sub: USER_ID, site, roles, ...(s2 === undefined ? {} : { s2 }) });
}

/** A stored `content.approval_chain` row of tenant-a. */
function chainRow(): Json {
  return {
    tenant_id: TENANT_A.tenantId,
    chainid: CHAIN,
    siteid: SITE_A,
    name: 'Chain A',
    description: null,
    created: new Date(2026, 5, 30, 9, 5, 3, 7),
    lastupdate: new Date(2026, 5, 30, 10, 0, 0, 0),
    lastupdateby: 'Admin User',
    lastupdatebyid: USER_ID,
  };
}

/** A stored membership of the chain with GROUP_1 first. */
function membershipRow(): Json {
  return { tenant_id: TENANT_A.tenantId, membershipid: 'M1', chainid: CHAIN, groupid: GROUP_1, orderno: 1, created: null, siteid: null };
}

/** A projected group of tenant-a's private pool. */
function groupRow(groupId: string, name: string): Json {
  return { tenant_id: TENANT_A.tenantId, group_id: groupId, group_name: name, site_id: SITE_A, is_public: 0, deleted: false };
}

/** A pending `content.approval_request` row of the chain, created at `hour` on the business date. */
function requestRow(requestid: string, groupid: string, contenthistid: string, hour: number): Json {
  return { tenant_id: TENANT_A.tenantId, requestid, contenthistid, chainid: CHAIN, siteid: SITE_A, userid: USER_ID, groupid, status: 'Pending', created: new Date(2026, 5, 30, hour, 0, 0, 0) };
}

/** A version as the contentDAO read returns it. */
function versionRow(contenthistid: string, contentid: string, type: string, extra: Json = {}): Json {
  return {
    contentid,
    contenthistid,
    siteid: SITE_A,
    moduleid: '00000000000000000000000000000000000',
    parentid: '00000000000000000000000000000000001',
    title: 'T',
    menutitle: 'M',
    type,
    subtype: 'Default',
    filename: null,
    fileid: null,
    changesetid: null,
    summary: null,
    lastupdate: null,
    lastupdateby: 'Admin User',
    lastupdatebyid: USER_ID,
    path: null,
    ...extra,
  };
}

/** A `buildCrumblist` row, every column NULL unless given; `path` only orders the read. */
function crumbRow(contentid: string, type: string, extra: Json = {}): Json {
  const nulls = Object.fromEntries(
    'title,menutitle,urltitle,filename,parentid,target,targetparams,restricted,restrictgroups,template,childtemplate,inheritobjects,metadesc,metakeywords,sortby,sortdirection,moduleid,fileext,chainid,exemptid,path'
      .split(',')
      .map((column) => [column, null]),
  );
  return { ...nulls, contenthistid: `CH-${contentid}`, contentid, type, subtype: 'Default', siteid: SITE_A, ...extra };
}

/** One `crumbArray` entry as the route answers it: every crumb key, NULL as '', with its icon. */
function wireCrumb(contentid: string, type: string, extra: Json): Json {
  const empty = Object.fromEntries(
    'filename,title,menutitle,urltitle,target,parentid,restricted,restrictgroups,template,targetprams,metadesc,metakeywords,sortby,sortdirection,inheritobjects,fileext,chainid,exemptid,moduleid'
      .split(',')
      .map((key) => [key, '']),
  );
  return { ...empty, type, subtype: 'Default', contentid, siteid: SITE_A, contenthistid: `CH-${contentid}`, ...extra };
}

/** The crumb rows the content tree holds: the component and form modules and their nodes. */
const CRUMB_ROWS: readonly Json[] = [
  crumbRow(CONTENT_ID, 'Component', { title: 'Footer', menutitle: 'Footer', moduleid: COMPONENTS, parentid: COMPONENTS, restricted: 0, path: `${COMPONENTS},${CONTENT_ID}` }),
  crumbRow(COMPONENTS, 'Module', { title: 'Components', menutitle: 'Components', moduleid: COMPONENTS, parentid: ROOT_PARENT, path: COMPONENTS }),
  crumbRow(FORMS, 'Folder', { subtype: 'Forms', title: 'Forms', menutitle: 'Forms', parentid: ROOT_PARENT, restricted: 1, path: FORMS }),
  crumbRow('FORM-1', 'Form', { title: 'Contact', moduleid: FORMS, parentid: FORMS, path: `${FORMS},FORM-1` }),
  crumbRow('FORM-2', 'Form', { title: 'Survey', menutitle: '', moduleid: FORMS, parentid: FORMS }),
];

/** The id forms an `= ANY(…::bpchar[])` statement binds last. */
function lastArray(params: readonly unknown[]): string[] {
  return (params.filter(Array.isArray).at(-1) ?? []) as string[];
}

/** Answers the chain, its memberships and groups, and the requests, versions and crumbs the binds select, deepest crumb first. */
function seedPending(memberships: readonly Json[], requests: readonly Json[], versions: readonly Json[]): void {
  t.db.respond(/FROM "content"\."approval_chain"/i, [chainRow()]);
  t.db.respond(/FROM "content"\."approval_membership"/i, memberships);
  t.db.respond(/FROM "content"\."group_projection"/i, [groupRow(GROUP_1, 'Admin'), groupRow(GROUP_2, 'Editors')]);
  t.db.respond(REQUESTS, (params) => requests.filter((row) => lastArray(params).includes(String(row.groupid))));
  t.db.respond(VERSIONS, (params) => versions.filter((row) => lastArray(params).includes(String(row.contenthistid))));
  const depth = (row: Json): number => (typeof row.path === 'string' ? row.path.length : -1);
  t.db.respond(CRUMBS, (params) => CRUMB_ROWS.filter((row) => lastArray(params).includes(String(row.contentid))).sort((a, b) => depth(b) - depth(a)));
}

/** Sends a request and holds the answer to its contract operation. */
async function call(method: Method, url: string, headers: Record<string, string>, payload?: string): Promise<InjectResponse> {
  const res = await t.app.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...FORM }, ...(payload === undefined ? {} : { payload }) });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** Business writes the requests made, gate and changelog bookkeeping excluded. */
function writes(): string[] {
  return t.db.statements.map((statement) => statement.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/i.test(sql) && !/changelog|unit_gate/i.test(sql));
}

beforeAll(async () => {
  t = await buildContentApp({
    declare: (app) => {
      const db = app.opt2.db;
      if (db === undefined) throw new Error('the test app has no database');
      const ctx = {
        domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
        clock: TEST_CLOCK,
        actorFor: async (request) => actorFromClaims(request.opt2Auth.user, 'Admin User'),
      } satisfies Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'>;
      app.addHook('onError', async (_request, _reply, error) => {
        routeErrors.push(error);
      });
      return registerChainRoutes(app, ctx as ContentRouteContext);
    },
  });
  // Identity is the only service the CSRF hook calls; it answers with the test's verdict and records each consume.
  vi.spyOn(t.app.opt2.client, 'request').mockImplementation(async (request) => {
    if (request.path !== CSRF_CONSUME_PATH) throw new Error(`unexpected service call ${request.path}`);
    consumed.push(request.json as CsrfConsumeRequest);
    return { status: 200, headers: {}, body: { valid: csrfValid } } as never;
  });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.db.reset();
  consumed.length = 0;
  routeErrors.length = 0;
  csrfValid = true;
  // PostgreSQL returns every column of an inserted row, the defaulted ones as NULL.
  t.db.respond(/^INSERT INTO "content"\."approval_membership"/i, (p) => [
    { tenant_id: p[0], membershipid: p[1], chainid: p[2], groupid: p[3], orderno: p[4], created: p[5], siteid: null },
  ]);
  t.db.respond(/^INSERT INTO "content"\."approval_chain" /i, (p, sql) => {
    const columns = (/\(([^)]*)\) VALUES/.exec(sql)?.[1] ?? '').split(',').map((column) => column.trim().replace(/"/g, ''));
    const nulls = { siteid: null, name: null, created: null, lastupdate: null, description: null, lastupdateby: null, lastupdatebyid: null };
    return [{ ...nulls, ...Object.fromEntries(columns.map((column, i) => [column, p[i] ?? null])) }];
  });
});

describe('declarations', () => {
  it('registers exactly the contract operations, each with its roles and transport', () => {
    const contract = Object.entries(OPENAPI.paths).flatMap(([template, item]) =>
      (['get', 'post'] as const).flatMap((method) => {
        const operation = item[method];
        if (operation === undefined || !OPERATIONS.includes(String(operation.operationId))) return [];
        const requires = [...(operation['x-opt2-requires'] as string[])].sort();
        return [{ method: method.toUpperCase(), url: template.replace(/\{(\w+)\}/g, ':$1'), transport: operation['x-opt2-transport'], requires }];
      }),
    );
    const registered = collectRouteMatrix(t.app)
      .routes.filter((route) => route.url.includes('/approval-chains'))
      .map((route) => ({ method: route.method, url: route.url, transport: route.transport, requires: [...(route.requires ?? [])].sort() }));
    const byRoute = (a: Json, b: Json): number => (`${String(a.method)} ${String(a.url)}` < `${String(b.method)} ${String(b.url)}` ? -1 : 1);
    expect(contract).toHaveLength(OPERATIONS.length);
    expect(registered.sort(byRoute)).toEqual(contract.sort(byRoute));
  });
});

describe('before() gate', () => {
  const routes: Array<[Method, string, string | undefined]> = [
    ['GET', CHAINS_URL, undefined],
    ['GET', CHAIN_URL, undefined],
    ['GET', `${CHAIN_URL}/pending`, undefined],
    ['POST', CHAINS_URL, `chainid=${CHAIN}&name=X&${TOKEN}`],
    ['POST', `${CHAIN_URL}/delete`, `chainid=${CHAIN}&${TOKEN}`],
  ];
  const refused: Array<[string, () => Promise<Record<string, string>>, number]> = [
    ['anonymous', () => serviceHeaders('gateway'), 401],
    ['a public member', () => adminHeaders([Roles.member]), 403],
    ['a system user', () => adminHeaders([Roles.systemUser]), 403],
    ['a Site Manager module grant only', () => adminHeaders([Roles.systemUser, moduleRole('00000000000000000000000000000000000')]), 403],
    ['an S2 of another site', () => adminHeaders([Roles.s2], SITE_B, true), 403],
  ];

  it.each(routes)('%s %s refuses every subject outside S2 and the site Admin group, consuming and writing nothing', async (method, url, body) => {
    for (const [, headers, status] of refused) {
      expect((await call(method, url, await headers(), body)).statusCode).toBe(status);
    }
    expect(consumed).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it.each(routes)('%s %s admits S2 and the site Admin group', async (method, url, body) => {
    for (const headers of [adminHeaders([Roles.systemUser, Roles.s2], SITE_A, true), adminHeaders()]) {
      expect((await call(method, url, await headers, body)).statusCode).toBe(200);
    }
  });
});

describe('screen models', () => {
  it('cchain.list answers the site chains under their bean names, timestamps in the legacy zone', async () => {
    t.db.respond(/FROM "content"\."approval_chain"/i, [chainRow()]);
    const res = await call('GET', CHAINS_URL, await adminHeaders());
    expect(res.json()).toEqual({
      rc: {
        siteid: SITE_A,
        chains: [
          {
            chainID: CHAIN,
            siteID: SITE_A,
            name: 'Chain A',
            description: '',
            created: '2026-06-30T09:05:03.007',
            lastupdate: '2026-06-30T10:00:00.000',
            lastupdateby: 'Admin User',
            lastupdatebyid: USER_ID,
          },
        ],
      },
    });
    expect(t.db.statements.find((statement) => /FROM "content"\."approval_chain"/i.test(statement.sql))?.tenantId).toBe(TENANT_A.tenantId);
  });

  it('cchain.update answers the chain, the groups it can add and its members', async () => {
    t.db.respond(/FROM "content"\."approval_chain"/i, [chainRow()]);
    t.db.respond(/FROM "content"\."approval_membership"/i, [membershipRow()]);
    t.db.respond(/FROM "content"\."group_projection"/i, [groupRow(GROUP_1, 'Admin'), groupRow(GROUP_2, 'Editors')]);
    const { rc } = (await call('GET', CHAIN_URL, await adminHeaders())).json() as { rc: Json };
    expect(rc.chain).toMatchObject({ chainID: CHAIN, name: 'Chain A', siteID: SITE_A, isNew: false, errors: {} });
    expect(rc.memberships).toEqual([{ membershipID: 'M1', groupID: GROUP_1, orderNo: 1, groupName: 'Admin' }]);
    expect(rc.availableGroups).toContainEqual({ userID: GROUP_2, groupName: 'Editors', siteID: SITE_A, isPublic: 0 });
    expect(rc.availableGroups).not.toContainEqual(expect.objectContaining({ userID: GROUP_1 }));
  });

  it('cchain.update of an unknown id answers a new bean of that id', async () => {
    const { rc } = (await call('GET', CHAIN_URL, await adminHeaders())).json() as { rc: Json };
    expect(rc).toMatchObject({ chain: { chainID: CHAIN, isNew: true, errors: {} }, memberships: [], availableGroups: [] });
  });

  it('cchain.pending answers each member with its pending versions, change sets and icon-bearing crumbs, without preview URLs', async () => {
    seedPending(
      [membershipRow(), { ...membershipRow(), membershipid: 'M2', groupid: GROUP_2, orderno: 2 }],
      [
        requestRow(REQUEST_ID, GROUP_1, HIST_ID, 8),
        // tapprovalrequests.groupid = :groupid compares case-insensitively.
        requestRow('R2', GROUP_2.toLowerCase(), 'H-FORM-1', 9),
        requestRow('R3', GROUP_1, 'H-MISSING', 10),
        requestRow('R4', GROUP_1, 'H-FORM-2', 11),
      ],
      [
        versionRow(HIST_ID, CONTENT_ID, 'Component', { moduleid: COMPONENTS, parentid: COMPONENTS, path: `${COMPONENTS},${CONTENT_ID}`, changesetid: CHANGESET }),
        versionRow('H-FORM-1', 'FORM-1', 'Form', { moduleid: FORMS, parentid: FORMS, path: `${FORMS},FORM-1` }),
        versionRow('H-FORM-2', 'FORM-2', 'Form', { moduleid: FORMS, parentid: FORMS, path: null }),
      ],
    );
    t.db.respond(CHANGESETS, (params) => (lastArray(params).includes(CHANGESET) ? [{ tenant_id: TENANT_A.tenantId, changesetid: CHANGESET, name: 'Summer', publishdate: new Date(2026, 6, 15, 9, 0, 0, 0) }] : []));
    t.db.respond(SUBTYPES, [{ tenant_id: TENANT_A.tenantId, subtypeid: 'S1', siteid: SITE_A, type: 'Folder', subtype: 'Forms', iconclass: 'icon-inbox' }]);
    const res = await call('GET', `${CHAIN_URL}/pending`, await adminHeaders());
    expect(res.statusCode, res.body).toBe(200);
    const { rc } = res.json() as { rc: Json };
    expect(rc.chain).toMatchObject({ chainID: CHAIN, name: 'Chain A', isNew: false });
    const component = wireCrumb(CONTENT_ID, 'Component', { title: 'Footer', menutitle: 'Footer', moduleid: COMPONENTS, parentid: COMPONENTS, restricted: 0, icon: 'mi-align-justify' });
    const components = wireCrumb(COMPONENTS, 'Module', { title: 'Components', menutitle: 'Components', moduleid: COMPONENTS, parentid: ROOT_PARENT, icon: 'mi-cog' });
    const forms = wireCrumb(FORMS, 'Folder', { subtype: 'Forms', title: 'Forms', menutitle: 'Forms', parentid: ROOT_PARENT, restricted: 1, icon: 'mi-inbox' });
    expect(rc.members).toEqual([
      expect.objectContaining({
        groupID: GROUP_1,
        groupName: 'Admin',
        requests: [
          expect.objectContaining({
            requestID: REQUEST_ID,
            contentHistID: HIST_ID,
            contentID: CONTENT_ID,
            type: 'Component',
            created: '2026-06-30T08:00:00.000',
            lastUpdate: '',
            lastUpdateBy: 'Admin User',
            changesetID: CHANGESET,
            changesetName: 'Summer',
            changesetPublishDate: '2026-07-15T09:00:00.000',
            crumbArray: [{ ...component, parentarray: [CONTENT_ID, COMPONENTS] }, components],
          }),
          // The parent walk of a version without a stored path falls back to the title.
          expect.objectContaining({
            requestID: 'R4',
            contentID: 'FORM-2',
            changesetID: '',
            changesetName: '',
            changesetPublishDate: '',
            crumbArray: [{ ...wireCrumb('FORM-2', 'Form', { title: 'Survey', menutitle: 'Survey', moduleid: FORMS, parentid: FORMS, icon: 'mi-toggle-on' }), parentarray: ['FORM-2', FORMS] }, forms],
          }),
        ],
      }),
      expect.objectContaining({
        groupID: GROUP_2,
        groupName: 'Editors',
        requests: [
          // A stored path keeps an empty menu title.
          expect.objectContaining({
            requestID: 'R2',
            contentID: 'FORM-1',
            crumbArray: [{ ...wireCrumb('FORM-1', 'Form', { title: 'Contact', moduleid: FORMS, parentid: FORMS, icon: 'mi-toggle-on' }), parentarray: ['FORM-1', FORMS] }, forms],
          }),
        ],
      }),
    ]);
    const rows = (rc.members as Array<{ requests: Json[] }>).flatMap((member) => member.requests);
    expect(rows.filter((row) => Object.keys(row).some((key) => key.toLowerCase() === 'previewurl'))).toEqual([]);
    expect(t.db.statements.filter((statement) => SUBTYPES.test(statement.sql)).map((statement) => statement.params)).toEqual([[TENANT_A.tenantId, SITE_A]]);
  });

  it.each(['Page', 'folder', 'CALENDAR', 'Gallery', 'Link', 'File'])(
    'cchain.pending holding a %s request answers the legacy-shaped 503 naming its exceptions entry, consuming and writing nothing',
    async (type) => {
      seedPending(
        [membershipRow()],
        [requestRow(REQUEST_ID, GROUP_1, HIST_ID, 8), requestRow('R2', GROUP_1, 'H-PREVIEW', 9)],
        [
          versionRow(HIST_ID, CONTENT_ID, 'Component', { moduleid: COMPONENTS, parentid: COMPONENTS, path: `${COMPONENTS},${CONTENT_ID}` }),
          versionRow('H-PREVIEW', 'PREVIEW', type, { path: `${COMPONENTS},PREVIEW` }),
        ],
      );
      const res = await call('GET', `${CHAIN_URL}/pending`, await adminHeaders());
      expect(res.statusCode, res.body).toBe(503);
      expect(routeErrors).toEqual([expect.objectContaining({ reason: CCHAIN_SITE_SETTINGS_REASON, message: expect.stringContaining(`(${CCHAIN_PENDING_PREVIEW_EXCEPTION})`) })]);
      expect([CCHAIN_PENDING_PREVIEW_EXCEPTION, CCHAIN_SITE_SETTINGS_REASON]).toEqual(['EX-CCHAIN-PENDING-PREVIEW', 'cchain-site-settings']);
      expect(consumed).toEqual([]);
      expect(writes()).toEqual([]);
      expect(t.db.statements.some((statement) => SUBTYPES.test(statement.sql))).toBe(false);
    },
  );

  it('cchain.pending reads requests, versions, change sets and crumbs with as many statements for eight requests as for one', async () => {
    const countFor = async (n: number): Promise<number> => {
      t.db.reset();
      const ids = Array.from({ length: n }, (_, i) => `C${i}`);
      seedPending(
        [membershipRow(), { ...membershipRow(), membershipid: 'M2', groupid: GROUP_2, orderno: 2 }],
        ids.map((id, i) => requestRow(`R${id}`, i % 2 === 0 ? GROUP_1 : GROUP_2, `H${id}`, i)),
        ids.map((id) => versionRow(`H${id}`, id, 'Component', { moduleid: COMPONENTS, parentid: COMPONENTS, path: `${COMPONENTS},${id}`, changesetid: `CS-${id}` })),
      );
      t.db.respond(CHANGESETS, (params) => lastArray(params).map((changesetid) => ({ tenant_id: TENANT_A.tenantId, changesetid, name: changesetid, publishdate: null })));
      const res = await call('GET', `${CHAIN_URL}/pending`, await adminHeaders());
      expect(res.statusCode, res.body).toBe(200);
      const members = (res.json() as { rc: { members: Array<{ requests: Json[] }> } }).rc.members;
      expect(members.map((member) => member.requests.length)).toEqual([Math.ceil(n / 2), Math.floor(n / 2)]);
      expect(members.flatMap((member) => member.requests).every((row) => row.changesetName === row.changesetID)).toBe(true);
      return t.db.statements.length;
    };
    expect(await countFor(8)).toBe(await countFor(1));
  });

  it('cchain.pending without a chain id answers the new chain and no members', async () => {
    // The contract's chainid is never empty, so this request, which web sends for cChain.pending without chainID, is not asserted against it.
    const res = await t.app.inject({ method: 'GET', url: `${CHAINS_URL}//pending`, headers: await adminHeaders() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { rc: Json }).rc).toMatchObject({ chain: { chainID: '', isNew: true }, members: [] });
  });
});

describe('cchain.save', () => {
  it('saves the chain and its posted group order, consuming the token for the chain id, then redirects to the list', async () => {
    const res = await call('POST', CHAINS_URL, await adminHeaders(), `chainID=${CHAIN}&siteid=${SITE_A}&name=New&description=D&groupID=${GROUP_1}&groupID=${GROUP_2}&${TOKEN}`);
    expect(res.json()).toEqual({ saved: true, errors: {}, redirect: LIST_REDIRECT });
    expect(consumed).toEqual([expect.objectContaining({ token: 'tok', expires: 'exp', context: CHAIN })]);
    expect(writes().filter((sql) => /^INSERT INTO "content"\."approval_membership"/i.test(sql))).toHaveLength(2);
    expect(writes().filter((sql) => /^INSERT INTO "content"\."approval_chain" /i.test(sql))).toHaveLength(1);
  });

  it('without a groupID field removes every membership, as before() defaults it to an empty list', async () => {
    t.db.respond(/FROM "content"\."approval_membership"/i, [membershipRow()]);
    await call('POST', CHAINS_URL, await adminHeaders(), `chainID=${CHAIN}&name=New&${TOKEN}`);
    expect(writes().some((sql) => /^DELETE FROM "content"\."approval_membership"/i.test(sql))).toBe(true);
  });

  it('with bean errors answers them and no redirect', async () => {
    const res = await call('POST', CHAINS_URL, await adminHeaders(), `name=${'x'.repeat(101)}&${TOKEN}`);
    expect(res.json()).toEqual({
      saved: false,
      errors: { chainID: "The property named 'chainID' is not valid", name: "The property named 'name' is not valid" },
      redirect: null,
    });
    expect(consumed).toEqual([expect.objectContaining({ context: '' })]);
    expect(writes().filter((sql) => /"approval_chain"/i.test(sql))).toEqual([]);
  });

  it('with a refused token writes nothing and redirects to the list', async () => {
    csrfValid = false;
    const res = await call('POST', CHAINS_URL, await adminHeaders(), `chainID=${CHAIN}&name=New&${TOKEN}`);
    expect(res.json()).toEqual({ saved: false, errors: {}, redirect: LIST_REDIRECT });
    expect(writes()).toEqual([]);
  });
});

describe('cchain.delete', () => {
  it('deletes the chain with a valid token for its id and redirects to the list', async () => {
    t.db.respond(/FROM "content"\."approval_chain"/i, [chainRow()]);
    t.db.respond(/^DELETE FROM "content"\."approval_chain"/i, [chainRow()]);
    const res = await call('POST', `${CHAIN_URL}/delete`, await adminHeaders(), `siteid=${SITE_A}&chainid=${CHAIN}&${TOKEN}`);
    expect(res.json()).toEqual({ saved: true, errors: {}, redirect: LIST_REDIRECT });
    expect(consumed).toEqual([expect.objectContaining({ context: CHAIN })]);
    expect(writes()).toContainEqual(expect.stringMatching(/^DELETE FROM "content"\."approval_chain"/i));
  });

  it.each<[string, string, boolean, number]>([
    ['a refused token', TOKEN, false, 1],
    ['no token', '', true, 0],
  ])('with %s writes nothing and still redirects to the list', async (_label, body, valid, consumes) => {
    csrfValid = valid;
    const res = await call('POST', `${CHAIN_URL}/delete`, await adminHeaders(), body);
    expect(res.json()).toEqual({ saved: false, errors: {}, redirect: LIST_REDIRECT });
    expect(consumed).toHaveLength(consumes);
    expect(t.db.statements.filter((statement) => /approval/i.test(statement.sql))).toEqual([]);
  });
});
