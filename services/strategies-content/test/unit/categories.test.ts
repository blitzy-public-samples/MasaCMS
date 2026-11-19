/** Categories over the recording pool: domain/categories, the ccategory admin route and the JSON API category reads, pooled rows in the registry's category pool tenant. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type TenantFixture } from '@opt2/platform/testing';
import {
  categoryAccess,
  createCategory,
  deleteCategory,
  keepCategories,
  listCategories,
  listPoolCategories,
  setCategoryAssignments,
  setListOrder,
  updateCategory,
  updateCategoryAction,
  type CategoryDeps,
} from '../../src/domain/categories.js';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import { UnregisteredTenantError } from '../../src/domain/pools.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, userHeaders, type RecordedStatement, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, categoryAssignRow, categoryRow, contentSeed, seedRecordingDb } from '../helpers/seed.js';
import { SUBJECT_USER_IDS, contentHeaders } from '../helpers/tokens.js';

type Row = Record<string, unknown>;
type Claims = NonNullable<Parameters<typeof actorFromClaims>[0]>;

const CATEGORY_TABLE = 'category';
const ASSIGN_TABLE = 'content_category_assign';
const POOL = TENANT_UMBRELLA.siteId;
const UMBRELLA = TENANT_UMBRELLA.tenantId;
const { pooledParent, pooledChild, bOwn } = IDS.categories;
const GRANDCHILD = 'A7000000-0000-0000-0000000000000003';
const NEW_PARENT = 'A7000000-0000-0000-0000000000000004';
const CONTENT_ONE = 'A1000000-0000-0000-0000000000000003';
const CONTENT_TWO = 'A1000000-0000-0000-0000000000000004';
const HIST_OLD = 'A2000000-0000-0000-0000000000000005';
const HIST_NEW = 'A2000000-0000-0000-0000000000000099';
const NAME_ERROR = { name: "The property named 'name' is not valid" };
const LIST_REDIRECT = { kind: 'redirect', action: 'cCategory.list', append: ['siteid'] };
const CATEGORIES_URL = '/v1/sites/tenant-a/categories';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const CSRF = { csrf_token: 'TOKEN', csrf_token_expires: '260630130000000' } as const;
const m = (digits: string): string => `m:${digits}`;

function actor(tenant: Pick<TenantFixture, 'siteId' | 'tenantId'>, roles: readonly string[] = ['site-admin']): Actor {
  const claims: Claims = {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: SUBJECT_USER_IDS['site-admin'],
    sid: 'categories-session',
    tid: tenant.tenantId,
    site: tenant.siteId,
    roles: [...roles],
    s2: false,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
  return actorFromClaims(claims, 'Admin User');
}

/** tenant-a's site Admin: category pool `umbrella`, content pool `tenant-a`. */
const A = actor(TENANT_A);
/** tenant-b's site Admin: every pool its own site. */
const B = actor(TENANT_B);

// ---- in-memory tables answering the repository's statements on the recording pool ----

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
/** SQL Server equality: case-insensitive, trailing spaces ignored. */
const sqlEq = (a: unknown, b: unknown): boolean => text(a).replace(/ +$/u, '').toLowerCase() === text(b).replace(/ +$/u, '').toLowerCase();
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `clause` split at ` AND ` outside parentheses and quotes. */
function conjuncts(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < clause.length; i += 1) {
    const ch = clause.charAt(i);
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && clause.startsWith(' AND ', i)) {
      parts.push(clause.slice(start, i));
      start = i + 5;
    }
  }
  parts.push(clause.slice(start));
  return parts.map((part) => part.trim());
}

/** Whether `term` is one parenthesised expression. */
function wrapped(term: string): boolean {
  if (!term.startsWith('(')) return false;
  let depth = 0;
  for (let i = 0; i < term.length; i += 1) {
    if (term.charAt(i) === '(') depth += 1;
    if (term.charAt(i) === ')') depth -= 1;
    if (depth === 0) return i === term.length - 1;
  }
  return false;
}

