/** permission.cfc node, module and restriction verdicts and JSON API content AllowAction over projections answered by a recording pool. */
import { describe, expect, it } from 'vitest';
import { moduleRole } from '@opt2/platform/auth';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, mintUserToken, testVerifier, type TenantFixture } from '@opt2/platform/testing';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import {
  allowContentAction,
  getModulePerm,
  getNodePerm,
  getNodePermPublic,
  getPerm,
  getPermPublic,
  loadMemberships,
  setRestriction,
  type ContentActionInput,
  type CrumbNode,
  type NodeVerdict,
  type PermissionDeps,
  type Restriction,
  type UserMemberships,
} from '../../src/domain/permissions.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, createRecordingDb, type RecordedStatement, type RecordingDb } from '../helpers/app.js';
import { IDS, contentSeed, groupProjectionRow, membershipProjectionRow, newId, permissionProjectionRow, seedRecordingDb } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, subjectSessionId, type TokenSubject } from '../helpers/tokens.js';

type Row = Record<string, unknown>;
type GroupRow = ReturnType<typeof groupProjectionRow>;
type GrantRow = ReturnType<typeof permissionProjectionRow>;
type MemberRow = ReturnType<typeof membershipProjectionRow>;

const SITE = TENANT_A.siteId;
const EDITORS = 'D1000000-0000-0000-0000000000000001';
const MEMBERS = 'D1000000-0000-0000-0000000000000002';
const ADMIN = 'D1000000-0000-0000-0000000000000003';
const OTHER = 'D1000000-0000-0000-0000000000000004';
const NODE = 'D2000000-0000-0000-0000000000000001';
const OTHER_NODE = 'D2000000-0000-0000-0000000000000002';
const LEAF = 'D2000000-0000-0000-0000000000000003';
const PARENT = 'D2000000-0000-0000-0000000000000004';
const ROOT = 'D2000000-0000-0000-0000000000000005';
const MODULE_010 = '00000000000000000000000000000000010';
const MODULE_011 = '00000000000000000000000000000000011';
const VARIATION_MODULE = '00000000000000000000000000000000099';
const PLUGIN_MODULE = 'D3000000-0000-0000-0000000000000001';
const EDITORS_NAME = 'Editors;tenant-a;0';

const GROUPS = /FROM "content"\."group_projection"/;
const MEMBERSHIPS = /FROM "content"\."membership_projection"/;
const GRANTS = /FROM "content"\."permission_projection"/;
const CRUMBS = /LEFT JOIN "content"\."approval_assignment" tapprovalassignments/;
const PROJECTIONS = /FROM "content"\."\w+_projection"/;

const privateGroup = (groupId: string, name: string): GroupRow => groupProjectionRow({ group_id: groupId, group_name: name });
const publicGroup = (groupId: string, name: string): GroupRow =>
  groupProjectionRow({ tenant_id: TENANT_UMBRELLA.tenantId, group_id: groupId, site_id: TENANT_UMBRELLA.siteId, group_name: name, is_public: 1 });
const member = (userId: string, groupId: string, tenant: TenantFixture = TENANT_A): MemberRow =>
  membershipProjectionRow({ tenant_id: tenant.tenantId, user_id: userId, site_id: tenant.siteId, group_id: groupId });
const grant = (groupId: string, contentId: string, type: string, overrides: Partial<GrantRow> = {}): GrantRow =>
  permissionProjectionRow({ group_id: groupId, content_id: contentId, type, ...overrides });
const crumb = (contentid: string, overrides: Partial<CrumbNode> = {}): CrumbNode => ({ contentid, siteid: SITE, restricted: 0, restrictgroups: null, ...overrides });
const held = (names: readonly string[], groupIds: readonly string[] = []): UserMemberships => ({ names, groupIds });

/** SQL Server's case- and trailing-space-insensitive id and site comparison key. */
const ci = (value: unknown): string => String(value ?? '').replace(/ +$/u, '').toLowerCase();
const inTenant = (row: Row, tenantId: string | null): boolean => tenantId !== null && ci(row.tenant_id) === ci(tenantId);
const among = (value: unknown, list: unknown): boolean => Array.isArray(list) && list.some((item) => ci(item) === ci(value));

