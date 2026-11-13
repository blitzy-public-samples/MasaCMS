/** domain/categories: categoryBean rules, the ccategory access check, and categoryManager/categoryGateway operations over a throwaway `content` schema with tenant-a, tenant-b and umbrella registered. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  CATEGORY_FILENAME_RULES_DEFAULT,
  categoryAccess,
  categoryCrumbs,
  categoryFeatures,
  categoryStruct,
  countCategories,
  createCategory,
  deleteCategory,
  keepCategories,
  listCategories,
  listPoolCategories,
  newCategoryBean,
  readCategory,
  restrictGroups,
  saveCategory,
  setCategoryAssignments,
  setListOrder,
  updateCategory,
  updateCategoryAction,
  validateCategory,
  type CategoryActionOptions,
  type CategoryBean,
  type CategoryDeps,
  type CategoryInput,
  type CategoryReadKey,
  type ListCategoriesOptions,
  type RestrictGroupRow,
} from '../../src/domain/categories.js';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import { UnregisteredTenantError } from '../../src/domain/pools.js';
import { WddxDate, WddxNumber, wddx2cfml, wddxStructGet, type WddxStruct } from '../../src/domain/wddx.js';
import { createContentRepository, type CategoryAssignmentInput, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS, type CategoryAssignRow, type CategoryRow, type TrashRow } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 0, 0, 456);
const NOW_S = new Date(2026, 5, 30, 10, 0, 0, 0);
const TS_NOW = "{ts '2026-06-30 10:00:00'}";
const clock = fixedClock(NOW);
const POOL = TENANT_UMBRELLA.siteId;
const UMBRELLA = TENANT_UMBRELLA.tenantId;
const UNREGISTERED = '00000000-0000-4000-8000-0000000000ff';
const SITE_MANAGER = '00000000000000000000000000000000000';
const LIST_REDIRECT = { kind: 'redirect', action: 'cCategory.list', append: ['siteid'] };

function actor(opts: { tid?: string; site?: string; roles?: string[]; s2?: boolean } = {}): Actor {
  const claims: UserClaims = {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: cfId('U', 1),
    sid: 'session-1',
    tid: opts.tid ?? TENANT_A.tenantId,
    site: opts.site ?? TENANT_A.siteId,
    roles: opts.roles ?? ['s2'],
    s2: opts.s2 ?? false,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
  return actorFromClaims(claims, 'Admin User');
}

/** tenant-a's actor: category pool `umbrella`, content pool `tenant-a`. */
const A = actor();
/** tenant-b's actor: every pool its own site. */
const B = actor({ tid: TENANT_B.tenantId, site: TENANT_B.siteId });

const named = (patch: Partial<CategoryBean>): CategoryBean => ({ ...newCategoryBean(clock), name: 'Topic', ...patch });

describe('categoryBean rules', () => {
  it('getBean("category") holds the categoryBean init values with now() as {ts} text', () => {
    const bean = newCategoryBean(clock);
    expect(bean).toEqual({
      categoryid: '',
      siteid: '',
      datecreated: TS_NOW,
      lastupdate: TS_NOW,
      lastupdateby: '',
      name: '',
      isinterestgroup: 1,
      parentid: '',
      isactive: 1,
      isopen: 1,
      notes: '',
      sortby: 'orderno',
      sortdirection: 'asc',
      restrictgroups: '',
      path: '',
      remoteid: '',
      remotesourceurl: '',
      remotepubdate: '',
      urltitle: '',
      filename: '',
      isfeatureable: 1,
      isnew: 1,
      frommuracache: false,
      instanceid: expect.any(String),
      errors: {},
    });
    expect(isCfUuid(bean.instanceid)).toBe(true);
    expect(newCategoryBean(clock).instanceid).not.toBe(bean.instanceid);
  });

  it('defaults the filename rules to the configBean URLTitleDelim and allowUnicodeInFilenames', () => {
    expect(CATEGORY_FILENAME_RULES_DEFAULT).toEqual({ urlTitleDelim: '-', allowUnicodeInFilenames: false });
    expect(Object.isFrozen(CATEGORY_FILENAME_RULES_DEFAULT)).toBe(true);
  });

  it.each<[string, Partial<CategoryBean>, string[]]>([
    ['a named bean passes', {}, []],
    ['a missing name fails name', { name: '' }, ['name']],
    ['an empty sortBy fails sortBy', { sortby: '' }, ['sortBy']],
    ['an empty sortDirection fails sortDirection', { sortdirection: '' }, ['sortDirection']],
    ['a non-numeric isActive fails isActive', { isactive: 'yes' }, ['isActive']],
    ['an empty isInterestGroup fails isInterestGroup', { isinterestgroup: '' }, ['isInterestGroup']],
    ['an empty isFeatureable fails isFeatureable', { isfeatureable: '' }, ['isFeatureable']],
    ['an empty isOpen passes (not required)', { isopen: '' }, []],
    ['a non-numeric isOpen fails isOpen', { isopen: 'x' }, ['isOpen']],
    ['a site id past 25 characters fails siteid', { siteid: 's'.repeat(26) }, ['siteid']],
    ['a category id past 35 characters fails categoryID', { categoryid: 'C'.repeat(36) }, ['categoryID']],
    ['a parent id past 35 characters fails parentid', { parentid: 'P'.repeat(36) }, ['parentid']],
    ['a dateCreated that is no date fails dateCreated', { datecreated: 'not a date' }, ['dateCreated']],
    ['a lastUpdate Date passes', { lastupdate: NOW }, []],
    ['a remotePubDate that is no date fails remotePubDate', { remotepubdate: 'soon' }, ['remotePubDate']],
  ])('validateCategory: %s', (_label, patch, keys) => {
    const errors = validateCategory(named(patch));
    expect(Object.keys(errors)).toEqual(keys);
    for (const key of keys) expect(errors[key]).toBe(`The property named '${key}' is not valid`);
  });

  it('validateCategory reports every failing property at once', () => {
    expect(Object.keys(validateCategory(named({ name: '', isactive: 'x', siteid: 's'.repeat(26) }))).sort()).toEqual(['isActive', 'name', 'siteid']);
  });

  it('categoryStruct holds each getAllValues key once, numbers and dates as cfwddx writes them, then the extra entries', () => {
    const bean = named({ categoryid: cfId('K', 1), remotepubdate: NOW_S, errors: { name: 'bad' } });
    const struct = categoryStruct(bean, [['muraDeleteID', 'D-1']]);
    const keys = struct.entries.map(([key]) => key);
    expect([...keys].sort()).toEqual(
      [
        'ISNEW', 'ERRORS', 'FROMMURACACHE', 'INSTANCEID', 'ADDOBJECTS', 'REMOVEOBJECTS', 'CATEGORYID', 'SITEID', 'DATECREATED',
        'LASTUPDATE', 'LASTUPDATEBY', 'NAME', 'ISINTERESTGROUP', 'PARENTID', 'ISACTIVE', 'ISOPEN', 'NOTES', 'SORTBY',
        'SORTDIRECTION', 'RESTRICTGROUPS', 'PATH', 'REMOTEID', 'REMOTESOURCEURL', 'REMOTEPUBDATE', 'URLTITLE', 'FILENAME',
        'ISFEATUREABLE', 'muraDeleteID',
      ].sort(),
    );
    expect(wddxStructGet(struct, 'categoryid')).toBe(cfId('K', 1));
    expect(wddxStructGet(struct, 'isactive')).toEqual(new WddxNumber('1.0'));
    expect(wddxStructGet(struct, 'isnew')).toEqual(new WddxNumber('1.0'));
    expect(wddxStructGet(struct, 'datecreated')).toBe(TS_NOW);
    expect(wddxStructGet(struct, 'remotepubdate')).toEqual(new WddxDate(NOW_S));
    expect(wddxStructGet(struct, 'addobjects')).toEqual([]);
    expect((wddxStructGet(struct, 'errors') as WddxStruct).entries).toEqual([['name', 'bad']]);
    expect(wddxStructGet(struct, 'muraDeleteID')).toBe('D-1');
    expect(wddxStructGet(categoryStruct({ ...bean, isnew: '0' }), 'ISNEW')).toBe('0');
  });

  it.each<[string, { roles: string[]; s2?: boolean }, boolean]>([
    ['allows the S2 flag', { roles: [], s2: true }, true],
    ['allows the s2 role', { roles: ['s2'] }, true],
    ['allows the site Admin role', { roles: ['site-admin'] }, true],
    ['allows both module roles m:010 and m:000', { roles: ['system-user', 'm:010', 'm:000'] }, true],
    ['denies the Categories module role m:010 alone', { roles: ['system-user', 'm:010'] }, false],
    ['denies the Site Manager module role m:000 alone', { roles: ['system-user', 'm:000'] }, false],
    ['denies a system user without module roles', { roles: ['system-user'] }, false],
  ])('categoryAccess %s', (_label, claims, allowed) => {
    expect(categoryAccess(actor(claims))).toBe(allowed);
  });

  it('categoryAccess denies the anonymous actor', () => {
    expect(categoryAccess(actorFromClaims(undefined, ''))).toBe(false);
  });
});

