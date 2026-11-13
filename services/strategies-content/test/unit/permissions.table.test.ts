/** Node, module, restriction, category and content-action verdicts of permission.cfc over projections seeded in tenant-a, tenant-b and the umbrella pool. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleRole } from '@opt2/platform/auth';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import { UnregisteredTenantError } from '../../src/domain/pools.js';
import {
  allowContentAction,
  getCategoryPerm,
  getModulePerm,
  getNodePerm,
  getNodePermPublic,
  getPerm,
  getPermPublic,
  loadMemberships,
  setRestriction,
  sitePools,
  type CrumbNode,
  type PermissionDeps,
} from '../../src/domain/permissions.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const id = (p: string, n: number): string => `${p}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const SITE = TENANT_A.siteId;
const END = '00000000000000000000000000000000END';

const G = {
  editors: id('G', 1),
  authors: id('G', 2),
  readers: id('G', 3),
  denied: id('G', 4),
  admin: id('G', 5),
  upperEditors: id('G', 6),
  members: id('G', 7),
  publicAdmin: id('G', 8),
  gone: id('G', 9),
  other: id('G', 10),
  comma: id('G', 11),
};
const U = { user: id('U', 1), member: id('U', 2), nobody: id('U', 3), commaUser: id('U', 4) };
const C = { root: id('C', 1), parent: id('C', 2), leaf: id('C', 3), none: id('C', 4), deny: id('C', 5), typed: id('C', 6) };

let handle: ThrowawaySchema;
let repo: ContentRepository;
let deps: PermissionDeps;
let nodeSeq = 0;

const inT = <T>(tenant: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, tenant, fn);

function actor(userId: string, opts: { roles?: string[]; s2?: boolean; site?: string; tid?: string } = {}): Actor {
  return actorFromClaims(
    {
      iss: 'i',
      aud: 'a',
      sub: userId,
      sid: 's',
      tid: opts.tid ?? TENANT_A.tenantId,
      site: opts.site ?? SITE,
      roles: opts.roles ?? ['system-user'],
      s2: opts.s2 ?? false,
      epoch: 0,
      iat: 0,
      exp: 0,
    },
    'Name',
  );
}
const anon = actorFromClaims(undefined, '');

function crumb(contentid: string, extra: Partial<CrumbNode> = {}): CrumbNode {
  return { contentid, siteid: SITE, restricted: 0, restrictgroups: null, ...extra };
}

async function grant(groupId: string, rows: Array<[string, string]>): Promise<void> {
  await inT(TENANT_A.tenantId, (tx) =>
    repo.projections.replaceGroupPermissions(
      tx,
      groupId,
      SITE,
      rows.map(([contentId, type]) => ({ contentId, siteId: SITE, type })),
    ),
  );
}

describe.skipIf(!(await pgAvailable()))('domain/permissions', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'permissions-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'permissions-test', state: 'open' });
    await seedRegistry(handle.app);
    repo = createContentRepository({ clock: fixedClock('2026-06-30T10:00:00'), schema: handle.schema });
    deps = { db: handle.app, repository: repo };

    const priv = (groupId: string, name: string, deleted = false) => ({ groupId, siteId: SITE, groupName: name, isPublic: 0, deleted });
    await inT(TENANT_A.tenantId, async (tx) => {
      for (const g of [
        priv(G.editors, 'Editors'),
        priv(G.authors, 'Authors'),
        priv(G.readers, 'Readers'),
        priv(G.denied, 'Denied'),
        priv(G.admin, 'Admin'),
        priv(G.upperEditors, 'EDITORS'),
        priv(G.gone, 'Gone', true),
        priv(G.comma, 'x,Admin'),
      ]) {
        await repo.projections.upsertGroupProjection(tx, g);
      }
      await repo.projections.replaceUserMemberships(tx, U.user, SITE, [G.editors, G.members, G.gone]);
      await repo.projections.replaceUserMemberships(tx, U.commaUser, SITE, [G.comma]);
    });
    await inT(TENANT_UMBRELLA.tenantId, async (tx) => {
      await repo.projections.upsertGroupProjection(tx, { groupId: G.members, siteId: 'umbrella', groupName: 'Members', isPublic: 1, deleted: false });
      await repo.projections.upsertGroupProjection(tx, { groupId: G.publicAdmin, siteId: 'umbrella', groupName: 'Admin', isPublic: 1, deleted: false });
      await repo.projections.replaceUserMemberships(tx, U.member, 'umbrella', [G.members, G.publicAdmin]);
    });
    await inT(TENANT_B.tenantId, async (tx) => {
      await repo.projections.upsertGroupProjection(tx, { groupId: G.other, siteId: 'tenant-b', groupName: 'Other', isPublic: 0, deleted: false });
      await repo.projections.replaceUserMemberships(tx, U.user, 'tenant-b', [G.other]);
    });
    await inT(TENANT_A.tenantId, async (tx) => {
      const v = (contentid: string, parentid: string, extra: Record<string, unknown> = {}) =>
        repo.content.insertVersion(tx, { contentid, siteid: SITE, parentid, type: 'Page', subtype: 'Default', moduleid: '00000000000000000000000000000000000', active: 1, approved: 1, ...extra });
      await v(C.root, END);
      await v(C.parent, C.root);
      await v(C.leaf, C.parent);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('loadMemberships lists groupname;siteid;isPublic from both user pool tenants, without tombstones or other tenants', async () => {
    const m = await loadMemberships(deps, actor(U.user));
    expect([...m.names].sort()).toEqual(['Editors;tenant-a;0', 'Members;umbrella;1']);
    expect([...m.groupIds].sort()).toEqual([G.editors, G.members].sort());
    const pub = await loadMemberships(deps, actor(U.member));
    expect([...pub.names].sort()).toEqual(['Admin;umbrella;1', 'Members;umbrella;1']);
    expect(await loadMemberships(deps, anon)).toEqual({ names: [], groupIds: [] });
    expect(await loadMemberships(deps, actor(U.nobody))).toEqual({ names: [], groupIds: [] });
    const comma = await loadMemberships(deps, actor(U.commaUser));
    expect(comma.names).toEqual(['x', 'Admin;tenant-a;0']);
    const b = await loadMemberships(deps, actor(U.user, { tid: TENANT_B.tenantId, site: 'tenant-b' }));
    expect(b).toEqual({ names: ['Other;tenant-b;0'], groupIds: [G.other] });
  });

  it.each([
    [[['editor', G.editors], ['read', G.editors]], 'editor'],
    [[['author', G.editors], ['read', G.editors]], 'author'],
    [[['read', G.editors], ['deny', G.editors]], 'read'],
    [[['deny', G.editors]], 'deny'],
    [[['Editor ', G.editors]], 'editor'],
    [[['editor', G.upperEditors]], 'none'],
    [[['read', G.members]], 'read'],
    [[['editor', G.readers]], 'none'],
    [[['editor', G.gone]], 'none'],
    [[['editor', id('G', 99)]], 'none'],
    [[], 'none'],
  ] as Array<[Array<[string, string]>, string]>)('getPerm precedence %j -> %s', async (grants, expected) => {
    nodeSeq += 1;
    const node = id('N', nodeSeq);
    for (const groupId of new Set(grants.map(([, g]) => g))) {
      await grant(groupId, grants.filter(([, g]) => g === groupId).map(([type]) => [node, type]));
    }
    expect(await getPerm(deps, actor(U.user), node, SITE)).toBe(expected);
    expect(await getPermPublic(deps, actor(U.user), node, SITE, await loadMemberships(deps, actor(U.user)))).toBe(expected);
    for (const groupId of new Set(grants.map(([, g]) => g))) {
      await grant(groupId, []);
    }
  });

  it('S2, site-admin and the private-pool Admin group give editor; a public-pool Admin and another site do not', async () => {
    expect(await getPerm(deps, actor(U.nobody, { s2: true }), C.none, SITE)).toBe('editor');
    expect(await getPerm(deps, actor(U.nobody, { roles: ['s2'] }), C.none, SITE)).toBe('editor');
    expect(await getPerm(deps, actor(U.nobody, { roles: ['site-admin'] }), C.none, SITE)).toBe('editor');
    expect(await getPerm(deps, actor(U.commaUser), C.none, SITE)).toBe('editor');
    expect(await getPerm(deps, actor(U.member), C.none, SITE)).toBe('none');
    expect(await getPerm(deps, anon, C.none, SITE)).toBe('none');
    expect(await getPerm(deps, actor(U.nobody, { roles: ['site-admin'] }), C.none, 'other-site')).toBe('none');
  });

  it('getNodePerm takes the first non-none crumb verdict and maps deny to none; the public variant keeps \'\' for no crumbs [permission.cfc:266-300]', async () => {
    const [leaf, parent, root] = [id('W', 1), id('W', 2), id('W', 3)];
    await grant(G.editors, [[parent, 'author'], [root, 'editor']]);
    const crumbs = [crumb(leaf), crumb(parent), crumb(root)];
    expect(await getNodePerm(deps, actor(U.user), crumbs)).toBe('author');
    await grant(G.editors, [[parent, 'deny'], [root, 'editor']]);
    expect(await getNodePerm(deps, actor(U.user), crumbs)).toBe('none');
    expect(await getNodePermPublic(deps, actor(U.user), crumbs)).toBe('none');
    await grant(G.editors, [[leaf, 'read']]);
    expect(await getNodePerm(deps, actor(U.user), crumbs)).toBe('read');
    await grant(G.editors, []);
    expect(await getNodePerm(deps, actor(U.user), crumbs)).toBe('none');
    expect(await getNodePerm(deps, actor(U.user), [])).toBe('none');
    expect(await getNodePermPublic(deps, actor(U.user), [])).toBe('');
    expect(await getNodePerm(deps, actor(U.nobody, { s2: true }), crumbs)).toBe('editor');
  });

  it.each([
    [[], true, '00000000000000000000000000000000010', true],
    [['s2'], false, '00000000000000000000000000000000010', true],
    [['site-admin'], false, 'PLUGINMODULE', true],
    [[moduleRole('00000000000000000000000000000000010')], false, '00000000000000000000000000000000010', true],
    [['m:010'], false, '00000000000000000000000000000000011', false],
    [['m:000'], false, '00000000000000000000000000000000000', true],
    [['m:000'], false, '00000000000000000000000000000000004', false],
    [['m:000'], false, 'PLUGINMODULE', false],
  ] as Array<[string[], boolean, string, boolean]>)('getModulePerm with roles %j and s2 %s on %s is %s', (roles, s2, moduleId, expected) => {
    expect(getModulePerm(actor(U.user, { roles, s2 }), moduleId)).toBe(expected);
  });

  it('setRestriction walks restricted crumbs, the S2 and module-access paths and restrict groups by name or id [permission.cfc:364-445]', async () => {
    const restricted = (groups: string | null) => [crumb(id('R', 1), { restricted: 1, restrictgroups: groups })];
    expect(await setRestriction(deps, actor(U.user), [])).toEqual({ allow: false, restrict: false, loggedIn: true, perm: 'none', restrictGroups: '', hasModuleAccess: false });
    expect(await setRestriction(deps, actor(U.user), restricted('Nope'))).toMatchObject({ allow: false, restrict: true, perm: 'none', siteid: SITE });
    expect(await setRestriction(deps, actor(U.user), restricted('Nope,Editors'))).toMatchObject({ allow: true, perm: 'read' });
    expect(await setRestriction(deps, actor(U.user), restricted('Members'))).toMatchObject({ allow: true, perm: 'read' });
    expect(await setRestriction(deps, actor(U.user), restricted(G.editors))).toMatchObject({ allow: true });
    expect(await setRestriction(deps, actor(U.user), restricted('editors'))).toMatchObject({ allow: false });
    expect(await setRestriction(deps, actor(U.user), restricted(null))).toMatchObject({ allow: true, perm: 'read', restrictGroups: '' });
    expect(await setRestriction(deps, anon, restricted(''))).toMatchObject({ allow: false, loggedIn: false, perm: 'none' });
    expect(await setRestriction(deps, actor(U.nobody, { s2: true }), restricted('Nope'))).toMatchObject({ allow: true, perm: 'editor' });
    expect(await setRestriction(deps, actor(U.user), [crumb(id('R', 2))])).toMatchObject({ allow: true, restrict: false, perm: 'read', hasModuleAccess: false });
    const node = id('R', 3);
    await grant(G.editors, [[node, 'author']]);
    expect(await setRestriction(deps, actor(U.user, { roles: ['m:000'] }), [crumb(node)])).toMatchObject({ allow: true, perm: 'author', hasModuleAccess: true });
    expect(await setRestriction(deps, actor(U.user), [crumb(node)], true)).toMatchObject({ perm: 'author', hasModuleAccess: true });
    expect(await setRestriction(deps, actor(U.user), [crumb(node, { restricted: 1, restrictgroups: 'Nope' })], true)).toMatchObject({ allow: true, perm: 'author' });
    expect(await setRestriction(deps, actor(U.user), [crumb(id('R', 4), { restricted: 1, restrictgroups: 'Nope' })], true)).toMatchObject({ allow: false, perm: 'none' });
    expect(await setRestriction(deps, actor(U.user), [crumb(id('R', 4), { restricted: 1, restrictgroups: 'Nope,Editors' })], true)).toMatchObject({ allow: true, perm: 'read' });
    expect(await setRestriction(deps, actor(U.nobody, { roles: ['site-admin'] }), [crumb(id('R', 5))])).toMatchObject({ allow: true, perm: 'editor', hasModuleAccess: true });
    await grant(G.editors, []);
  });

  it('getCategoryPerm allows an empty list, S2, site Admin or a held group; sitePools reads the registry [permission.cfc:447-476]', async () => {
    const pools = await sitePools(deps, actor(U.user));
    expect(pools).toEqual({ publicUserPoolId: 'umbrella', privateUserPoolId: 'tenant-a' });
    const m = await loadMemberships(deps, actor(U.user));
    expect(getCategoryPerm(actor(U.user), m, '', SITE, pools)).toBe(true);
    expect(getCategoryPerm(actor(U.user), m, 'Nope', SITE, pools)).toBe(false);
    expect(getCategoryPerm(actor(U.user), m, 'Nope,Members', SITE, pools)).toBe(true);
    expect(getCategoryPerm(actor(U.user), m, G.editors, SITE, pools)).toBe(true);
    expect(getCategoryPerm(actor(U.nobody, { s2: true }), { names: [], groupIds: [] }, 'Nope', SITE, pools)).toBe(true);
    expect(getCategoryPerm(actor(U.nobody, { roles: ['site-admin'] }), { names: [], groupIds: [] }, 'Nope', SITE, pools)).toBe(true);
    expect(getCategoryPerm(actor(U.nobody), { names: ['Admin;tenant-a;0'], groupIds: [] }, 'Nope', SITE, pools)).toBe(true);
    await expect(sitePools(deps, actor(U.user, { tid: '11111111-1111-4111-8111-111111111111' }))).rejects.toBeInstanceOf(UnregisteredTenantError);
  });

  it('allowContentAction checks the type module, then the item or parent node verdict; author saves unapproved [jsonApiUtility.cfc:1740-1790]', async () => {
    const editor = actor(U.user, { roles: ['m:000', 'm:004'] });
    await grant(G.editors, [[C.parent, 'editor']]);
    expect(await allowContentAction(deps, editor, { type: 'Page', contentId: id('X', 1), siteId: SITE, parentId: C.parent })).toEqual({ allowed: true, forceUnapproved: false });
    expect(await allowContentAction(deps, editor, { type: 'Page', contentId: C.leaf, siteId: SITE, parentId: '' })).toEqual({ allowed: true, forceUnapproved: false });
    await grant(G.editors, [[C.parent, 'author']]);
    expect(await allowContentAction(deps, editor, { type: 'form', contentId: id('X', 1), siteId: SITE, parentId: C.parent, isNew: true })).toEqual({ allowed: true, forceUnapproved: true });
    expect(await allowContentAction(deps, editor, { type: 'Component', contentId: id('X', 1), siteId: SITE, parentId: C.parent })).toEqual({ allowed: false, forceUnapproved: false });
    await grant(G.editors, [[C.parent, 'read']]);
    expect(await allowContentAction(deps, editor, { type: 'Page', contentId: id('X', 1), siteId: SITE, parentId: C.parent })).toEqual({ allowed: false, forceUnapproved: false });
    expect(await allowContentAction(deps, editor, { type: 'Page', contentId: id('X', 1), siteId: SITE, parentId: '' })).toEqual({ allowed: false, forceUnapproved: false });
    expect(await allowContentAction(deps, editor, { type: 'Page', contentId: id('X', 1), siteId: SITE, parentId: C.parent, isNew: false })).toEqual({ allowed: false, forceUnapproved: false });
    expect(await allowContentAction(deps, actor(U.nobody, { s2: true }), { type: 'Variation', contentId: id('X', 1), siteId: SITE, parentId: C.parent })).toEqual({ allowed: true, forceUnapproved: false });
    expect(await allowContentAction(deps, anon, { type: 'Page', contentId: id('X', 1), siteId: SITE, parentId: C.parent })).toEqual({ allowed: false, forceUnapproved: false });
    await grant(G.editors, []);
  });
});