/** The seeded rows of one content table across every fixture tenant. */
function seededRows(table: string): Row[] {
  return contentSeed().flatMap((seed) => seed.rows.filter((entry) => entry.table.table === table).map((entry) => ({ ...entry.row })));
}

interface World {
  db: RecordingDb;
  deps: PermissionDeps;
}

/** A recording pool over the content seed plus `extra` projections, answering projection and crumb reads by their WHERE terms. */
function world(extra: { groups?: GroupRow[]; grants?: GrantRow[]; memberships?: MemberRow[] } = {}): World {
  const db = createRecordingDb();
  seedRecordingDb(db);
  const groups: Row[] = [...seededRows('group_projection'), ...(extra.groups ?? [])];
  const grants: Row[] = [...seededRows('permission_projection'), ...(extra.grants ?? [])];
  const memberships: Row[] = [...seededRows('membership_projection'), ...(extra.memberships ?? [])];
  const content = seededRows('content').filter((row) => row.active === 1);
  db.respond(GROUPS, (params, _sql, { tenantId }) => groups.filter((row) => inTenant(row, tenantId) && among(row.group_id, params[1])));
  db.respond(MEMBERSHIPS, (params, _sql, { tenantId }) =>
    memberships.filter((row) => inTenant(row, tenantId) && ci(row.user_id) === ci(params[1])).map((row) => ({ group_id: row.group_id })),
  );
  db.respond(GRANTS, (params, _sql, { tenantId }) =>
    grants.filter(
      (row) =>
        inTenant(row, tenantId) &&
        ci(row.site_id) === ci(params[1]) &&
        among(row.content_id, params[2]) &&
        (params[3] === undefined || among(row.group_id, params[3])),
    ),
  );
  db.respond(CRUMBS, (params, _sql, { tenantId }) =>
    content
      .filter((row) => inTenant(row, tenantId) && among(row.contentid, params[0]) && row.siteid === params[1])
      .slice(0, 1)
      .map((row) => ({ ...row, fileext: null, chainid: null, exemptid: null })),
  );
  return { db, deps: { db, repository: createContentRepository({ clock: TEST_CLOCK }) } };
}

const verifier = testVerifier().userVerifier;
const ANONYMOUS: Actor = actorFromClaims(undefined, 'Name');

/** The actor of `subject`'s minted and verified user token, with `roles` appended; SUBJECT_CLAIMS alone lacks `sub`, `sid` and the registered claims. */
async function actorOf(subject: TokenSubject, roles: readonly string[] = []): Promise<Actor> {
  const claims = SUBJECT_CLAIMS[subject];
  const token = await mintUserToken({
    sub: SUBJECT_USER_IDS[subject],
    sid: subjectSessionId(subject),
    site: claims.site,
    tid: claims.tid,
    roles: [...claims.roles, ...roles],
    s2: claims.s2,
  });
  return actorFromClaims(await verifier.verify(token), 'Name');
}

/** getPerm and getPermPublic of one node. */
async function perms(deps: PermissionDeps, actor: Actor, contentId: string, memberships?: UserMemberships): Promise<[NodeVerdict, NodeVerdict]> {
  return [await getPerm(deps, actor, contentId, SITE, memberships), await getPermPublic(deps, actor, contentId, SITE, memberships)];
}

/** getNodePerm and getNodePermPublic of one crumb list. */
async function nodePerms(deps: PermissionDeps, actor: Actor, crumbs: readonly CrumbNode[], memberships?: UserMemberships): Promise<[string, string]> {
  return [await getNodePerm(deps, actor, crumbs, memberships), await getNodePermPublic(deps, actor, crumbs, memberships)];
}

const reads = (db: RecordingDb, pattern: RegExp): RecordedStatement[] => db.statements.filter((statement) => pattern.test(statement.sql));