let handle: ThrowawaySchema;
let repo: ContentRepository;
let deps: CategoryDeps;

const inT = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, tenantId, fn);

/** The `content.category` row of `categoryId` as tenant `tenantId` sees it. */
function stored(tenantId: string, categoryId: string): Promise<CategoryRow | undefined> {
  return inT(tenantId, async (tx) => (await tx.query<CategoryRow>(`SELECT * FROM ${handle.schema}.category WHERE categoryid = $1`, [categoryId])).rows[0]);
}

/** The number of `content.category` rows tenant `tenantId` holds, optionally only those named `name`. */
function countIn(tenantId: string, name?: string): Promise<number> {
  return inT(tenantId, async (tx) => {
    const sql = `SELECT count(*)::integer AS n FROM ${handle.schema}.category${name === undefined ? '' : ' WHERE name = $1'}`;
    return (await tx.query<{ n: number }>(sql, name === undefined ? [] : [name])).rows[0]?.n ?? 0;
  });
}

/** The `content.trash` row of `objectId` in tenant `tenantId`. */
function trashOf(tenantId: string, objectId: string): Promise<TrashRow | undefined> {
  return inT(tenantId, async (tx) => (await tx.query<TrashRow>(`SELECT * FROM ${handle.schema}.trash WHERE objectid = $1`, [objectId])).rows[0]);
}

/** The category assignments of version `contentHistId` in tenant `tenantId`, by category id. */
function assignmentsOf(tenantId: string, contentHistId: string): Promise<CategoryAssignRow[]> {
  return inT(tenantId, async (tx) =>
    (await tx.query<CategoryAssignRow>(`SELECT * FROM ${handle.schema}.content_category_assign WHERE contenthistid = $1 ORDER BY categoryid`, [contentHistId])).rows,
  );
}

/** `fn`'s result and the changelog rows (`op table`) it added in tenant `tenantId`. */
async function changesIn<T>(tenantId: string, fn: () => Promise<T>): Promise<{ result: T; changes: string[] }> {
  const read = (offset: number): Promise<Array<{ op: string; table: string }>> =>
    inT(tenantId, async (tx) => (await tx.query<{ op: string; table: string }>(`SELECT op, "table" FROM ${handle.schema}.changelog ORDER BY seq OFFSET $1`, [offset])).rows);
  const before = (await read(0)).length;
  const result = await fn();
  return { result, changes: (await read(before)).map((change) => `${change.op} ${change.table}`) };
}

const create = (who: Actor, input: CategoryInput): Promise<CategoryBean> => createCategory(deps, who, input);