/** The row test of one WHERE term the category repository emits; RLS has already narrowed the rows to the tenant. */
function termTest(term: string, params: readonly unknown[]): (row: Row) => boolean {
  const param = (n: string | undefined): unknown => params[Number(n) - 1];
  const not = /^NOT \((.+)\)$/.exec(term);
  if (not?.[1] !== undefined) {
    const inner = whereTest(not[1], params);
    return (row) => !inner(row);
  }
  if (wrapped(term)) return whereTest(term.slice(1, -1), params);
  let match = /^(?:\w+\.)?"?(\w+)"? = ANY\(\$(\d+)::(?:bpchar|text)\[\]\)$/.exec(term);
  if (match?.[1] !== undefined) {
    const [, column, n] = match;
    const listed = param(n) as readonly unknown[];
    return (row) => listed.some((value) => sqlEq(row[column], value));
  }
  match = /^upper\((?:\w+\.)?(\w+)\) LIKE upper\(\$(\d+)::text\) ESCAPE ''$/.exec(term);
  if (match?.[1] !== undefined) {
    const [, column, n] = match;
    const like = new RegExp(`^${text(param(n)).split('%').map(escapeRegExp).join('[^]*')}$`, 'iu');
    return (row) => row[column] !== null && like.test(text(row[column]));
  }
  match = /^lower\(rtrim\((?:\w+\.)?(\w+)\)\) = lower\(rtrim\(\$(\d+)::text\)\)$/.exec(term);
  if (match?.[1] !== undefined) {
    const [, column, n] = match;
    return (row) => row[column] !== null && sqlEq(row[column], param(n));
  }
  match = /^(?:\w+\.)?"?(\w+)"? IS NULL$/.exec(term);
  if (match?.[1] !== undefined) {
    const [, column] = match;
    return (row) => row[column] === null || row[column] === undefined;
  }
  match = /^(?:\w+\.)?"?(\w+)"? = \$(\d+)$/.exec(term);
  if (match?.[1] !== undefined) {
    const [, column, n] = match;
    return column === 'tenant_id' ? () => true : (row) => sqlEq(row[column], param(n));
  }
  match = /^(?:\w+\.)?(\w+) = (\d+)$/.exec(term);
  if (match?.[1] !== undefined) {
    const [, column, value] = match;
    return (row) => Number(row[column]) === Number(value);
  }
  throw new Error(`in-memory table: unhandled predicate ${term}`);
}

/** The row test of a WHERE clause: every top-level conjunct holds. */
function whereTest(clause: string, params: readonly unknown[]): (row: Row) => boolean {
  const tests = conjuncts(clause).map((term) => termTest(term, params));
  return (row) => tests.every((test) => test(row));
}

/** The WHERE clause of `sql`, cut before its GROUP BY, ORDER BY, LIMIT, FOR UPDATE or RETURNING. */
function whereOf(sql: string): string {
  const after = sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
  const ends = [' GROUP BY ', ' ORDER BY ', ' LIMIT ', ' FOR UPDATE', ' RETURNING '].map((marker) => after.indexOf(marker)).filter((at) => at >= 0);
  return after.slice(0, Math.min(after.length, ...ends));
}