describe('getPerm and getPermPublic [permission.cfc:158-264]', () => {
  it('give an s2 actor editor on a node without grants, reading no projection', async () => {
    const { db, deps } = world();
    expect(await perms(deps, await actorOf('s2'), NODE)).toEqual(['editor', 'editor']);
    expect(reads(db, PROJECTIONS)).toEqual([]);
  });

  it.each([
    { label: 'the private-pool Admin group', group: privateGroup(ADMIN, 'Admin'), tenant: TENANT_A, expected: 'editor' },
    { label: 'a public-pool Admin group', group: publicGroup(ADMIN, 'Admin'), tenant: TENANT_UMBRELLA, expected: 'none' },
  ])('give a projected member of $label $expected on a node without grants [permission.cfc:228]', async ({ group, tenant, expected }) => {
    const actor = await actorOf('system-user');
    const { deps } = world({ groups: [group], memberships: [member(actor.userId, ADMIN, tenant)] });
    expect(await perms(deps, actor, NODE)).toEqual([expected, expected]);
  });

  it.each([
    { names: ['Admin;tenant-a;0'], expected: 'editor' },
    { names: ['Admin;umbrella;1'], expected: 'none' },
    { names: ['Admin;umbrella;0'], expected: 'none' },
    { names: ['Admin;tenant-b;0'], expected: 'none' },
    { names: ['admin;tenant-a;0'], expected: 'none' },
  ])('give memberships passed as $names $expected on a node without grants [permission.cfc:228]', async ({ names, expected }) => {
    const { deps } = world();
    expect(await perms(deps, await actorOf('system-user'), NODE, held(names))).toEqual([expected, expected]);
  });

  it.each([
    { types: ['Editor', 'Read'], expected: 'editor' },
    { types: ['Author', 'Read'], expected: 'author' },
    { types: ['Read', 'Deny'], expected: 'read' },
    { types: ['Deny'], expected: 'deny' },
    { types: [], expected: 'none' },
  ])('take the first of editor, author, read and deny held: grants $types give $expected [permission.cfc:230-238]', async ({ types, expected }) => {
    const actor = await actorOf('system-user');
    const { deps } = world({
      groups: [privateGroup(EDITORS, 'Editors')],
      memberships: [member(actor.userId, EDITORS)],
      grants: types.map((type) => grant(EDITORS, NODE, type)),
    });
    expect(await perms(deps, actor, NODE)).toEqual([expected, expected]);
    expect(await perms(deps, actor, NODE, held([EDITORS_NAME], [EDITORS]))).toEqual([expected, expected]);
  });

  it.each([
    { label: 'private Editors', group: privateGroup(EDITORS, 'Editors'), name: 'Editors;tenant-a;0', expected: 'editor' },
    { label: 'private Editors', group: privateGroup(EDITORS, 'Editors'), name: 'Editors;umbrella;0', expected: 'none' },
    { label: 'private Editors', group: privateGroup(EDITORS, 'Editors'), name: 'Editors;tenant-a;1', expected: 'none' },
    { label: 'private Editors', group: privateGroup(EDITORS, 'Editors'), name: 'Writers;tenant-a;0', expected: 'none' },
    { label: 'public Members', group: publicGroup(MEMBERS, 'Members'), name: 'Members;umbrella;1', expected: 'editor' },
    { label: 'public Members', group: publicGroup(MEMBERS, 'Members'), name: 'Members;umbrella;0', expected: 'none' },
    { label: 'public Members', group: publicGroup(MEMBERS, 'Members'), name: 'Members;tenant-a;1', expected: 'none' },
    { label: 'public Members', group: publicGroup(MEMBERS, 'Members'), name: 'Members;tenant-a;0', expected: 'none' },
  ])('match an Editor grant to $label only as name;pool;isPublic: membership $name gives $expected [permission.cfc:192-196]', async ({ group, name, expected }) => {
    const { deps } = world({ groups: [group], grants: [grant(group.group_id, NODE, 'Editor')] });
    expect(await perms(deps, await actorOf('system-user'), NODE, held([name], [group.group_id]))).toEqual([expected, expected]);
  });

  it('ignore grants stored for another site or held in another tenant [permission.cfc:214-216]', async () => {
    const actor = await actorOf('system-user');
    const { deps } = world({
      groups: [privateGroup(EDITORS, 'Editors')],
      memberships: [member(actor.userId, EDITORS)],
      grants: [
        grant(EDITORS, NODE, 'Editor', { site_id: TENANT_B.siteId }),
        grant(EDITORS, NODE, 'Author', { tenant_id: TENANT_B.tenantId }),
        grant(EDITORS, OTHER_NODE, 'Read'),
      ],
    });
    expect(await perms(deps, actor, NODE)).toEqual(['none', 'none']);
    expect(await perms(deps, actor, OTHER_NODE)).toEqual(['read', 'read']);
  });

  it.each([
    { subject: 'editor', node: 'the section', contentId: IDS.content.section, expected: 'editor' },
    { subject: 'approver', node: 'the section', contentId: IDS.content.section, expected: 'read' },
    { subject: 'editor', node: 'page one', contentId: IDS.content.pageOne, expected: 'none' },
    { subject: 'system-user', node: 'the section', contentId: IDS.content.section, expected: 'none' },
  ] as const)('give the seeded $subject $expected on $node', async ({ subject, contentId, expected }) => {
    const { deps } = world();
    expect(await perms(deps, await actorOf(subject), contentId)).toEqual([expected, expected]);
  });
});

