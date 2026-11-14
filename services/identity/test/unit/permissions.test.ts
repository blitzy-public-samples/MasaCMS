/** In-memory suite of the `cperm` permission operations and routes: module grant replacement with full-state permission events, site and pool group lists, node and module reads, the s2/site-admin gate, the posted moduleid as CSRF context and redirect key, and the withheld node-grant save. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, adminUrl, generateCsrfToken, type AdminParam } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, assertEventMatches, fixedClock, type TenantFixture } from '@opt2/platform/testing';
import {
  groupListForSite,
  permissionsForContent,
  permittedGroups,
  reversePermLookUp,
  updateModulePermissions,
  type PermissionDeps,
} from '../../src/domain/permissions.js';
import { PERMISSION_CHANGED_TOPIC, createIdentityEvents, type PermissionChangedPayload } from '../../src/events/publish.js';
import { IDENTITY_UNITS, PERMISSION } from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import {
  createMemoryIdentityRepo,
  createRecordingDb,
  type MemoryIdentityRepo,
  type RecordedWrite,
  type RecordingDb,
  type RecordingDbSeed,
} from '../helpers/memory-repo.js';
import { ADMIN_S2, EDITOR, SITE_ADMIN_A, actorSeed, groupRow, loginSnapshotFixture, permissionRow, sessionRow } from '../helpers/rows.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const SITE = TENANT_A.siteId;
const PERMISSION_SCHEMA = JSON.parse(
  readFileSync(new URL(`../../contracts/events/${PERMISSION_CHANGED_TOPIC}.json`, import.meta.url), 'utf8'),
) as object;

const NODE = 'C0000000-0000-0000-0000000000000001';
const USERS_MODULE = '00000000000000000000000000000000008';
const FORMS_MODULE = '00000000000000000000000000000000007';
const CATEGORIES_MODULE = '00000000000000000000000000000000010';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const HOME_CONTENT = '00000000000000000000000000000000001';
const PLUGIN_MODULE = 'B0000000-0000-0000-0000000000000001';
const SECRET = 'K0000000-0000-0000-0000000000000001';
const OTHER_SECRET = 'K0000000-0000-0000-0000000000000002';

// Ids fixed so the case-folded key order the domain announces groups in is known.
const AUTHORS = groupRow({ userid: 'A1000000-0000-0000-0000000000000001', groupname: 'authors' });
const STAFF = groupRow({ userid: 'A1000000-0000-0000-0000000000000002', groupname: 'Staff' });
const NAMELESS = groupRow({ userid: 'A1000000-0000-0000-0000000000000003', groupname: null });
const LOCAL_MEMBERS = groupRow({ userid: 'A1000000-0000-0000-0000000000000004', groupname: 'Local Members', ispublic: 1 });
const MEMBERS = groupRow({
  userid: 'B1000000-0000-0000-0000000000000001',
  groupname: 'Members',
  ispublic: 1,
  siteid: TENANT_UMBRELLA.siteId,
  tenant_id: TENANT_UMBRELLA.tenantId,
});
const POOL_ADMIN = groupRow({
  userid: 'B1000000-0000-0000-0000000000000002',
  groupname: 'Admin',
  ispublic: 1,
  siteid: TENANT_UMBRELLA.siteId,
  tenant_id: TENANT_UMBRELLA.tenantId,
});
const B_STAFF = groupRow({ userid: 'D1000000-0000-0000-0000000000000001', groupname: 'B Staff', siteid: TENANT_B.siteId, tenant_id: TENANT_B.tenantId });

/** A `tenant_registry` row of `site` with its private and public user pools. */
function registryRow(site: TenantFixture, privatePool: TenantFixture, publicPool: TenantFixture): Record<string, unknown> {
  return {
    site_id: site.siteId,
    tenant_id: site.tenantId,
    public_user_pool_id: publicPool.siteId,
    private_user_pool_id: privatePool.siteId,
    category_pool_id: null,
    file_pool_id: null,
    display_pool_id: null,
    content_pool_ids: [site.siteId],
    public_user_pool_tenant: publicPool.tenantId,
    private_user_pool_tenant: privatePool.tenantId,
    category_pool_tenant: null,
    file_pool_tenant: null,
    display_pool_tenant: null,
    content_pool_tenants: [site.tenantId],
    domains: [],
    aggregate_version: '1',
    updated_at: CLOCK.now(),
  };
}