/** The row an `INSERT INTO t (cols) VALUES ($1, …)` statement binds, keyed by unquoted column. */
function insertedRow(statement: Pick<RecordedStatement, 'sql' | 'params'>): Row {
  const columns = /^INSERT INTO \S+ \(([^)]*)\) VALUES/.exec(statement.sql)?.[1];
  if (columns === undefined) throw new Error(`not a single-row insert: ${statement.sql}`);
  return Object.fromEntries(columns.split(', ').map((column, i) => [column.replace(/"/g, ''), statement.params[i] ?? null]));
}

/** Rows of one `content.<table>` per tenant. */
type TableRows = Map<string, Row[]>;

/** Answers every statement on `content.<table>` from rows held per tenant, so reads, locks, updates and deletes see earlier writes. */
function installTable(db: RecordingDb, table: string, key: readonly string[], seed: readonly Row[]): TableRows {
  const store: TableRows = new Map();
  for (const row of seed) {
    const tenantRows = store.get(text(row.tenant_id)) ?? [];
    tenantRows.push({ ...row });
    store.set(text(row.tenant_id), tenantRows);
  }
  const tenantRows = (tenantId: string | null): Row[] => {
    const rows = store.get(text(tenantId)) ?? [];
    store.set(text(tenantId), rows);
    return rows;
  };
  const byKey = (a: Row, b: Row): number => key.map((column) => text(a[column])).join('/').localeCompare(key.map((column) => text(b[column])).join('/'));
  const byName = (a: Row, b: Row): number => text(a.name).toLowerCase().localeCompare(text(b.name).toLowerCase()) || byKey(a, b);
  /** A category tree walk over `site`'s rows from the top level, each level by name; `withKids` descends only rows with children. */
  const walked = (rows: readonly Row[], site: readonly Row[], withKids: boolean): Row[] => {
    const out: Row[] = [];
    const visit = (parent: Row | null, depth: number): void => {
      const level = site.filter((row) => (parent === null ? row.parentid === null : row.parentid !== null && sqlEq(row.parentid, parent.categoryid)));
      for (const row of level.sort(byName)) {
        const haskids = rows.filter((kid) => kid.parentid !== null && sqlEq(kid.parentid, row.categoryid)).length;
        out.push({ ...row, haskids, depth, cycle: null });
        if (!withKids || haskids > 0) visit(row, depth + 1);
      }
    };
    visit(null, 0);
    return out;
  };
  db.respond(new RegExp(`^(?:SELECT|INSERT|UPDATE|DELETE|WITH RECURSIVE)\\b.*"content"\\."${table}"(?: |$)`), (params, sql, ctx) => {
    const rows = tenantRows(ctx.tenantId);
    if (sql.startsWith('WITH RECURSIVE tree AS ')) return walked(rows, rows.filter((row) => sqlEq(row.siteid, params[1])), sql.includes(' AND w.haskids > 0)'));
    if (sql.startsWith('INSERT ')) {
      const row = insertedRow({ sql, params });
      rows.push(row);
      return [{ ...row }];
    }
    const matches = rows.filter(whereTest(whereOf(sql), params));
    if (sql.startsWith('UPDATE ')) {
      const set = /^UPDATE \S+ SET (.+?) WHERE /.exec(sql)?.[1] ?? '';
      const patch = Object.fromEntries([...set.matchAll(/"(\w+)" = \$(\d+)/g)].map(([, column, n]) => [column, params[Number(n) - 1]]));
      return matches.map((row) => ({ ...Object.assign(row, patch) }));
    }
    if (sql.startsWith('DELETE ')) {
      for (const row of matches) rows.splice(rows.indexOf(row), 1);
      return matches.map((row) => ({ ...row }));
    }
    if (/^SELECT count\(\*\)::integer AS thecount /.test(sql)) return [{ thecount: matches.length }];
    const counted = /count\(k\.parentid\)/.test(sql)
      ? matches.map((row) => ({ ...row, haskids: rows.filter((kid) => kid.parentid !== null && sqlEq(kid.parentid, row.categoryid)).length }))
      : matches.map((row) => ({ ...row }));
    const ordered = counted.sort(/ORDER BY lower\((?:c\.)?name\)/.test(sql) ? byName : byKey);
    return / LIMIT 1$/.test(sql) ? ordered.slice(0, 1) : ordered;
  });
  return store;
}

/** The seeded `content.category` rows: umbrella's Topics > News and tenant-b's own B Topics. */
function seededCategories(): Row[] {
  return contentSeed()
    .flatMap((seed) => seed.rows)
    .filter(({ table }) => table.table === CATEGORY_TABLE)
    .map(({ row }) => ({ ...row }));
}

/** Write statements on `content.<table>`. */
function tableWrites(db: RecordingDb, table: string): RecordedStatement[] {
  return db.writes().filter((statement) => statement.sql.includes(`"content"."${table}"`));
}

/** Tenants of `statements`, each once. */
const tenantsOf = (statements: readonly RecordedStatement[]): Array<string | null> => [...new Set(statements.map((statement) => statement.tenantId))];

/** umbrella's further categories: Briefs under News, and Archive, a top-level category that is no interest group. */
function poolExtras(): Row[] {
  return [
    categoryRow({
      tenant_id: UMBRELLA,
      siteid: POOL,
      categoryid: GRANDCHILD,
      parentid: pooledChild,
      path: `${pooledParent},${pooledChild},${GRANDCHILD}`,
      name: 'Briefs',
      urltitle: 'briefs',
      filename: 'topics/news/briefs',
    }),
    categoryRow({ tenant_id: UMBRELLA, siteid: POOL, categoryid: NEW_PARENT, name: 'Archive', urltitle: 'archive', filename: 'archive', isinterestgroup: 0 }),
  ];
}

interface Harness {
  db: RecordingDb;
  deps: CategoryDeps;
  categories: TableRows;
  assignments: TableRows;
}

/** The recording pool with the content seed, umbrella's tree Archive | Topics > News > Briefs, tenant-b's B Topics, and `assignments`. */
function harness(opts: { db?: RecordingDb; assignments?: readonly Row[] } = {}): Harness {
  const db = opts.db ?? createRecordingDb();
  seedRecordingDb(db);
  return {
    db,
    deps: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK },
    categories: installTable(db, CATEGORY_TABLE, ['categoryid'], [...seededCategories(), ...poolExtras()]),
    assignments: installTable(db, ASSIGN_TABLE, ['contenthistid', 'categoryid'], opts.assignments ?? []),
  };
}

/** The stored category `categoryId` of `tenantId`. */
function storedCategory(h: Harness, tenantId: string, categoryId: string): Row | undefined {
  return h.categories.get(tenantId)?.find((row) => sqlEq(row.categoryid, categoryId));
}

/** Statements reading `content.category`. */
const categoryReads = (db: RecordingDb): RecordedStatement[] =>
  db.statements.filter((statement) => statement.sql.startsWith('SELECT') && statement.sql.includes(`"content"."${CATEGORY_TABLE}"`));

describe('createCategory', () => {
  it.each([
    { label: 'tenant-a under a pooled parent', who: A, siteid: POOL, parentid: pooledParent, filename: 'topics/fresh-topic', tenantId: UMBRELLA },
    { label: 'tenant-b under its own category', who: B, siteid: TENANT_B.siteId, parentid: bOwn, filename: 'b-topics/fresh-topic', tenantId: TENANT_B.tenantId },
  ])('$label: a CF UUID id, the parent path then its id, lastupdate at the clock, written in the category pool tenant', async ({ who, siteid, parentid, filename, tenantId }) => {
    const h = harness();
    const bean = await createCategory(h.deps, who, { siteid, name: 'Fresh Topic', parentid });

    expect(isCfUuid(bean.categoryid)).toBe(true);
    expect(bean).toMatchObject({
      siteid,
      parentid,
      path: `${parentid},${bean.categoryid}`,
      lastupdate: TEST_CLOCK.now(),
      lastupdateby: 'Admin User',
      urltitle: 'fresh-topic',
      filename,
      isnew: '0',
      errors: {},
    });
    const [insert, ...others] = tableWrites(h.db, CATEGORY_TABLE);
    expect(others).toEqual([]);
    expect(insert === undefined ? undefined : insertedRow(insert)).toMatchObject({
      tenant_id: tenantId,
      categoryid: bean.categoryid,
      siteid,
      parentid,
      path: bean.path,
      lastupdate: TEST_CLOCK.now(),
    });
    expect(tenantsOf(h.db.writes())).toEqual([tenantId]);
  });

  it("stores a bean of tenant-a's own site in tenant-a, as legacy stores by the bean's siteid", async () => {
    const h = harness();
    const bean = await createCategory(h.deps, A, { siteid: TENANT_A.siteId, name: 'Own Topic' });

    expect(bean.path).toBe(bean.categoryid);
    expect(tenantsOf(tableWrites(h.db, CATEGORY_TABLE))).toEqual([TENANT_A.tenantId]);
  });

  it("refuses a siteid that is neither the token's site nor its category pool, writing nothing", async () => {
    const h = harness();
    await expect(createCategory(h.deps, A, { siteid: TENANT_B.siteId, name: 'Foreign' })).rejects.toThrow(
      "Category site tenant-b is neither the token's site nor its category pool",
    );
    expect(h.db.writes()).toEqual([]);
  });

  it('takes the pool tenant from the registry only: an unregistered token tenant fails before any tenant transaction', async () => {
    const h = harness();
    const stranger = actor({ siteId: TENANT_A.siteId, tenantId: '00000000-0000-4000-8000-0000000000ff' });

    await expect(createCategory(h.deps, stranger, { siteid: POOL, name: 'Orphan' })).rejects.toBeInstanceOf(UnregisteredTenantError);
    expect(h.db.statements.filter((statement) => statement.tenantId !== null)).toEqual([]);
  });
});

describe('updateCategory', () => {
  it("moving a pooled category to a new parent rewrites its and its descendants' paths and filenames in the umbrella tenant", async () => {
    const h = harness();
    const bean = await updateCategory(h.deps, A, { categoryid: pooledChild, parentid: NEW_PARENT });

    expect(bean).toMatchObject({ path: `${NEW_PARENT},${pooledChild}`, filename: 'archive/news', errors: {} });
    expect(storedCategory(h, UMBRELLA, pooledChild)).toMatchObject({
      parentid: NEW_PARENT,
      path: `${NEW_PARENT},${pooledChild}`,
      filename: 'archive/news',
      lastupdate: TEST_CLOCK.now(),
    });
    expect(storedCategory(h, UMBRELLA, GRANDCHILD)).toMatchObject({
      parentid: pooledChild,
      path: `${NEW_PARENT},${pooledChild},${GRANDCHILD}`,
      filename: 'archive/news/briefs',
    });
    expect(storedCategory(h, UMBRELLA, pooledParent)).toMatchObject({ path: pooledParent, filename: 'topics' });
    expect(tenantsOf(h.db.writes())).toEqual([UMBRELLA]);
  });
});

describe('deleteCategory', () => {
  it('throws the category in the trash as objectClass category, then lifts its descendants and removes it, in the umbrella tenant', async () => {
    const h = harness();
    const { bean, trash } = await deleteCategory(h.deps, A, pooledChild);

    expect(bean).toMatchObject({ categoryid: pooledChild, name: 'News' });
    expect(trash).toMatchObject({
      objectid: pooledChild,
      objectclass: 'category',
      objecttype: 'category',
      objectsubtype: 'Default',
      objectlabel: 'News',
      parentid: pooledParent,
      siteid: POOL,
      deletedby: 'Admin User',
    });
    const writes = h.db.writes();
    const trashAt = writes.findIndex((statement) => statement.sql.startsWith('INSERT INTO "content"."trash"'));
    const deleteAt = writes.findIndex((statement) => statement.sql.startsWith(`DELETE FROM "content"."${CATEGORY_TABLE}"`));
    expect(trashAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(trashAt);
    expect(storedCategory(h, UMBRELLA, pooledChild)).toBeUndefined();
    expect(storedCategory(h, UMBRELLA, GRANDCHILD)).toMatchObject({ parentid: pooledParent, path: `${pooledParent},${GRANDCHILD}` });
    expect(tenantsOf(writes)).toEqual([UMBRELLA]);
  });

  it("deletes tenant-b's own category in tenant-b without touching the umbrella pool", async () => {
    const h = harness();
    const { trash } = await deleteCategory(h.deps, B, bOwn);

    expect(trash).toMatchObject({ objectid: bOwn, objectclass: 'category', siteid: TENANT_B.siteId });
    expect(storedCategory(h, TENANT_B.tenantId, bOwn)).toBeUndefined();
    expect(tenantsOf(h.db.writes())).toEqual([TENANT_B.tenantId]);
    expect(h.db.statements.some((statement) => statement.tenantId === UMBRELLA)).toBe(false);
  });
});

describe('listCategories and interest groups', () => {
  it.each([
    { label: 'tenant-a reads the umbrella pool', who: A, tenantId: UMBRELLA, siteId: POOL, top: [[NEW_PARENT, 0], [pooledParent, 1]], under: pooledParent, level: [[pooledChild, 1]] },
    { label: 'tenant-b reads its own site', who: B, tenantId: TENANT_B.tenantId, siteId: TENANT_B.siteId, top: [[bOwn, 0]], under: bOwn, level: [] },
  ])('$label level by level in name order with child counts', async ({ who, tenantId, siteId, top, under, level }) => {
    const h = harness();
    const nodes = async (parentId?: string): Promise<unknown[]> =>
      (await listCategories(h.deps, who, parentId === undefined ? {} : { parentId })).map((row) => [row.categoryid, row.haskids]);

    expect(await nodes()).toEqual(top);
    expect(await nodes(under)).toEqual(level);
    const reads = categoryReads(h.db);
    expect(tenantsOf(reads)).toEqual([tenantId]);
    expect(reads.map((statement) => statement.params[1])).toEqual([siteId, siteId]);
    expect(reads[0]?.sql).toMatch(/c\.parentid IS NULL GROUP BY .* ORDER BY lower\(c\.name\) ASC/);
  });

  it('reads interest groups from the umbrella pool only, leaving out categories that are no interest group', async () => {
    const h = harness();

    expect((await listPoolCategories(h.deps, A, { interestOnly: true })).map((row) => row.name)).toEqual(['Briefs', 'News', 'Topics']);
    expect((await listCategories(h.deps, A, { interestsOnly: true })).map((row) => row.categoryid)).toEqual([pooledParent]);
    expect((await listPoolCategories(h.deps, A)).map((row) => row.name)).toEqual(['Archive', 'Briefs', 'News', 'Topics']);
    expect(tenantsOf(categoryReads(h.db))).toEqual([UMBRELLA]);
  });
});

describe('updateCategoryAction', () => {
  const PRIVATE_POOL_GROUPS = [
    { groupname: 'Editor', userid: IDS.groups.editor, ispublic: 0 },
    { groupname: 'Content Approvers', userid: IDS.groups.approvers, ispublic: 0 },
  ];

  it.each([
    { action: 'add', rc: { action: 'add', categoryid: '', siteid: POOL, name: 'Added', parentid: pooledParent }, verb: 'INSERT' },
    { action: 'update', rc: { action: 'update', categoryid: pooledChild, siteid: TENANT_A.siteId, name: 'News Renamed' }, verb: 'UPDATE' },
    { action: 'delete', rc: { action: 'delete', categoryid: pooledChild, siteid: TENANT_A.siteId }, verb: 'DELETE' },
  ])('action=$action redirects to cCategory.list appending siteid after its $verb in the umbrella tenant', async ({ rc, verb }) => {
    const h = harness();

    expect(await updateCategoryAction(h.deps, A, rc)).toEqual(LIST_REDIRECT);
    expect(tableWrites(h.db, CATEGORY_TABLE).some((statement) => statement.sql.startsWith(`${verb} `))).toBe(true);
    expect(tenantsOf(h.db.writes())).toEqual([UMBRELLA]);
  });

  it.each([
    { action: 'add', rc: { action: 'add', categoryid: '', siteid: POOL, name: '' } },
    { action: 'update', rc: { action: 'update', categoryid: pooledChild, siteid: TENANT_A.siteId, name: '' } },
  ])('action=$action with a missing name re-renders with the bean errors and the restrict groups, writing nothing', async ({ rc }) => {
    const h = harness();
    const outcome = await updateCategoryAction(h.deps, A, rc);

    expect(outcome).toMatchObject({ kind: 'rerender', bean: { errors: NAME_ERROR } });
    const groups = outcome.kind === 'rerender' ? outcome.rsRestrictGroups : [];
    expect(groups).toHaveLength(PRIVATE_POOL_GROUPS.length);
    expect(groups).toEqual(expect.arrayContaining(PRIVATE_POOL_GROUPS));
    expect(h.db.writes()).toEqual([]);
  });

  it('writes nothing for a refused token: delete still redirects, add fails where legacy dereferences the undefined bean', async () => {
    const h = harness();

    expect(await updateCategoryAction(h.deps, A, { action: 'delete', categoryid: pooledChild }, { csrfValid: false })).toEqual(LIST_REDIRECT);
    await expect(updateCategoryAction(h.deps, A, { action: 'add', categoryid: '', siteid: POOL, name: 'Never' }, { csrfValid: false })).rejects.toThrow(
      'Element RC.categoryBean is undefined in ARGUMENTS.',
    );
    expect(h.db.writes()).toEqual([]);
  });
});

/** The legacy `<field><categoryid>` form key: the id without dashes. */
const fieldOf = (field: string, categoryId: string): string => `${field}${categoryId.replaceAll('-', '')}`;

describe('category assignments', () => {
  it("setCategoryAssignments writes the content's assignments in tenant-a from categories read in the umbrella pool", async () => {
    const h = harness();
    const poolCategories = await listPoolCategories(h.deps, A);
    const keeper = categoryAssignRow({ contenthistid: HIST_OLD, contentid: CONTENT_ONE, categoryid: NEW_PARENT, isfeature: 1, orderno: 3 });
    const stored = await h.db.withTenant(TENANT_A.tenantId, (tx) =>
      setCategoryAssignments(tx, h.deps.repository, {
        data: {
          categoryID: `${pooledChild},${pooledParent}`,
          [fieldOf('categoryAssign', pooledChild)]: '1',
          [fieldOf('categoryAssign', pooledParent)]: '2',
          [fieldOf('featureStart', pooledParent)]: '2026-07-01',
          [fieldOf('startHour', pooledParent)]: '9',
          [fieldOf('startMinute', pooledParent)]: '30',
          [fieldOf('startDayPart', pooledParent)]: 'PM',
          [fieldOf('featureStop', pooledParent)]: '',
          [fieldOf('stopHour', pooledParent)]: '5',
          [fieldOf('stopMinute', pooledParent)]: '0',
          [fieldOf('categoryAssign', GRANDCHILD)]: '',
        },
        contentId: CONTENT_ONE,
        contentHistId: HIST_NEW,
        siteId: TENANT_A.siteId,
        poolCategories,
        current: [keeper],
      }),
    );

    expect(stored.map((row) => [row.categoryid, row.contenthistid, row.isfeature])).toEqual([
      [NEW_PARENT, HIST_NEW, 1],
      [pooledChild, HIST_NEW, 1],
      [pooledParent, HIST_NEW, 2],
    ]);
    expect(stored.at(-1)).toMatchObject({ featurestart: new Date(2026, 6, 1, 21, 30), featurestop: null });
    expect(tenantsOf(tableWrites(h.db, ASSIGN_TABLE))).toEqual([TENANT_A.tenantId]);
    expect(tenantsOf(categoryReads(h.db))).toEqual([UMBRELLA]);
  });

  it('keepCategories copies only the listed assignments onto the version, keeping feature dates only for scheduled features', async () => {
    const h = harness({ assignments: [categoryAssignRow({ contenthistid: HIST_OLD, contentid: CONTENT_ONE, categoryid: GRANDCHILD })] });
    const start = new Date(2026, 6, 1, 9, 0);
    const stop = new Date(2026, 6, 31, 17, 0);
    const scheduled = categoryAssignRow({ contenthistid: HIST_OLD, contentid: CONTENT_ONE, categoryid: pooledChild, isfeature: 2, featurestart: start, featurestop: stop });
    const plain = categoryAssignRow({ contenthistid: HIST_OLD, contentid: CONTENT_ONE, categoryid: pooledParent, isfeature: 1, featurestart: start, featurestop: stop });
    const kept = await h.db.withTenant(TENANT_A.tenantId, (tx) => keepCategories(tx, h.deps.repository, HIST_NEW, [scheduled, plain]));

    expect(kept.map((row) => [row.categoryid, row.contenthistid, row.isfeature, row.featurestart, row.featurestop])).toEqual([
      [pooledChild, HIST_NEW, 2, start, stop],
      [pooledParent, HIST_NEW, 1, null, null],
    ]);
    expect(h.assignments.get(TENANT_A.tenantId)?.filter((row) => row.contenthistid === HIST_NEW).map((row) => row.categoryid)).toEqual([pooledChild, pooledParent]);
    expect(tenantsOf(h.db.writes())).toEqual([TENANT_A.tenantId]);
  });
});

describe('setListOrder', () => {
  const listed = (): Row[] => [
    categoryAssignRow({ contenthistid: 'A2000000-0000-0000-0000000000000101', contentid: CONTENT_ONE, categoryid: pooledChild, orderno: 1 }),
    categoryAssignRow({ contenthistid: 'A2000000-0000-0000-0000000000000102', contentid: CONTENT_TWO, categoryid: pooledChild, orderno: 2 }),
    categoryAssignRow({ contenthistid: 'A2000000-0000-0000-0000000000000103', contentid: CONTENT_ONE, categoryid: pooledParent, orderno: 5 }),
  ];

  it('writes each listed content orderno, in the given order, in the content pool tenant', async () => {
    const h = harness({ assignments: listed() });
    const updated = await setListOrder(h.deps, A, { categoryId: pooledChild, orderId: `${CONTENT_TWO},${CONTENT_ONE}`, orderno: '1,2', siteId: TENANT_A.siteId });

    expect(updated.map((row) => [row.contentid, row.orderno])).toEqual([
      [CONTENT_TWO, 1],
      [CONTENT_ONE, 2],
    ]);
    expect(tableWrites(h.db, ASSIGN_TABLE).map((statement) => statement.params[0])).toEqual([1, 2]);
    expect(h.assignments.get(TENANT_A.tenantId)?.map((row) => [row.contentid, row.categoryid, row.orderno])).toEqual([
      [CONTENT_ONE, pooledChild, 2],
      [CONTENT_TWO, pooledChild, 1],
      [CONTENT_ONE, pooledParent, 5],
    ]);
    expect(tenantsOf(h.db.writes())).toEqual([TENANT_A.tenantId]);
  });

  it('fails as listGetAt does when orderno lists fewer items than orderId, before any write', async () => {
    const h = harness({ assignments: listed() });

    await expect(
      setListOrder(h.deps, A, { categoryId: pooledChild, orderId: `${CONTENT_TWO},${CONTENT_ONE}`, orderno: '1', siteId: TENANT_A.siteId }),
    ).rejects.toThrow('Invalid list index 2.');
    expect(h.db.writes()).toEqual([]);
  });
});


describe('ccategory admin route and JSON API category reads', () => {
  const db = createRecordingDb();
  let t: TestApp;
  let h: Harness;

  beforeAll(async () => {
    t = await buildTestApp({ db });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    db.reset();
    h = harness({ db });
    t.client.csrfValid = true;
    t.client.clear();
  });

  const postCategory = async (form: Record<string, string>, headers: Record<string, string>) =>
    t.app.inject({ method: 'POST', url: CATEGORIES_URL, headers: { ...headers, ...FORM }, payload: new URLSearchParams(form).toString() });

  it.each([
    { label: 'the s2 role', roles: ['s2'], allowed: true },
    { label: 'the site Admin role', roles: ['site-admin'], allowed: true },
    { label: 'the Categories and Site Manager module roles', roles: ['system-user', m('010'), m('000')], allowed: true },
    { label: 'the Categories module role alone', roles: ['system-user', m('010')], allowed: false },
    { label: 'the Site Manager module role alone', roles: ['system-user', m('000')], allowed: false },
  ])('categoryAccess with $label decides the ccategory gate (allowed: $allowed)', async ({ roles, allowed }) => {
    expect(categoryAccess(actor(TENANT_A, roles))).toBe(allowed);
    const res = await t.app.inject({
      method: 'GET',
      url: CATEGORIES_URL,
      headers: await userHeaders({ sub: SUBJECT_USER_IDS['site-admin'], site: TENANT_A.siteId, roles }),
    });

    expect(res.statusCode, res.body).toBe(allowed ? 200 : 403);
    if (allowed) expect(res.json<{ rc: { categories: Array<{ name: string }> } }>().rc.categories.map((node) => node.name)).toEqual(['Archive', 'Topics']);
  });

  it('POST update consumes the token under context categoryid, updates the pooled row in the umbrella tenant and redirects to cCategory.list with siteid', async () => {
    const res = await postCategory({ action: 'update', categoryID: pooledChild, name: 'News Renamed', ...CSRF }, await contentHeaders('site-admin'));

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ saved: true, errors: {}, redirect: { circuit: 'cCategory', action: 'list', params: [['siteid', TENANT_A.siteId]] } });
    expect(t.client.csrfConsumes).toEqual([expect.objectContaining({ token: CSRF.csrf_token, expires: CSRF.csrf_token_expires, context: pooledChild })]);
    expect(storedCategory(h, UMBRELLA, pooledChild)).toMatchObject({ name: 'News Renamed' });
    expect(tenantsOf(tableWrites(db, CATEGORY_TABLE))).toEqual([UMBRELLA]);
  });

  it('POST update by an editor without the Categories module role is the admin denial, before the token is consumed or anything written', async () => {
    const res = await postCategory({ action: 'update', categoryID: pooledChild, name: 'Denied', ...CSRF }, await contentHeaders('editor'));

    expect(res.statusCode, res.body).toBe(403);
    expect(t.client.csrfConsumes).toEqual([]);
    expect(db.writes()).toEqual([]);
  });

  it('JSON API category findOne reads a pooled category through the umbrella pool', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/_api/json/v1/tenant-a/category/${pooledChild}`, headers: await contentHeaders('site-admin') });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ data: Row }>().data).toMatchObject({
      id: pooledChild,
      categoryid: pooledChild,
      name: 'News',
      siteid: POOL,
      path: `${pooledParent},${pooledChild}`,
      filename: 'topics/news',
    });
    expect(tenantsOf(categoryReads(db))).toEqual([UMBRELLA]);
  });

  it.each(['', '?contentpoolid=umbrella'])(
    "JSON API GET category%s lists only the API site's own categories in tenant-a, as categoryFeedBean's siteID filter does",
    async (query) => {
      // The in-memory table reads no bean-feed SQL: an empty count answers the feed, and its statements show where it read.
      db.respond(/^SELECT \(SELECT count\(\*\)::integer FROM "content"\."category" /, [{ n: 0 }]);
      const res = await t.app.inject({ method: 'GET', url: `/_api/json/v1/tenant-a/category${query}`, headers: await contentHeaders('site-admin') });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ data: Row }>().data).toMatchObject({ entityname: 'category', totalitems: 0, items: [] });
      const reads = categoryReads(db);
      expect(tenantsOf(reads)).toEqual([TENANT_A.tenantId]);
      expect(reads.map((statement) => statement.params[1])).toEqual([TENANT_A.siteId]);
      expect(db.statements.some((statement) => statement.tenantId === UMBRELLA)).toBe(false);
    },
  );

  it('JSON API contentCategoryAssign findAll counts tenant-a assignments joined to the categories of the umbrella pool', async () => {
    db.respond(/^SELECT EXISTS \(SELECT 1 FROM "content"\."content_category_assign" /, [{ found: true }]);
    db.respond(/^SELECT \(SELECT count\(\*\)::integer FROM "content"\."content_category_assign" /, [{ n: 0 }]);
    const res = await t.app.inject({ method: 'GET', url: '/_api/json/v1/tenant-a/contentCategoryAssign', headers: await contentHeaders('site-admin') });

    expect(res.statusCode, res.body).toBe(200);
    expect(categoryReads(db).map((statement) => [statement.tenantId, statement.params[1]])).toEqual([
      [UMBRELLA, POOL],
      [TENANT_A.tenantId, TENANT_A.siteId],
    ]);
    const joined = db.statements.find((statement) => /^SELECT \(SELECT count\(\*\)::integer FROM "content"\."content_category_assign" a INNER JOIN/.test(statement.sql));
    expect(joined?.tenantId).toBe(TENANT_A.tenantId);
    expect(joined?.params[1]).toEqual([NEW_PARENT, GRANDCHILD, pooledChild, pooledParent].map((id) => id.toLowerCase()));
  });

  it.each([`/_api/json/v1/tenant-a/category/${pooledChild}`, `/_api/json/v1/tenant-b/category/${pooledChild}?siteid=tenant-a`])(
    "a tenant-b token is refused tenant-a's pool through %s (403) without any pooled read",
    async (url) => {
      const res = await t.app.inject({ method: 'GET', url, headers: await contentHeaders('other-tenant') });

      expect(res.statusCode, res.body).toBe(403);
      expect(categoryReads(db)).toEqual([]);
      expect(db.statements.some((statement) => statement.tenantId === UMBRELLA)).toBe(false);
    },
  );
});