describe('getNodePerm and getNodePermPublic [permission.cfc:266-300]', () => {
  const LINEAGE = [crumb(LEAF), crumb(PARENT), crumb(ROOT)];

  it.each([
    { label: 'leaf none, parent Author, root Editor', crumbs: LINEAGE, grants: [[PARENT, 'Author'], [ROOT, 'Editor']], expected: ['author', 'author'] },
    { label: 'leaf none, parent Deny, root Editor', crumbs: LINEAGE, grants: [[PARENT, 'Deny'], [ROOT, 'Editor']], expected: ['none', 'none'] },
    { label: 'leaf Read, parent Editor', crumbs: LINEAGE, grants: [[LEAF, 'Read'], [PARENT, 'Editor']], expected: ['read', 'read'] },
    { label: 'a single Read leaf', crumbs: [crumb(LEAF)], grants: [[LEAF, 'Read']], expected: ['read', 'read'] },
    { label: 'no grant on any crumb', crumbs: LINEAGE, grants: [], expected: ['none', 'none'] },
    { label: 'no crumbs', crumbs: [], grants: [[LEAF, 'Editor']], expected: ['none', ''] },
  ] as const)('stop at the first verdict that is not none, deny ending the walk as none: $label gives $expected', async ({ crumbs, grants, expected }) => {
    const actor = await actorOf('system-user');
    const { deps } = world({
      groups: [privateGroup(EDITORS, 'Editors')],
      memberships: [member(actor.userId, EDITORS)],
      grants: grants.map(([contentId, type]) => grant(EDITORS, contentId, type)),
    });
    expect(await nodePerms(deps, actor, crumbs)).toEqual(expected);
    expect(await nodePerms(deps, actor, crumbs, held([EDITORS_NAME], [EDITORS]))).toEqual(expected);
  });

  it('give an s2 actor editor at the first crumb without reading a projection, and no crumbs none and \'\'', async () => {
    const { db, deps } = world({ grants: [grant(EDITORS, LEAF, 'Deny')] });
    const s2 = await actorOf('s2');
    expect(await nodePerms(deps, s2, LINEAGE)).toEqual(['editor', 'editor']);
    expect(await nodePerms(deps, s2, [])).toEqual(['none', '']);
    expect(reads(db, PROJECTIONS)).toEqual([]);
  });

  it.each([
    { subject: 'editor', expected: ['editor', 'editor'] },
    { subject: 'approver', expected: ['read', 'read'] },
    { subject: 'member', expected: ['none', 'none'] },
  ] as const)('walk the seeded page-one crumbs up to the section grant for the $subject: $expected', async ({ subject, expected }) => {
    const { deps } = world();
    const crumbs = [crumb(IDS.content.pageOne), crumb(IDS.content.section), crumb(IDS.content.root)];
    expect(await nodePerms(deps, await actorOf(subject), crumbs)).toEqual(expected);
  });
});