describe.skipIf(!(await pgAvailable()))('domain/categories operations', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'categories-domain-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'categories-domain-test', state: 'open' });
    await seedRegistry(handle.app);
    repo = createContentRepository({ clock, schema: handle.schema });
    deps = { db: handle.app, repository: repo, clock };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  describe('createCategory', () => {
    it('creates under a parent with a CF UUID, the root-first path, the clock second and the parent filename', async () => {
      const root = await create(A, { siteid: POOL, name: 'Parent Topic' });
      const child = await create(A, { siteid: POOL, name: 'Child Topic', parentid: root.categoryid });
      expect(isCfUuid(root.categoryid)).toBe(true);
      expect(isCfUuid(child.categoryid)).toBe(true);
      expect(root).toMatchObject({ path: root.categoryid, urltitle: 'parent-topic', filename: 'parent-topic', isnew: '0', errors: {} });
      expect(child).toMatchObject({
        path: `${root.categoryid},${child.categoryid}`,
        urltitle: 'child-topic',
        filename: 'parent-topic/child-topic',
        lastupdate: NOW_S,
        lastupdateby: 'Admin User',
        isnew: '0',
      });
      expect(await stored(UMBRELLA, child.categoryid)).toEqual({
        tenant_id: UMBRELLA,
        categoryid: child.categoryid,
        siteid: POOL,
        parentid: root.categoryid,
        datecreated: NOW_S,
        lastupdate: NOW_S,
        lastupdateby: 'Admin User',
        name: 'Child Topic',
        notes: null,
        isinterestgroup: 1,
        isactive: 1,
        isopen: 1,
        sortby: 'orderno',
        sortdirection: 'asc',
        restrictgroups: null,
        path: `${root.categoryid},${child.categoryid}`,
        remoteid: null,
        remotesourceurl: null,
        remotepubdate: null,
        urltitle: 'child-topic',
        filename: 'parent-topic/child-topic',
        isfeatureable: 1,
      });
    });

    it('makes a taken filename unique by appending 1, 2, … and takes the URL title from it', async () => {
      const root = await create(A, { siteid: POOL, name: 'Unique Topic' });
      const second = await create(A, { siteid: POOL, name: 'Unique Topic' });
      const third = await create(A, { siteid: POOL, name: 'Unique Topic' });
      const kid = await create(A, { siteid: POOL, name: 'Kid', parentid: root.categoryid });
      const twin = await create(A, { siteid: POOL, name: 'Kid', parentid: root.categoryid });
      expect([second, third].map((bean) => [bean.filename, bean.urltitle])).toEqual([
        ['unique-topic1', 'unique-topic1'],
        ['unique-topic2', 'unique-topic2'],
      ]);
      expect([kid.filename, twin.filename, twin.urltitle]).toEqual(['unique-topic/kid', 'unique-topic/kid1', 'kid1']);
    });

    it('applies input through the categoryBean setters: keys in any case, trimmed text, parsed dates, numeric-only isFeatureable', async () => {
      const bean = await create(A, {
        siteid: ` ${POOL} `,
        NAME: '  Setter Topic  ',
        datecreated: '2026-01-02T03:04:05',
        remotepubdate: '01/02/2026',
        isfeatureable: 'no',
        isopen: 0,
        notes: NOW_S,
        urltitle: 'Custom Title',
        sortby: 'name',
        restrictgroups: null,
        unrelated: 'ignored',
      });
      expect(bean).toMatchObject({
        siteid: POOL,
        name: 'Setter Topic',
        datecreated: new Date(2026, 0, 2, 3, 4, 5),
        remotepubdate: new Date(2026, 0, 2),
        isfeatureable: 1,
        isopen: '0',
        notes: TS_NOW,
        urltitle: 'custom-title',
        filename: 'custom-title',
        sortby: 'name',
        restrictgroups: '',
      });
      expect(await stored(UMBRELLA, bean.categoryid)).toMatchObject({
        datecreated: new Date(2026, 0, 2, 3, 4, 5),
        remotepubdate: new Date(2026, 0, 2),
        isopen: 0,
        isfeatureable: 1,
        notes: TS_NOW,
        sortby: 'name',
        urltitle: 'custom-title',
      });
      await expect(create(A, { siteid: POOL, NOTES: { text: 'x' } })).rejects.toThrow(new TypeError("Category value 'notes' is not a simple value"));
    });

    it('stores a category in the tenant of its siteid: the pool site in umbrella, the token site in its own tenant', async () => {
      const pooled = await create(A, { siteid: POOL, name: 'Pooled Placement' });
      const own = await create(A, { siteid: TENANT_A.siteId, name: 'Own Placement' });
      expect((await stored(UMBRELLA, pooled.categoryid))?.tenant_id).toBe(UMBRELLA);
      expect(await stored(TENANT_A.tenantId, pooled.categoryid)).toBeUndefined();
      expect(await stored(TENANT_A.tenantId, own.categoryid)).toMatchObject({ tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId });
      expect(await stored(UMBRELLA, own.categoryid)).toBeUndefined();
      // Statements legacy scopes to getCategoryPoolID() see the pool tenant only; a read by id also reaches the token's tenant.
      expect((await listPoolCategories(deps, A, { keywords: 'Placement' })).map((row) => row.name)).toEqual(['Pooled Placement']);
      expect(await readCategory(deps, A, own.categoryid)).toMatchObject({ categoryid: own.categoryid, siteid: TENANT_A.siteId, isnew: '0' });
    });

    it('rejects a site that is neither the token site nor its category pool and writes nothing', async () => {
      const parent = await create(A, { siteid: POOL, name: 'Foreign Parent' });
      await expect(create(A, { siteid: TENANT_B.siteId, name: 'Foreign Topic', parentid: parent.categoryid })).rejects.toThrow(
        "Category site tenant-b is neither the token's site nor its category pool",
      );
      expect([await countIn(UMBRELLA, 'Foreign Topic'), await countIn(TENANT_A.tenantId, 'Foreign Topic'), await countIn(TENANT_B.tenantId, 'Foreign Topic')]).toEqual([0, 0, 0]);
    });

    it.each<[string, (who: Actor) => Promise<unknown>]>([
      ['createCategory', (who) => createCategory(deps, who, { siteid: POOL, name: 'Nowhere' })],
      ['listCategories', (who) => listCategories(deps, who)],
      ['restrictGroups', (who) => restrictGroups(deps, who)],
    ])('%s fails for a tenant without a registry entry', async (_label, run) => {
      await expect(run(actor({ tid: UNREGISTERED, site: 'nowhere' }))).rejects.toBeInstanceOf(UnregisteredTenantError);
    });
  });

  describe('updateCategory', () => {
    it('moving to a new parent rewrites the path of the category and its descendants and their filename prefix', async () => {
      const [ma, mb, mc, md] = [1, 2, 3, 4].map((n) => cfId('M', n)) as [string, string, string, string];
      await create(A, { siteid: POOL, categoryid: ma, name: 'Move A' });
      await create(A, { siteid: POOL, categoryid: mb, name: 'Move B', parentid: ma });
      await create(A, { siteid: POOL, categoryid: mc, name: 'Move C', parentid: mb });
      await create(A, { siteid: POOL, categoryid: md, name: 'Move D' });
      expect((await stored(UMBRELLA, mc))?.path).toBe(`${ma},${mb},${mc}`);

      const moved = await updateCategory(deps, A, { categoryid: mb, siteid: POOL, name: 'Move B', parentid: md });
      expect(moved).toMatchObject({ parentid: md, path: `${md},${mb}`, filename: 'move-d/move-b', lastupdate: NOW_S, errors: {} });
      expect(await stored(UMBRELLA, mb)).toMatchObject({ parentid: md, path: `${md},${mb}`, filename: 'move-d/move-b', lastupdate: NOW_S, lastupdateby: 'Admin User' });
      expect(await stored(UMBRELLA, mc)).toMatchObject({ parentid: mb, path: `${md},${mb},${mc}`, filename: 'move-d/move-b/move-c' });
      expect(await stored(UMBRELLA, ma)).toMatchObject({ path: ma, filename: 'move-a' });
    });

    it('a new URL title rewrites the filenames under it and leaves the paths', async () => {
      const [ra, rb] = [1, 2].map((n) => cfId('R', n)) as [string, string];
      await create(A, { siteid: POOL, categoryid: ra, name: 'Rename A' });
      await create(A, { siteid: POOL, categoryid: rb, name: 'Rename B', parentid: ra });
      const renamed = await updateCategory(deps, A, { categoryid: ra, siteid: POOL, name: 'Rename A', urltitle: 'Rename Z' });
      expect(renamed).toMatchObject({ urltitle: 'rename-z', filename: 'rename-z', path: ra });
      expect(await stored(UMBRELLA, rb)).toMatchObject({ filename: 'rename-z/rename-b', path: `${ra},${rb}` });
    });

    it('an update changing neither parent nor URL title stores the values without touching filenames', async () => {
      const [na, nb] = [1, 2].map((n) => cfId('N', n)) as [string, string];
      await create(A, { siteid: POOL, categoryid: na, name: 'Notes A' });
      await create(A, { siteid: POOL, categoryid: nb, name: 'Notes B', parentid: na });
      const { result, changes } = await changesIn(UMBRELLA, () =>
        updateCategory(deps, A, { categoryid: na, siteid: POOL, notes: 'Updated notes', remotepubdate: new Date(2026, 1, 3), datecreated: '02/03/2026' }),
      );
      expect(changes).toEqual(['update category']);
      expect(result.datecreated).toEqual(new Date(2026, 1, 3));
      // categoryDAO.update binds no dateCreated, so the stored creation date stays.
      expect(await stored(UMBRELLA, na)).toMatchObject({
        name: 'Notes A',
        notes: 'Updated notes',
        remotepubdate: new Date(2026, 1, 3),
        datecreated: NOW_S,
        filename: 'notes-a',
      });
      expect((await stored(UMBRELLA, nb))?.filename).toBe('notes-a/notes-b');
    });

    it('re-saves a parent that has no filename before filing a child under it', async () => {
      const bare = cfId('P', 1);
      await inT(UMBRELLA, (tx) =>
        repo.categories.insertCategory(tx, {
          categoryid: bare, siteid: POOL, name: 'Bare Parent', path: bare, isinterestgroup: 1, isactive: 1, isopen: 1, isfeatureable: 1,
          sortby: 'orderno', sortdirection: 'asc',
        }),
      );
      const child = await create(A, { siteid: POOL, name: 'Bare Child', parentid: bare });
      expect(child).toMatchObject({ path: `${bare},${child.categoryid}`, filename: 'bare-parent/bare-child' });
      expect(await stored(UMBRELLA, bare)).toMatchObject({ filename: 'bare-parent', urltitle: 'bare-parent', lastupdate: NOW_S, lastupdateby: 'Admin User' });
    });

    it('returns the validation errors and writes nothing', async () => {
      const valid = await create(A, { siteid: POOL, name: 'Valid Name' });
      const { result, changes } = await changesIn(UMBRELLA, () => updateCategory(deps, A, { categoryid: valid.categoryid, siteid: POOL, name: '' }));
      expect(result.errors).toEqual({ name: "The property named 'name' is not valid" });
      expect(changes).toEqual([]);
      expect((await stored(UMBRELLA, valid.categoryid))?.name).toBe('Valid Name');
    });

    it('an id no category has returns the posted bean and writes nothing', async () => {
      const ghost = cfId('Z', 1);
      const bean = await updateCategory(deps, A, { categoryid: ghost, siteid: POOL, name: 'Ghost' });
      expect(bean).toMatchObject({ categoryid: ghost, name: 'Ghost', isnew: 1 });
      expect(await stored(UMBRELLA, ghost)).toBeUndefined();
      expect(await countIn(UMBRELLA, 'Ghost')).toBe(0);
    });

    it('fails on a parent chain that returns to itself and writes nothing', async () => {
      const [x, y] = [1, 2].map((n) => cfId('X', n)) as [string, string];
      await inT(UMBRELLA, async (tx) => {
        await repo.categories.insertCategory(tx, { categoryid: x, siteid: POOL, name: 'Loop X', parentid: y });
        await repo.categories.insertCategory(tx, { categoryid: y, siteid: POOL, name: 'Loop Y', parentid: x });
      });
      await expect(create(A, { siteid: POOL, name: 'Loop Child', parentid: x })).rejects.toThrow(`Category ${x} is its own ancestor`);
      expect(await countIn(UMBRELLA, 'Loop Child')).toBe(0);
    });
  });

  describe('deleteCategory', () => {
    it('rewrites descendant paths, throws the category into the trash, then reparents its children and deletes it', async () => {
      const [dp, dq, dr] = [1, 2, 3].map((n) => cfId('D', n)) as [string, string, string];
      await create(A, { siteid: POOL, categoryid: dp, name: 'Delete P' });
      await create(A, { siteid: POOL, categoryid: dq, name: 'Delete Q', parentid: dp });
      await create(A, { siteid: POOL, categoryid: dr, name: 'Delete R', parentid: dq });

      const { result, changes } = await changesIn(UMBRELLA, () => deleteCategory(deps, A, dq));
      expect(changes).toEqual(['update category', 'update category', 'insert trash', 'update category', 'delete category']);
      expect(result.bean).toMatchObject({ categoryid: dq, name: 'Delete Q', parentid: dp });
      expect(result.trash).toMatchObject({
        tenant_id: UMBRELLA,
        objectid: dq,
        parentid: dp,
        siteid: POOL,
        objectclass: 'category',
        objectlabel: 'Delete Q',
        objecttype: 'category',
        objectsubtype: 'Default',
        deleteddate: NOW_S,
        deletedby: 'Admin User',
        orderno: 1,
      });
      const trashed = await trashOf(UMBRELLA, dq);
      const values = wddx2cfml(trashed?.objectstring ?? '') as WddxStruct;
      expect([wddxStructGet(values, 'categoryID'), wddxStructGet(values, 'name'), wddxStructGet(values, 'muraDeleteID')]).toEqual([dq, 'Delete Q', trashed?.deleteid]);
      expect(await stored(UMBRELLA, dq)).toBeUndefined();
      expect(await stored(UMBRELLA, dr)).toMatchObject({ parentid: dp, path: `${dp},${dr}` });
      expect(await stored(UMBRELLA, dp)).toMatchObject({ parentid: null, path: dp });
    });
  });

  describe('reads', () => {
    const [ALPHA, BETA, GAMMA] = [1, 2, 3].map((n) => cfId('B', n)) as [string, string, string];
    const [C1, C2, H1, H2] = [cfId('C', 1), cfId('C', 2), cfId('H', 1), cfId('H', 2)];

    beforeAll(async () => {
      await create(B, { siteid: TENANT_B.siteId, categoryid: ALPHA, name: 'Alpha', isinterestgroup: 0, isactive: 1, remoteid: 'R-ALPHA' });
      await create(B, { siteid: TENANT_B.siteId, categoryid: BETA, name: 'beta', isinterestgroup: 1, isactive: 0 });
      await create(B, { siteid: TENANT_B.siteId, categoryid: GAMMA, name: 'Gamma', parentid: ALPHA, remoteid: 'R-1' });
      await inT(TENANT_B.tenantId, async (tx) => {
        for (const [contentid, contenthistid, title] of [[C1, H1, 'First'], [C2, H2, 'Second']] as const) {
          await repo.content.insertVersion(tx, {
            contentid, contenthistid, title, siteid: TENANT_B.siteId, type: 'Page', subtype: 'Default', moduleid: SITE_MANAGER, active: 1, approved: 1, display: 1,
          });
        }
        await repo.categories.setAssignment(tx, { categoryId: ALPHA, contentId: C1, contentHistId: H1, isFeature: 1, orderNo: 2, siteId: TENANT_B.siteId });
        await repo.categories.setAssignment(tx, {
          categoryId: ALPHA, contentId: C2, contentHistId: H2, isFeature: 2, orderNo: 1, siteId: TENANT_B.siteId,
          featureStart: new Date(2027, 0, 1), featureStop: null,
        });
      });
    });

    it('a site that is its own category pool keeps its categories in its own tenant', async () => {
      expect((await stored(TENANT_B.tenantId, ALPHA))?.tenant_id).toBe(TENANT_B.tenantId);
      expect(await stored(UMBRELLA, ALPHA)).toBeUndefined();
      expect((await stored(TENANT_B.tenantId, GAMMA))?.path).toBe(`${ALPHA},${GAMMA}`);
    });

    it.each<[string, ListCategoriesOptions, Array<[string, number]>]>([
      ['the top level by name with child counts', {}, [['Alpha', 1], ['beta', 0]]],
      ['the children of a parent', { parentId: ALPHA }, [['Gamma', 0]]],
      ['active categories only', { activeOnly: true }, [['Alpha', 1]]],
      ['interest groups only', { interestsOnly: true }, [['beta', 0]]],
      ['names containing the keywords, any case', { keywords: 'ET' }, [['beta', 0]]],
    ])('listCategories: %s', async (_label, args, expected) => {
      expect((await listCategories(deps, B, args)).map((row) => [row.name, row.haskids])).toEqual(expected);
    });

    it.each<[string, { keywords?: string; interestOnly?: boolean }, string[]]>([
      ['every pool category by name', {}, ['Alpha', 'beta', 'Gamma']],
      ['interest groups only', { interestOnly: true }, ['beta', 'Gamma']],
      ['names containing the keywords', { keywords: 'GAM' }, ['Gamma']],
      ['interest groups containing the keywords', { interestOnly: true, keywords: 'a' }, ['beta', 'Gamma']],
    ])('listPoolCategories: %s', async (_label, args, expected) => {
      expect((await listPoolCategories(deps, B, args)).map((row) => row.name)).toEqual(expected);
    });

    it.each<[string, { activeOnly?: boolean; interestOnly?: boolean }, number]>([
      ['every category', {}, 3],
      ['active categories', { activeOnly: true }, 2],
      ['interest groups', { interestOnly: true }, 2],
      ['active interest groups', { interestOnly: true, activeOnly: true }, 1],
    ])('countCategories: %s', async (_label, args, expected) => {
      expect(await countCategories(deps, B, args)).toBe(expected);
    });

    it.each<[string, string | undefined, string[]]>([
      ['root first by default', undefined, [ALPHA, GAMMA]],
      ['root first for asc', 'asc', [ALPHA, GAMMA]],
      ['deepest first for DESC', 'DESC', [GAMMA, ALPHA]],
    ])('categoryCrumbs: %s', async (_label, sort, expected) => {
      const args = sort === undefined ? { path: `${ALPHA},${GAMMA}` } : { path: `${ALPHA},${GAMMA}`, sort };
      expect((await categoryCrumbs(deps, B, args)).map((row) => row.categoryid)).toEqual(expected);
    });

    it.each<[string, CategoryReadKey, string]>([
      ['by name, any case', { name: 'ALPHA' }, ALPHA],
      ['by remote id', { remoteId: 'R-1' }, GAMMA],
      ['by filename, one leading and trailing slash trimmed', { filename: '/alpha/gamma/' }, GAMMA],
      ['by URL title', { urlTitle: 'beta' }, BETA],
      ['by name before remote id', { name: 'beta', remoteId: 'R-1' }, BETA],
      ['by id before any readBy key', { categoryId: GAMMA, name: 'Alpha' }, GAMMA],
    ])('readCategory %s', async (_label, key, expected) => {
      expect(await readCategory(deps, B, key)).toMatchObject({ categoryid: expected, siteid: TENANT_B.siteId, isnew: '0' });
    });

    it.each<[string, CategoryReadKey | string, string]>([
      ['a name no category has takes the token site', { name: 'Nobody' }, TENANT_B.siteId],
      ['a name no category has takes the given site', { name: 'Nobody', siteId: 'elsewhere' }, 'elsewhere'],
      ['no key reads the empty id', {}, ''],
      ['an id no category has', cfId('Z', 9), ''],
    ])('readCategory returns a new bean for %s', async (_label, key, siteid) => {
      expect(await readCategory(deps, B, key as CategoryReadKey)).toMatchObject({ categoryid: '', siteid, isnew: 1 });
    });

    it('readCategory by a name several pool categories share returns one bean each', async () => {
      const first = await create(A, { siteid: POOL, name: 'Twin Topic' });
      const second = await create(A, { siteid: POOL, name: 'Twin Topic' });
      const beans = await readCategory(deps, A, { name: 'twin topic' });
      expect(Array.isArray(beans)).toBe(true);
      expect((beans as CategoryBean[]).map((bean) => [bean.categoryid, bean.isnew])).toEqual(
        [first.categoryid, second.categoryid].sort().map((id) => [id, '0']),
      );
    });

    it('categoryFeatures lists the featured content of the token tenant in the bean sort, live ones only with live', async () => {
      expect((await categoryFeatures(deps, B, ALPHA)).map((row) => [row.contentid, row.orderno, row.isfeature])).toEqual([[C2, 1, 2], [C1, 2, 1]]);
      expect((await categoryFeatures(deps, B, ALPHA, { live: true })).map((row) => row.title)).toEqual(['First']);
    });
  });

  describe('restrictGroups and updateCategoryAction', () => {
    const G = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => cfId('G', n)) as [string, string, string, string, string, string, string, string, string];
    const [members, publicAdmin, zeta, gone, umbrellaPrivate, editors, privateAdmin, authors, publicInA] = G;
    const RESTRICT_GROUPS: RestrictGroupRow[] = [
      { groupname: 'Members', userid: members, ispublic: 1 },
      { groupname: 'zeta', userid: zeta, ispublic: 1 },
      { groupname: 'authors', userid: authors, ispublic: 0 },
      { groupname: 'Editors', userid: editors, ispublic: 0 },
    ];

    beforeAll(async () => {
      const group = (groupId: string, siteId: string, groupName: string, isPublic: number, deleted = false) => ({ groupId, siteId, groupName, isPublic, deleted });
      await inT(UMBRELLA, async (tx) => {
        for (const row of [
          group(members, POOL, 'Members', 1),
          group(publicAdmin, POOL, 'Admin', 1),
          group(zeta, POOL, 'zeta', 1),
          group(gone, POOL, 'Gone', 1, true),
          group(umbrellaPrivate, POOL, 'Umbrella Private', 0),
        ]) {
          await repo.projections.upsertGroupProjection(tx, row);
        }
      });
      await inT(TENANT_A.tenantId, async (tx) => {
        for (const row of [
          group(editors, TENANT_A.siteId, 'Editors', 0),
          group(privateAdmin, TENANT_A.siteId, 'Admin', 0),
          group(authors, TENANT_A.siteId, 'authors', 0),
          group(publicInA, TENANT_A.siteId, 'Public In A', 1),
        ]) {
          await repo.projections.upsertGroupProjection(tx, row);
        }
      });
    });

    it('restrictGroups lists live public-pool then private-pool groups by name, Admin excepted', async () => {
      expect(await restrictGroups(deps, A)).toEqual(RESTRICT_GROUPS);
    });

    it('add, update and delete redirect to cCategory.list with siteid after writing', async () => {
      expect(await updateCategoryAction(deps, A, { action: 'add', siteid: POOL, categoryid: '', name: 'Action Added' })).toEqual(LIST_REDIRECT);
      const [added] = (await listPoolCategories(deps, A, { keywords: 'Action Added' })).map((row) => row.categoryid);
      expect(added).toBeDefined();
      const id = added ?? '';

      expect(await updateCategoryAction(deps, A, { action: 'Update', siteid: POOL, categoryid: id, name: 'Action Renamed' })).toEqual(LIST_REDIRECT);
      expect((await stored(UMBRELLA, id))?.name).toBe('Action Renamed');

      expect(await updateCategoryAction(deps, A, { action: 'delete', siteid: POOL, categoryid: id })).toEqual(LIST_REDIRECT);
      expect(await stored(UMBRELLA, id)).toBeUndefined();
      expect((await trashOf(UMBRELLA, id))?.objectclass).toBe('category');
    });

    it.each<[string, (id: string) => CategoryInput]>([
      ['an add without a name', () => ({ action: 'add', siteid: POOL, categoryid: '', name: '' })],
      ['an update without a name', (id) => ({ action: 'update', siteid: POOL, categoryid: id, name: '' })],
    ])('%s re-renders the form with the errors and the restrict groups and writes nothing', async (_label, rc) => {
      const kept = await create(A, { siteid: POOL, name: 'Action Kept' });
      const { result, changes } = await changesIn(UMBRELLA, () => updateCategoryAction(deps, A, rc(kept.categoryid)));
      expect(result).toMatchObject({ kind: 'rerender', bean: { errors: { name: "The property named 'name' is not valid" } }, rsRestrictGroups: RESTRICT_GROUPS });
      expect(changes).toEqual([]);
      expect((await stored(UMBRELLA, kept.categoryid))?.name).toBe('Action Kept');
    });

    it('a rejected token skips the delete and still redirects', async () => {
      const kept = await create(A, { siteid: POOL, name: 'Token Kept' });
      expect(await updateCategoryAction(deps, A, { action: 'delete', siteid: POOL, categoryid: kept.categoryid }, { csrfValid: false })).toEqual(LIST_REDIRECT);
      expect((await stored(UMBRELLA, kept.categoryid))?.name).toBe('Token Kept');
    });

    it.each<[string, CategoryInput, CategoryActionOptions, string]>([
      ['a rejected token on add', { action: 'add', siteid: POOL, name: 'Token Add' }, { csrfValid: false }, 'Element CATEGORYBEAN is undefined in ARGUMENTS.RC.'],
      ['an unknown action', { action: 'publish', siteid: POOL, name: 'Unknown' }, {}, 'Element CATEGORYBEAN is undefined in ARGUMENTS.RC.'],
      ['a missing action', { siteid: POOL, name: 'No Action' }, {}, 'Element ACTION is undefined in RC.'],
      ['a delete without a category id', { action: 'delete', siteid: POOL }, {}, 'Element CATEGORYID is undefined in RC.'],
    ])('updateCategoryAction fails on %s as legacy dereferences the missing value', async (_label, rc, opts, message) => {
      await expect(updateCategoryAction(deps, A, rc, opts)).rejects.toThrow(message);
      expect(await countIn(UMBRELLA, String(rc.name ?? ''))).toBe(0);
    });
  });

  describe('list order and content assignments', () => {
    const K = cfId('K', 1);
    const [C1, C2, C3] = [1, 2, 3].map((n) => cfId('C', 10 + n)) as [string, string, string];
    const [H1, H2, H4, H5] = [1, 2, 4, 5].map((n) => cfId('H', 10 + n)) as [string, string, string, string];
    const [Q1, Q2, Q3, Q4, Q5, Q6] = [1, 2, 3, 4, 5, 6].map((n) => cfId('Q', n)) as [string, string, string, string, string, string];
    const trim = (id: string): string => id.replaceAll('-', '');
    const KEPT_START = new Date(2026, 0, 1, 8, 0);
    const KEPT_STOP = new Date(2026, 11, 31, 8, 0);

    const orderOf = (): Promise<Array<[string, number | null]>> =>
      inT(TENANT_A.tenantId, async (tx) =>
        (await tx.query<{ contentid: string; orderno: number | null }>(
          `SELECT contentid, orderno FROM ${handle.schema}.content_category_assign WHERE categoryid = $1 ORDER BY contentid`,
          [K],
        )).rows.map((row): [string, number | null] => [row.contentid, row.orderno]),
      );

    beforeAll(async () => {
      await create(A, { siteid: POOL, categoryid: K, name: 'Ordered' });
      await inT(TENANT_A.tenantId, async (tx) => {
        for (const [contentId, contentHistId] of [[C1, H1], [C2, H2]] as const) {
          await repo.categories.setAssignment(tx, { categoryId: K, contentId, contentHistId, isFeature: 1, orderNo: 0, siteId: TENANT_A.siteId });
        }
      });
    });

    it('setListOrder writes each listed item its orderno, in list order, in the content-pool tenants', async () => {
      const rows = await setListOrder(deps, A, { categoryId: K, orderId: `${C2},${C1}`, orderno: '1,2', siteId: TENANT_A.siteId });
      expect(rows.map((row) => [row.contentid, row.orderno])).toEqual([[C2, 1], [C1, 2]]);
      expect(await orderOf()).toEqual([[C1, 2], [C2, 1]]);
      await expect(setListOrder(deps, A, { categoryId: K, orderId: `${C1},${C2}`, orderno: '9', siteId: TENANT_A.siteId })).rejects.toThrow('Invalid list index 2.');
    });

    it('an update or save of an existing category applies the posted list order; a create and a failed validation do not', async () => {
      await updateCategory(deps, A, { categoryid: K, siteid: POOL, name: 'Ordered', orderid: `${C1},${C2}`, orderno: '5,6' });
      expect(await orderOf()).toEqual([[C1, 5], [C2, 6]]);

      const invalid = await updateCategory(deps, A, { categoryid: K, siteid: POOL, name: '', orderid: C1, orderno: '9' });
      expect(Object.keys(invalid.errors)).toEqual(['name']);
      const fresh = await saveCategory(deps, A, { categoryid: cfId('S', 1), siteid: POOL, name: 'Saved New', orderid: C1, orderno: '7' });
      expect(fresh).toMatchObject({ categoryid: cfId('S', 1), isnew: '0' });
      expect((await stored(UMBRELLA, cfId('S', 1)))?.name).toBe('Saved New');
      expect(await orderOf()).toEqual([[C1, 5], [C2, 6]]);

      const saved = await saveCategory(deps, A, { categoryid: K, siteid: POOL, name: 'Ordered Again', orderid: C1, orderno: '8' });
      expect(saved.name).toBe('Ordered Again');
      expect((await stored(UMBRELLA, K))?.name).toBe('Ordered Again');
      expect(await orderOf()).toEqual([[C1, 8], [C2, 6]]);
    });

    it.each<[string, () => Promise<unknown>, string]>([
      ['a save without categoryID', () => saveCategory(deps, A, { siteid: POOL, name: 'No Id' }), "The attribute 'CATEGORYID' is required when saving a category."],
      ['an orderID without orderno', () => updateCategory(deps, A, { categoryid: K, siteid: POOL, name: 'Ordered Again', orderid: C1 }), 'Element ORDERNO is undefined in ARGUMENTS.DATA.'],
    ])('fails on %s', async (_label, run, message) => {
      await expect(run()).rejects.toThrow(message);
    });

    it('setCategoryAssignments assigns listed non-empty keys, schedules isFeature 2 and keeps current rows whose key is absent', async () => {
      const current: CategoryAssignmentInput[] = [
        { categoryid: Q4, contentid: C3, siteid: TENANT_A.siteId, orderno: 3, isfeature: 2, featurestart: KEPT_START, featurestop: KEPT_STOP },
        { categoryid: Q5, contentid: C3, siteid: TENANT_A.siteId, orderno: 1, isfeature: 1 },
      ];
      const data: Record<string, unknown> = {
        categoryID: [Q1, Q2, Q3, Q6].join(','),
        [`categoryAssign${trim(Q1)}`]: '1',
        [`categoryAssign${trim(Q2)}`]: '2',
        [`featureStart${trim(Q2)}`]: '2026-07-01',
        [`startHour${trim(Q2)}`]: '1',
        [`startMinute${trim(Q2)}`]: '30',
        [`startDayPart${trim(Q2)}`]: 'PM',
        [`featureStop${trim(Q2)}`]: '2026-07-31',
        [`stopHour${trim(Q2)}`]: '12',
        [`stopMinute${trim(Q2)}`]: '0',
        [`stopDayPart${trim(Q2)}`]: 'AM',
        [`categoryAssign${trim(Q3)}`]: '',
        [`categoryAssign${trim(Q5)}`]: '1',
        [`CATEGORYASSIGN${trim(Q6)}`]: '2',
        [`featureStart${trim(Q6)}`]: 'not a date',
        [`startHour${trim(Q6)}`]: '1',
        [`startMinute${trim(Q6)}`]: '0',
        [`featureStop${trim(Q6)}`]: '',
        [`stopHour${trim(Q6)}`]: '1',
        [`stopMinute${trim(Q6)}`]: '0',
      };
      const written = await inT(TENANT_A.tenantId, (tx) =>
        setCategoryAssignments(tx, repo, {
          data,
          contentId: C3,
          contentHistId: H4,
          siteId: TENANT_A.siteId,
          poolCategories: [Q1, Q2, Q3, Q4, Q5, Q6].map((categoryid) => ({ categoryid })),
          current,
        }),
      );
      expect(written.map((row) => row.categoryid)).toEqual([Q1, Q2, Q4, Q6]);
      const row = (categoryid: string, extra: Partial<CategoryAssignRow> = {}): CategoryAssignRow => ({
        tenant_id: TENANT_A.tenantId,
        contenthistid: H4,
        categoryid,
        contentid: C3,
        siteid: TENANT_A.siteId,
        orderno: 0,
        isfeature: 1,
        featurestart: null,
        featurestop: null,
        ...extra,
      });
      expect(await assignmentsOf(TENANT_A.tenantId, H4)).toEqual([
        row(Q1),
        row(Q2, { isfeature: 2, featurestart: new Date(2026, 6, 1, 13, 30), featurestop: new Date(2026, 6, 31, 0, 0) }),
        row(Q4, { orderno: 3, isfeature: 2, featurestart: KEPT_START, featurestop: KEPT_STOP }),
        row(Q6),
      ]);
    });

    it.each<[string, Record<string, unknown>, RegExp]>([
      ['a non-numeric feature flag', { categoryID: Q1, [`categoryAssign${trim(Q1)}`]: 'yes' }, /^The ISFEATURE argument passed to the setAssignment function is not of type numeric\.$/],
      ['a scheduled feature without its start fields', { categoryID: Q1, [`categoryAssign${trim(Q1)}`]: '2' }, /^Element FEATURESTART\w+ is undefined in ARGUMENTS\.DATA\.$/],
      [
        'a start hour past 23',
        {
          categoryID: Q1,
          [`categoryAssign${trim(Q1)}`]: '2',
          [`featureStart${trim(Q1)}`]: '2026-07-01',
          [`startHour${trim(Q1)}`]: '25',
          [`startMinute${trim(Q1)}`]: '0',
          [`featureStop${trim(Q1)}`]: '',
          [`stopHour${trim(Q1)}`]: '',
          [`stopMinute${trim(Q1)}`]: '',
        },
        /^Invalid time 25:0 for createDateTime\.$/,
      ],
    ])('setCategoryAssignments fails on %s and writes nothing', async (_label, data, message) => {
      const contentHistId = cfId('H', 99);
      await expect(
        inT(TENANT_A.tenantId, (tx) =>
          setCategoryAssignments(tx, repo, { data, contentId: C3, contentHistId, siteId: TENANT_A.siteId, poolCategories: [{ categoryid: Q1 }], current: [] }),
        ),
      ).rejects.toThrow(message);
      expect(await assignmentsOf(TENANT_A.tenantId, contentHistId)).toEqual([]);
    });

    it('keepCategories copies the kept rows onto the version, keeping feature dates only for isFeature 2', async () => {
      const kept = await inT(TENANT_A.tenantId, (tx) =>
        keepCategories(tx, repo, H5, [
          { categoryid: Q1, contentid: C3, siteid: TENANT_A.siteId, orderno: 4, isfeature: 1, featurestart: KEPT_START, featurestop: KEPT_STOP },
          { categoryid: Q2, contentid: C3, siteid: TENANT_A.siteId, orderno: 5, isfeature: 2, featurestart: KEPT_START },
        ]),
      );
      expect(kept).toHaveLength(2);
      expect((await assignmentsOf(TENANT_A.tenantId, H5)).map((row) => [row.categoryid, row.orderno, row.isfeature, row.featurestart, row.featurestop])).toEqual([
        [Q1, 4, 1, null, null],
        [Q2, 5, 2, KEPT_START, null],
      ]);
    });
  });
});