// tenant-a pools its public users in umbrella, as the platform fixtures do.
const REGISTRY = [
  registryRow(TENANT_A, TENANT_A, TENANT_UMBRELLA),
  registryRow(TENANT_B, TENANT_B, TENANT_B),
  registryRow(TENANT_UMBRELLA, TENANT_UMBRELLA, TENANT_UMBRELLA),
];
const REGISTRY_SQL = /FROM identity\.tenant_registry/;

/** The registry rows a registry read selects: by site id ignoring case, by tenant, by user pool tenant, or all. */
function registryAnswer(sql: string, values: readonly unknown[]): Record<string, unknown>[] {
  if (/lower\(site_id\) = lower\(\$1\)/.test(sql)) return REGISTRY.filter((row) => String(row.site_id) === String(values[0]).toLowerCase());
  if (/WHERE tenant_id = \$1/.test(sql)) return REGISTRY.filter((row) => row.tenant_id === values[0]);
  if (/WHERE public_user_pool_tenant = \$1 OR private_user_pool_tenant = \$1/.test(sql)) {
    return REGISTRY.filter((row) => row.public_user_pool_tenant === values[0] || row.private_user_pool_tenant === values[0]);
  }
  return REGISTRY;
}

/** Tenants of the tenant transactions `db` opened, in order. */
function tenantTransactions(db: RecordingDb): string[] {
  return db
    .statements()
    .filter((statement) => /set_config\('app\.tenant_id'/.test(statement.sql) && statement.values[0] !== '')
    .map((statement) => String(statement.values[0]));
}

/** Units whose gates `db` read or locked, each once, sorted. */
function gateUnits(db: RecordingDb): string[] {
  const units = db
    .statements()
    .filter((statement) => /"unit_gate" WHERE unit = ANY/.test(statement.sql))
    .flatMap((statement) => statement.values[0] as string[]);
  return [...new Set(units)].sort();
}

/** The outbox rows among `writes`, each envelope checked against the platform envelope and the permission topic contract. */
function permissionEvents(writes: readonly RecordedWrite[]) {
  return writes
    .filter((write) => write.table === 'identity.outbox')
    .map((write) => {
      expect(write.values[2]).toBe(PERMISSION_CHANGED_TOPIC);
      const envelope = assertEventMatches(undefined, PERMISSION_SCHEMA, JSON.parse(String(write.values[5])));
      const payload = envelope.payload as PermissionChangedPayload;
      return { rowTenant: write.tenantId, tenantId: envelope.tenantId, groupId: envelope.aggregateId, version: envelope.aggregateVersion, payload };
    });
}

/** The payload rows of one group in tenant-a. */
function stateRows(...rows: Array<[contentId: string, type: string]>): PermissionChangedPayload['rows'] {
  return rows.map(([contentId, type]) => ({ contentId, siteId: SITE, type }));
}

/** A tenant-a permission event, as {@link permissionEvents} reads it, carrying the group's rows at `version`. */
function stateEvent(groupId: string, version: number, rows: PermissionChangedPayload['rows']) {
  return { rowTenant: TENANT_A.tenantId, tenantId: TENANT_A.tenantId, groupId, version, payload: { groupId, siteId: SITE, rows } };
}

let testApp: TestApp;

// buildApp registers identity's outbox runtime, which the domain suite's event writes run on.
beforeAll(async () => {
  testApp = await buildTestApp({ clock: CLOCK });
});

afterAll(async () => {
  await testApp?.app.close();
});

describe('permission operations over the memory repository', () => {
  const actors = actorSeed(SITE_ADMIN_A, EDITOR);
  let db: RecordingDb;
  let repo: MemoryIdentityRepo;
  let deps: PermissionDeps;

  function depsOver(gates?: RecordingDbSeed['gates']): void {
    db = createRecordingDb({ gates, responses: [[REGISTRY_SQL, registryAnswer]] });
    repo = createMemoryIdentityRepo(
      {
        ...actors,
        groups: [...(actors.groups ?? []), AUTHORS, STAFF, NAMELESS, LOCAL_MEMBERS, MEMBERS, POOL_ADMIN, B_STAFF],
        permissions: [
          permissionRow({ contentid: NODE, groupid: AUTHORS.userid, type: 'Read' }),
          permissionRow({ contentid: NODE, groupid: AUTHORS.userid, type: 'Editor' }),
          permissionRow({ contentid: NODE, groupid: MEMBERS.userid, type: 'Deny' }),
          permissionRow({ contentid: USERS_MODULE, groupid: AUTHORS.userid, type: 'module' }),
          permissionRow({ contentid: USERS_MODULE, groupid: STAFF.userid, type: 'module' }),
          permissionRow({ contentid: USERS_MODULE, groupid: B_STAFF.userid, type: 'module', siteid: TENANT_B.siteId, tenant_id: TENANT_B.tenantId }),
        ],
      },
      { clock: CLOCK },
    );
    deps = { db, repo, events: createIdentityEvents(repo) };
  }

  beforeEach(() => {
    depsOver();
  });

  it("lists the site's private-pool groups without Admin or a nameless group, then its public pool's groups, each by name as legacy orders them", async () => {
    const lists = await groupListForSite(deps, SITE);

    expect(lists.privateGroups.map((group) => group.groupname)).toEqual(['authors', 'Editor', 'Staff']);
    expect(lists.publicGroups.map((group) => [group.groupname, group.siteid])).toEqual([
      ['Admin', TENANT_UMBRELLA.siteId],
      ['Members', TENANT_UMBRELLA.siteId],
    ]);
    expect(tenantTransactions(db)).toEqual([TENANT_A.tenantId, TENANT_UMBRELLA.tenantId]);
    expect(await groupListForSite(deps, 'TENANT-A')).toEqual(lists);
  });

  it('reads only module rows as permitted groups, and every row of a content node', async () => {
    const node = { siteId: SITE, contentId: NODE };

    expect((await permittedGroups(deps, { siteId: SITE, contentId: USERS_MODULE })).map((row) => row.groupid)).toEqual([AUTHORS.userid, STAFF.userid]);
    expect(await permittedGroups(deps, node)).toEqual([]);
    expect((await permissionsForContent(deps, node)).map((row) => [row.groupid, row.type])).toEqual([
      [AUTHORS.userid, 'Editor'],
      [AUTHORS.userid, 'Read'],
      [MEMBERS.userid, 'Deny'],
    ]);
  });

  it("replaces a module's grants in one tenant-a transaction and writes each affected group's full permission rows as a contract-valid state event", async () => {
    const result = await updateModulePermissions(deps, { siteId: SITE, moduleId: USERS_MODULE, groupIds: `${MEMBERS.userid},,${AUTHORS.userid}` });

    expect(result.rows.map((row) => [row.groupid, row.type])).toEqual([
      [MEMBERS.userid, 'module'],
      [AUTHORS.userid, 'module'],
    ]);
    expect(result.changedGroupIds).toEqual([AUTHORS.userid, STAFF.userid, MEMBERS.userid]);
    expect(permissionEvents(db.writes())).toEqual([
      stateEvent(AUTHORS.userid, 1, stateRows([USERS_MODULE, 'module'], [NODE, 'Editor'], [NODE, 'Read'])),
      stateEvent(STAFF.userid, 1, []),
      stateEvent(MEMBERS.userid, 1, stateRows([USERS_MODULE, 'module'], [NODE, 'Deny'])),
    ]);
    expect(tenantTransactions(db)).toEqual([TENANT_A.tenantId]);
    expect(repo.rows(PERMISSION.table, TENANT_B.tenantId).map((row) => row.groupid)).toEqual([B_STAFF.userid]);
  });

  it('announces the state left after each replacement rather than the change, at the next version of each group', async () => {
    await updateModulePermissions(deps, { siteId: SITE, moduleId: USERS_MODULE, groupIds: [MEMBERS.userid, AUTHORS.userid] });
    const written = db.writes().length;

    const cleared = await updateModulePermissions(deps, { siteId: SITE, moduleId: USERS_MODULE, groupIds: '' });

    expect(cleared).toEqual({ rows: [], changedGroupIds: [AUTHORS.userid, MEMBERS.userid] });
    expect(permissionEvents(db.writes().slice(written))).toEqual([
      stateEvent(AUTHORS.userid, 2, stateRows([NODE, 'Editor'], [NODE, 'Read'])),
      stateEvent(MEMBERS.userid, 2, stateRows([NODE, 'Deny'])),
    ]);
    expect(await permittedGroups(deps, { siteId: SITE, contentId: USERS_MODULE })).toEqual([]);
  });

  it('needs authority over identity.permission alone and writes only permission rows and their event sequence, never an approval-chain row', async () => {
    depsOver(Object.fromEntries(IDENTITY_UNITS.filter((unit) => unit !== PERMISSION.unit).map((unit) => [unit, { state: 'legacy' as const }])));

    await updateModulePermissions(deps, { siteId: SITE, moduleId: USERS_MODULE, groupIds: [MEMBERS.userid] });

    const memoryWrites = repo.writes();
    expect(new Set(memoryWrites.map((write) => write.table))).toEqual(new Set([PERMISSION.table, 'aggregate_version']));
    expect(memoryWrites.filter((write) => write.table === PERMISSION.table).map((write) => write.op)).toEqual(['delete', 'delete', 'insert']);
    expect(memoryWrites.every((write) => write.tenantId === TENANT_A.tenantId)).toBe(true);
    expect(new Set(db.writes().map((write) => `${write.verb} ${write.table}`))).toEqual(new Set(['INSERT identity.outbox']));
    expect(gateUnits(db)).toEqual([PERMISSION.unit]);
  });

  it('refuses module grants while identity.permission is legacy-authoritative, writing no grant and no event', async () => {
    depsOver({ [PERMISSION.unit]: { state: 'legacy' } });

    await expect(updateModulePermissions(deps, { siteId: SITE, moduleId: USERS_MODULE, groupIds: [MEMBERS.userid] })).rejects.toMatchObject({
      name: 'UnitNotAuthoritativeError',
      units: [PERMISSION.unit],
    });
    expect([repo.writes(), db.writes()]).toEqual([[], []]);
  });

  it.each([
    ["a site admin, through the private pool's Admin group", SITE_ADMIN_A, false, true],
    ['an editor whose group holds the Users module grant', EDITOR, true, true],
    ['an editor whose group holds no Users module grant', EDITOR, false, false],
  ])('answers the reverse Users-module lookup for %s signed in to tenant-a', async (_label, actor, usersGrant, granted) => {
    const sessionId = `S-reverse-${actor.key}`;
    const snapshot = loginSnapshotFixture({ actor });
    const lookupRepo = createMemoryIdentityRepo(
      {
        ...actorSeed(actor),
        permissions: usersGrant ? actor.groups.map((group) => permissionRow({ contentid: USERS_MODULE, groupid: group.userid, type: 'module' })) : [],
        sessions: [sessionRow({ session_id: sessionId, user_id: actor.account.userid, login_snapshot: JSON.stringify(snapshot) })],
      },
      { clock: CLOCK },
    );

    expect(await reversePermLookUp({ db, repo: lookupRepo }, { sid: sessionId, tid: TENANT_A.tenantId, site: SITE })).toBe(granted);
  });

  it('answers an unregistered site with no groups or rows, and refuses to store its module grants', async () => {
    const ghost = { siteId: 'nowhere', contentId: USERS_MODULE };

    expect(await groupListForSite(deps, ghost.siteId)).toEqual({ privateGroups: [], publicGroups: [] });
    expect([await permittedGroups(deps, ghost), await permissionsForContent(deps, ghost)]).toEqual([[], []]);
    await expect(updateModulePermissions(deps, { siteId: ghost.siteId, moduleId: USERS_MODULE, groupIds: [AUTHORS.userid] })).rejects.toThrow(
      'Site nowhere is not registered, so its module grants have no tenant',
    );
    expect([repo.writes(), db.writes()]).toEqual([[], []]);
  });
});

describe('cperm routes of the composed identity app', () => {
  type Method = 'GET' | 'PUT' | 'POST';

  const LIST_GROUPS_SQL = /^SELECT \* FROM "identity"\."group_account" WHERE tenant_id = \$1 AND type = 1 AND ispublic = \$2 AND siteid = \$3/;
  const PERMISSIONS_SQL = /^SELECT \* FROM "identity"\."permission" WHERE tenant_id = \$1 AND contentid = \$2 AND siteid = \$3/;
  const SESSION_SQL = /FROM "identity"\."session" WHERE/;
  // What PostgreSQL would select for each pool listing: the private pool without Admin, the public pool whole.
  const POOL_LISTS = new Map([
    [`${TENANT_A.tenantId}/0`, [AUTHORS, STAFF]],
    [`${TENANT_UMBRELLA.tenantId}/1`, [POOL_ADMIN, MEMBERS]],
  ]);
  const STORED_PERMISSIONS = [
    permissionRow({ contentid: NODE, groupid: AUTHORS.userid, type: 'Read' }),
    permissionRow({ contentid: NODE, groupid: AUTHORS.userid, type: 'Editor' }),
    permissionRow({ contentid: NODE, groupid: MEMBERS.userid, type: 'Deny' }),
    permissionRow({ contentid: FORMS_MODULE, groupid: AUTHORS.userid.toLowerCase(), type: 'module' }),
    permissionRow({ contentid: FORMS_MODULE, groupid: MEMBERS.userid, type: 'module' }),
  ];
  let mark = 0;

  const contentUrl = (contentId: string): string => `/v1/permissions/content/${contentId}?siteid=${SITE}`;
  const moduleUrl = (moduleId: string): string => `/v1/permissions/modules/${moduleId}?siteid=${SITE}`;

  /** Gateway-relayed headers of the `ROLE_SET` subject, its token naming user `sub` when given. */
  function callerHeaders(subject: string, sub?: string): Promise<Record<string, string>> {
    return headersFor(subject, sub === undefined ? {} : { sub });
  }

  /** Injects a request, `form` as a form post. */
  function send(method: Method, url: string, headers: Record<string, string>, form?: URLSearchParams) {
    const formHeaders = form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' };
    return testApp.app.inject({ method, url, headers: { ...headers, ...formHeaders }, payload: form?.toString() });
  }

  /** Writes committed since the current test began. */
  function newWrites(): RecordedWrite[] {
    return testApp.db.writes().slice(mark);
  }

  beforeAll(async () => {
    const { db } = testApp;
    db.respond(REGISTRY_SQL, registryAnswer);
    db.respond(LIST_GROUPS_SQL, (_sql, values) => POOL_LISTS.get(`${String(values[0])}/${String(values[1])}`) ?? []);
    db.respond(PERMISSIONS_SQL, (_sql, values) =>
      STORED_PERMISSIONS.filter((row) => row.tenant_id === values[0] && row.contentid === values[1] && (values[3] === null || row.type === values[3])),
    );
    // Every token's session is an active tenant-a session under SECRET.
    db.respond(SESSION_SQL, (_sql, values) =>
      values[0] === TENANT_A.tenantId ? [sessionRow({ session_id: String(values[1]), csrf_secret: SECRET, user_id: SITE_ADMIN_A.account.userid })] : [],
    );
    await testApp.app.ready();
  });

  beforeEach(() => {
    mark = testApp.db.writes().length;
    testApp.client.clear();
  });

  const GATED: ReadonlyArray<readonly [screen: string, method: Method, url: string]> = [
    ['cperm.main', 'GET', contentUrl(NODE)],
    ['cperm.module', 'GET', moduleUrl(FORMS_MODULE)],
    ['cperm.updatemodule', 'PUT', moduleUrl(FORMS_MODULE)],
  ];
  const CALLERS: ReadonlyArray<readonly [subject: string, sub: string | undefined, status: number]> = [
    ['s2', ADMIN_S2.account.userid, 200],
    ['site-admin', SITE_ADMIN_A.account.userid, 200],
    ['editor', EDITOR.account.userid, 403],
    ['other-tenant', undefined, 403],
  ];

  it.each(GATED.flatMap(([screen, method, url]) => CALLERS.map(([subject, sub, status]) => ({ screen, method, url, subject, sub, status }))))(
    '$screen answers $subject addressing tenant-a with $status',
    async ({ method, url, subject, sub, status }) => {
      const res = await send(method, url, await callerHeaders(subject, sub), method === 'PUT' ? new URLSearchParams({ moduleid: FORMS_MODULE }) : undefined);

      expect(res.statusCode).toBe(status);
      if (status === 403) expect(res.json()).toMatchObject({ error: { message: 'Insufficient Account Permissions' } });
      expect(newWrites()).toEqual([]);
    },
  );

  it("answers cperm.main with the private pool's groups read without Admin, then the public pool's, each with its node verdict in legacy precedence", async () => {
    const before = testApp.db.statements().length;

    const res = await send('GET', contentUrl(NODE), await callerHeaders('s2', ADMIN_S2.account.userid));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      contentId: NODE,
      siteId: SITE,
      groups: [
        { groupId: AUTHORS.userid, groupName: 'authors', perm: 'editor' },
        { groupId: STAFF.userid, groupName: 'Staff', perm: 'none' },
      ],
      publicGroups: [
        { groupId: POOL_ADMIN.userid, groupName: 'Admin', perm: 'none' },
        { groupId: MEMBERS.userid, groupName: 'Members', perm: 'deny' },
      ],
    });
    const listings = testApp.db.statements().slice(before).filter((statement) => LIST_GROUPS_SQL.test(statement.sql));
    expect(listings.map((statement) => statement.values)).toEqual([
      [TENANT_A.tenantId, 0, SITE, true],
      [TENANT_UMBRELLA.tenantId, 1, TENANT_UMBRELLA.siteId, false],
    ]);
  });

  it('answers cperm.module with each group granted when the module holds its module row, group ids compared ignoring case', async () => {
    const res = await send('GET', moduleUrl(FORMS_MODULE), await callerHeaders('site-admin', SITE_ADMIN_A.account.userid));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      moduleId: FORMS_MODULE,
      siteId: SITE,
      privateGroups: [
        { groupId: AUTHORS.userid, groupName: 'authors', granted: true },
        { groupId: STAFF.userid, groupName: 'Staff', granted: false },
      ],
      publicGroups: [
        { groupId: POOL_ADMIN.userid, groupName: 'Admin', granted: false },
        { groupId: MEMBERS.userid, groupName: 'Members', granted: true },
      ],
    });
  });

  it('saves the posted grants in tenant-a when the token is valid for the posted moduleid, relays the used token and redirects as legacy does', async () => {
    const issued = generateCsrfToken({ context: CATEGORIES_MODULE, secret: SECRET, now: CLOCK.now() });
    const form = new URLSearchParams([
      ['groupid', AUTHORS.userid],
      ['groupid', MEMBERS.userid],
      ['moduleid', CATEGORIES_MODULE],
      [CSRF_FIELD_TOKEN, issued.token],
      [CSRF_FIELD_EXPIRES, issued.expires],
    ]);

    const res = await send('PUT', moduleUrl(CATEGORIES_MODULE), await callerHeaders('site-admin', SITE_ADMIN_A.account.userid), form);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: true, redirect: { action: 'cCategory.list', params: { siteid: SITE } } });
    expect(res.headers['x-opt2-write-position']).toMatch(/^identity=\d+$/);
    const writes = newWrites();
    expect(writes.filter((write) => write.table === 'identity.permission').map((write) => [write.verb, ...write.values])).toEqual([
      ['INSERT', TENANT_A.tenantId, CATEGORIES_MODULE, AUTHORS.userid, SITE, 'module'],
      ['INSERT', TENANT_A.tenantId, CATEGORIES_MODULE, MEMBERS.userid, SITE, 'module'],
    ]);
    expect(permissionEvents(writes).map((event) => [event.groupId, event.tenantId])).toEqual([
      [AUTHORS.userid, TENANT_A.tenantId],
      [MEMBERS.userid, TENANT_A.tenantId],
    ]);
    expect(writes.every((write) => write.table.startsWith('identity.') && write.tenantId === TENANT_A.tenantId)).toBe(true);
    expect(testApp.client.markedUsed.map((marked) => marked.tokens.map((used) => used.token))).toEqual([[issued.token]]);
  });

  it.each([
    ['issued for the path id rather than the posted moduleid', USERS_MODULE, () => generateCsrfToken({ context: USERS_MODULE, secret: SECRET, now: CLOCK.now() })],
    ['issued under another session secret', CATEGORIES_MODULE, () => generateCsrfToken({ context: CATEGORIES_MODULE, secret: OTHER_SECRET, now: CLOCK.now() })],
  ])('writes nothing for a token %s, yet redirects by the posted moduleid', async (_label, pathModule, token) => {
    const { token: csrfToken, expires } = token();
    const form = new URLSearchParams({ groupid: AUTHORS.userid, moduleid: CATEGORIES_MODULE, [CSRF_FIELD_TOKEN]: csrfToken, [CSRF_FIELD_EXPIRES]: expires });

    const res = await send('PUT', moduleUrl(pathModule), await callerHeaders('s2', ADMIN_S2.account.userid), form);

    expect(res.json()).toEqual({ written: false, redirect: { action: 'cCategory.list', params: { siteid: SITE } } });
    expect(newWrites()).toEqual([]);
    expect(testApp.client.markedUsed).toEqual([]);
  });

  it.each<[moduleId: string, circuit: string, action: string, append: AdminParam[]]>([
    ['00000000000000000000000000000000004', 'cUsers', 'list', []],
    ['00000000000000000000000000000000005', 'cEmail', 'list', []],
    [FORMS_MODULE, 'cForm', 'list', []],
    [USERS_MODULE, 'cUsers', 'list', []],
    ['00000000000000000000000000000000009', 'cMailingList', 'list', []],
    [SITE_MANAGER_MODULE, 'cArch', 'list', [['topid', HOME_CONTENT], ['moduleid', SITE_MANAGER_MODULE]]],
    [CATEGORIES_MODULE, 'cCategory', 'list', []],
    ['00000000000000000000000000000000011', 'cFeed', 'list', []],
    ['00000000000000000000000000000000014', 'cChangesets', 'list', []],
    ['00000000000000000000000000000000015', 'cComments', 'default', []],
    ['00000000000000000000000000000000016', 'cArch', 'list', [['activeTab', 2]]],
    [PLUGIN_MODULE, 'cPlugins', 'list', []],
  ])('redirects updatemodule of moduleid %s to %s.%s with siteid then the extra parameters appended', async (moduleid, circuit, action, append) => {
    const res = await send('PUT', moduleUrl(moduleid), await callerHeaders('s2', ADMIN_S2.account.userid), new URLSearchParams({ moduleid, groupid: AUTHORS.userid }));

    expect(res.statusCode).toBe(200);
    const { written, redirect } = res.json<{ written: boolean; redirect: { action: string; params: Record<string, string> } }>();
    const [redirectCircuit = '', redirectAction = ''] = redirect.action.split('.');
    expect(written).toBe(false);
    expect(adminUrl({ circuit: redirectCircuit, action: redirectAction, params: Object.entries(redirect.params) })).toBe(
      adminUrl({ circuit, action, params: [['siteid', SITE], ...append] }),
    );
  });

  // The node-grant save also writes the approval-chain assignment strategies-content owns, so cperm.update stays on legacy.
  it.each(['PUT', 'POST'] as const)('serves no node-grant save, answering %s on a content node with 404 and writing nothing', async (method) => {
    const form = new URLSearchParams({ [`p${AUTHORS.userid.replaceAll('-', '')}`]: 'Editor', contentid: NODE });

    const res = await send(method, contentUrl(NODE), await callerHeaders('s2', ADMIN_S2.account.userid), form);

    expect(res.statusCode).toBe(404);
    expect(newWrites()).toEqual([]);
  });

  it('answers the reverse lookup of the token site false for a session that holds no login', async () => {
    const res = await send('GET', '/v1/permissions/reverse-lookup', await callerHeaders('editor', EDITOR.account.userid));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ granted: false });
  });
});