describe('getModulePerm [permission.cfc:302-349]', () => {
  it.each([
    { subject: 's2', roles: [], moduleId: MODULE_010, expected: true },
    { subject: 's2', roles: [], moduleId: PLUGIN_MODULE, expected: true },
    { subject: 'site-admin', roles: [], moduleId: MODULE_010, expected: true },
    { subject: 'site-admin', roles: [], moduleId: PLUGIN_MODULE, expected: true },
    { subject: 'system-user', roles: [moduleRole(MODULE_010)], moduleId: MODULE_010, expected: true },
    { subject: 'system-user', roles: [moduleRole(MODULE_010)], moduleId: MODULE_011, expected: false },
    { subject: 'system-user', roles: [moduleRole(IDS.modules.content)], moduleId: IDS.modules.content, expected: true },
    { subject: 'system-user', roles: [moduleRole(IDS.modules.content)], moduleId: IDS.modules.forms, expected: false },
    { subject: 'system-user', roles: [moduleRole(IDS.modules.content)], moduleId: PLUGIN_MODULE, expected: false },
    { subject: 'system-user', roles: [], moduleId: IDS.modules.content, expected: false },
    { subject: 'editor', roles: [], moduleId: IDS.modules.content, expected: true },
    { subject: 'member', roles: [], moduleId: IDS.modules.content, expected: false },
  ] as const)('answers $subject with extra roles $roles on module $moduleId: $expected', async ({ subject, roles, moduleId, expected }) => {
    expect(getModulePerm(await actorOf(subject, roles), moduleId)).toBe(expected);
  });

  it('denies the anonymous actor every module', () => {
    expect([IDS.modules.content, MODULE_010, PLUGIN_MODULE].map((moduleId) => getModulePerm(ANONYMOUS, moduleId))).toEqual([false, false, false]);
  });
});

describe('setRestriction [permission.cfc:364-445]', () => {
  const restricted = (restrictgroups: string | null, contentid = NODE): CrumbNode[] => [crumb(contentid, { restricted: 1, restrictgroups }), crumb(ROOT)];
  const struct = (patch: Partial<Restriction>): Restriction => ({
    allow: true,
    restrict: false,
    loggedIn: true,
    perm: 'read',
    restrictGroups: '',
    hasModuleAccess: false,
    ...patch,
  });

  /** A system user holding private Editors and public Members through projected memberships. */
  async function memberWorld(grants: GrantRow[] = []): Promise<World & { actor: Actor }> {
    const actor = await actorOf('system-user');
    const projected = world({
      groups: [privateGroup(EDITORS, 'Editors'), publicGroup(MEMBERS, 'Members')],
      memberships: [member(actor.userId, EDITORS), member(actor.userId, MEMBERS, TENANT_UMBRELLA)],
      grants,
    });
    return { ...projected, actor };
  }

  it('denies an empty crumb list before any other check [permission.cfc:381-386]', async () => {
    const { deps, actor } = await memberWorld();
    expect(await setRestriction(deps, actor, [])).toEqual(struct({ allow: false, perm: 'none' }));
    expect(await setRestriction(deps, ANONYMOUS, [], true)).toEqual(struct({ allow: false, perm: 'none', loggedIn: false }));
  });

  it.each([
    { label: 'a group the user is not in', restrictGroups: 'Nope', allow: false, perm: 'none' },
    { label: 'a list naming the private Editors', restrictGroups: 'Nope,Editors', allow: true, perm: 'read' },
    { label: 'the public Members', restrictGroups: 'Members', allow: true, perm: 'read' },
    { label: 'the Members group id', restrictGroups: MEMBERS, allow: true, perm: 'read' },
    { label: 'editors in another case', restrictGroups: 'editors', allow: false, perm: 'none' },
    { label: 'no group', restrictGroups: '', allow: true, perm: 'read' },
  ] as const)(
    'admits a logged-in user without module access to a node restricted to $label by name in the site pools or by id: $allow [permission.cfc:411-427]',
    async ({ restrictGroups, allow, perm }) => {
      const { deps, actor } = await memberWorld();
      expect(await setRestriction(deps, actor, restricted(restrictGroups))).toEqual(
        struct({ allow, perm, restrict: true, restrictGroups, siteid: SITE }),
      );
    },
  );

  it('admits an s2 actor as editor and keeps the restriction flags [permission.cfc:394-398]', async () => {
    const { deps } = await memberWorld();
    expect(await setRestriction(deps, await actorOf('s2'), restricted('Nope'))).toEqual(
      struct({ perm: 'editor', restrict: true, restrictGroups: 'Nope', hasModuleAccess: true, siteid: SITE }),
    );
  });

  it('reports an anonymous actor as not logged in, denied on a restricted node and admitted to read elsewhere [permission.cfc:375-377]', async () => {
    const { deps } = await memberWorld();
    expect(await setRestriction(deps, ANONYMOUS, restricted(''))).toEqual(
      struct({ allow: false, loggedIn: false, perm: 'none', restrict: true, siteid: SITE }),
    );
    expect(await setRestriction(deps, ANONYMOUS, [crumb(NODE)])).toEqual(struct({ loggedIn: false }));
  });

  it.each([
    { label: 'leaf none, parent Author, root Editor', grants: [[PARENT, 'Author'], [ROOT, 'Editor']] },
    { label: 'leaf none, parent Deny, root Editor', grants: [[PARENT, 'Deny'], [ROOT, 'Editor']] },
    { label: 'leaf Read', grants: [[LEAF, 'Read']] },
    { label: 'no grant', grants: [] },
  ] as const)('gives a user with module access the getNodePerm verdict of unrestricted crumbs: $label', async ({ grants }) => {
    const { deps, actor } = await memberWorld(grants.map(([contentId, type]) => grant(EDITORS, contentId, type)));
    const crumbs = [crumb(LEAF), crumb(PARENT), crumb(ROOT)];
    const restriction = await setRestriction(deps, actor, crumbs, true);
    expect(restriction).toEqual(struct({ perm: await getNodePerm(deps, actor, crumbs), hasModuleAccess: true }));
  });

  it.each([
    { label: 'an Author grant on the restricted node', grants: [[NODE, 'Author']], restrictGroups: 'Nope', expected: { allow: true, perm: 'author' } },
    { label: 'no grant', grants: [], restrictGroups: 'Nope', expected: { allow: false, perm: 'none' } },
    { label: 'no grant but the Editors restrict group', grants: [], restrictGroups: 'Nope,Editors', expected: { allow: true, perm: 'read' } },
  ] as const)('judges a restricted node for a user with module access by $label [permission.cfc:399-405]', async ({ grants, restrictGroups, expected }) => {
    const { deps, actor } = await memberWorld(grants.map(([contentId, type]) => grant(EDITORS, contentId, type)));
    expect(await setRestriction(deps, actor, restricted(restrictGroups), true)).toEqual(
      struct({ ...expected, restrict: true, restrictGroups, hasModuleAccess: true, siteid: SITE }),
    );
  });

  it.each([
    { subject: 'editor', passed: undefined, expected: true },
    { subject: 'editor', passed: false, expected: false },
    { subject: 'system-user', passed: undefined, expected: false },
    { subject: 'system-user', passed: true, expected: true },
  ] as const)('takes hasModuleAccess as passed ($passed), else from the Site Manager module, for the $subject: $expected [permission.cfc:388-392]', async ({ subject, passed, expected }) => {
    const { deps } = world();
    expect((await setRestriction(deps, await actorOf(subject), [crumb(NODE)], passed)).hasModuleAccess).toBe(expected);
  });

  it.each([
    { subject: 'editor', allow: true, perm: 'read' },
    { subject: 'approver', allow: false, perm: 'none' },
  ] as const)('admits the seeded $subject to the node restricted to the Editor group: $allow', async ({ subject, allow, perm }) => {
    const { deps } = world();
    const crumbs = [crumb(IDS.content.restricted, { restricted: 1, restrictgroups: 'Editor' }), crumb(IDS.content.root)];
    expect(await setRestriction(deps, await actorOf(subject), crumbs)).toEqual(
      struct({ allow, perm, restrict: true, restrictGroups: 'Editor', hasModuleAccess: subject === 'editor', siteid: SITE }),
    );
  });
});

describe('allowContentAction [jsonApiUtility.cfc:1740-1790]', () => {
  const SITE_MANAGER = moduleRole(IDS.modules.content);
  const newPage = (patch: Partial<ContentActionInput> = {}): ContentActionInput => ({
    type: 'Page',
    contentId: newId(),
    siteId: SITE,
    parentId: IDS.content.section,
    ...patch,
  });

  /** A system user with `roles` holding private Editors, granted `type` on the seeded section when given. */
  async function grantedWorld(type: string | null, roles: readonly string[] = [SITE_MANAGER]): Promise<World & { actor: Actor }> {
    const actor = await actorOf('system-user', roles);
    const projected = world({
      groups: [privateGroup(EDITORS, 'Editors')],
      memberships: [member(actor.userId, EDITORS)],
      grants: type === null ? [] : [grant(EDITORS, IDS.content.section, type)],
    });
    return { ...projected, actor };
  }

  it.each([
    { label: 'Editor', type: 'Editor', allowed: true, forceUnapproved: false },
    { label: 'Author', type: 'Author', allowed: true, forceUnapproved: true },
    { label: 'Read', type: 'Read', allowed: false, forceUnapproved: false },
    { label: 'Deny', type: 'Deny', allowed: false, forceUnapproved: false },
    { label: 'nothing', type: null, allowed: false, forceUnapproved: false },
  ])('judges new content under a parent granted $label by the parent crumbs: allowed $allowed, unapproved $forceUnapproved', async ({ type, allowed, forceUnapproved }) => {
    const expected = { allowed, forceUnapproved };
    const { deps, actor } = await grantedWorld(type);
    expect(await allowContentAction(deps, actor, newPage())).toEqual(expected);
    expect(await allowContentAction(deps, actor, newPage({ isNew: true }))).toEqual(expected);
  });

  it.each([
    { type: 'Page', roles: [SITE_MANAGER], allowed: true },
    { type: 'Form', roles: [SITE_MANAGER], allowed: false },
    { type: 'form', roles: [SITE_MANAGER], allowed: false },
    { type: 'Component', roles: [SITE_MANAGER], allowed: false },
    { type: 'Variation', roles: [SITE_MANAGER], allowed: false },
    { type: 'Page', roles: [], allowed: false },
    { type: 'Form', roles: [moduleRole(IDS.modules.forms)], allowed: true },
    { type: 'Component', roles: [moduleRole(IDS.modules.components)], allowed: true },
    { type: 'Variation', roles: [moduleRole(VARIATION_MODULE)], allowed: true },
  ])('checks the module of type $type with roles $roles before the editor verdict: $allowed', async ({ type, roles, allowed }) => {
    const { db, deps, actor } = await grantedWorld('Editor', roles);
    expect(await allowContentAction(deps, actor, newPage({ type }))).toEqual({ allowed, forceUnapproved: false });
    expect(reads(db, CRUMBS).length > 0).toBe(allowed);
  });

  it('judges a stored item by its own crumbs, a caller-known new item by its parent crumbs, and denies where none are found', async () => {
    const { deps, actor } = await grantedWorld('Editor');
    const pageOne = { contentId: IDS.content.pageOne, parentId: '' };
    expect(await allowContentAction(deps, actor, newPage(pageOne))).toEqual({ allowed: true, forceUnapproved: false });
    expect(await allowContentAction(deps, actor, newPage({ ...pageOne, isNew: false }))).toEqual({ allowed: true, forceUnapproved: false });
    expect(await allowContentAction(deps, actor, newPage({ ...pageOne, parentId: IDS.content.root, isNew: true }))).toEqual({ allowed: false, forceUnapproved: false });
    expect(await allowContentAction(deps, actor, newPage({ isNew: false }))).toEqual({ allowed: false, forceUnapproved: false });
    expect(await allowContentAction(deps, actor, newPage({ parentId: newId() }))).toEqual({ allowed: false, forceUnapproved: false });
  });

  it('allows an s2 actor wherever crumbs exist, but not new content without a parent [jsonApiUtility.cfc:1778-1788]', async () => {
    const { deps } = world();
    const s2 = await actorOf('s2');
    const allowed = { allowed: true, forceUnapproved: false };
    expect(await allowContentAction(deps, s2, newPage())).toEqual(allowed);
    expect(await allowContentAction(deps, s2, newPage({ contentId: IDS.content.pageOne }))).toEqual(allowed);
    expect(await allowContentAction(deps, s2, newPage({ type: 'Variation' }))).toEqual(allowed);
    expect(await allowContentAction(deps, s2, newPage({ type: 'Form', parentId: IDS.content.formsModule }))).toEqual(allowed);
    expect(await allowContentAction(deps, s2, newPage({ parentId: '' }))).toEqual({ allowed: false, forceUnapproved: false });
  });

  it.each([
    { subject: 'editor', allowed: true },
    { subject: 'approver', allowed: false },
  ] as const)('judges the seeded $subject on page one by the section grant: $allowed', async ({ subject, allowed }) => {
    const { deps } = world();
    const actor = await actorOf(subject, subject === 'approver' ? [moduleRole(IDS.modules.content)] : []);
    expect(await allowContentAction(deps, actor, newPage({ contentId: IDS.content.pageOne }))).toEqual({ allowed, forceUnapproved: false });
  });

  it('denies the anonymous actor at the module check, reading no crumbs', async () => {
    const { db, deps } = world();
    expect(await allowContentAction(deps, ANONYMOUS, newPage())).toEqual({ allowed: false, forceUnapproved: false });
    expect(reads(db, CRUMBS)).toEqual([]);
  });
});

describe('loadMemberships', () => {
  it('names each membership groupname;siteid;isPublic from the public, then the private user pool tenant, never a third tenant', async () => {
    const actor = await actorOf('system-user');
    const { db, deps } = world({
      groups: [
        privateGroup(EDITORS, 'Editors'),
        publicGroup(MEMBERS, 'Members'),
        groupProjectionRow({ tenant_id: TENANT_B.tenantId, group_id: OTHER, site_id: TENANT_B.siteId, group_name: 'Other' }),
      ],
      memberships: [member(actor.userId, EDITORS), member(actor.userId, MEMBERS, TENANT_UMBRELLA), member(actor.userId, OTHER, TENANT_B)],
    });
    expect(await loadMemberships(deps, actor)).toEqual({ names: ['Members;umbrella;1', EDITORS_NAME], groupIds: [MEMBERS, EDITORS] });
    expect(reads(db, MEMBERSHIPS).map((statement) => statement.tenantId)).toEqual([TENANT_UMBRELLA.tenantId, TENANT_A.tenantId]);
    expect(db.statements.some((statement) => statement.tenantId === TENANT_B.tenantId)).toBe(false);
  });

  it('lists the seeded editor subject in the private Editor group', async () => {
    const { deps } = world();
    expect(await loadMemberships(deps, await actorOf('editor'))).toEqual({ names: ['Editor;tenant-a;0'], groupIds: [IDS.groups.editor] });
  });

  it('answers no memberships for a user without any, reading no group, and for the anonymous actor, reading nothing', async () => {
    const { db, deps } = world();
    expect(await loadMemberships(deps, await actorOf('system-user'))).toEqual({ names: [], groupIds: [] });
    expect(reads(db, GROUPS)).toEqual([]);
    db.clear();
    expect(await loadMemberships(deps, ANONYMOUS)).toEqual({ names: [], groupIds: [] });
    expect(db.statements).toEqual([]);
  });
});
