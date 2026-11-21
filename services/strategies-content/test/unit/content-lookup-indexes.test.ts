/** The filename, remote-id, category-parent and feed-list statements seek their indexes as the app role under forced RLS, and still match as legacy does. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { SITE_TREE_MODULE_ID, readActiveByFilename, readActiveByRemoteId, readActiveByRemoteIds } from '../../src/repo/content-queries.js';
import { feedContent } from '../../src/repo/feed-queries.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

/** A CF UUID (8-4-4-16) whose first group is `n` in hex and second `group`. */
const cfId = (group: string, n: number): string => `${n.toString(16).toUpperCase().padStart(8, '0')}-${group}-BBBB-CCCCDDDDEEEEFFFF`;
const SITE = TENANT_A.siteId;
const TODAY = new Date(2026, 5, 30, 12, 0, 0);
const PAGE = cfId('AAAA', 1);
const PAGE_H = cfId('AAAB', 1);
const PAGE_OLD_H = cfId('AAAB', 2);
const CAFE = cfId('AAAA', 3);
const CAFE_H = cfId('AAAB', 3);
const PARENT = cfId('CCCC', 1);
const CHILDREN = [cfId('CCCC', 2), cfId('CCCC', 3), cfId('CCCC', 4)];

type Row = Record<string, unknown>;
/** A node of `EXPLAIN (FORMAT JSON)`. */
interface PlanNode {
  'Node Type': string;
  Alias?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}
/** The row `EXPLAIN (FORMAT JSON)` answers. */
type ExplainRow = { 'QUERY PLAN': [{ Plan: PlanNode }] };
/** A table read of a plan: the alias, the index it seeks (or its node type) and the index condition. */
interface Scan {
  alias: string;
  index: string;
  cond: string;
}

let handle: ThrowawaySchema;
let repo: ContentRepository;
const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>, tenantId = TENANT_A.tenantId): Promise<T> => withTenant(handle.app, tenantId, fn);

async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

const page = (contentid: string, contenthistid: string, row: Row): Row => ({
  siteid: SITE,
  moduleid: SITE_TREE_MODULE_ID,
  contentid,
  contenthistid,
  type: 'Page',
  active: 1,
  approved: 1,
  isnav: 1,
  display: 1,
  searchexclude: 0,
  ...row,
});

/** Every table read of `node`'s tree; a bitmap heap scan reads the indexes of its bitmap index scans. */
function scans(node: PlanNode): Scan[] {
  const bitmapIndexes = (n: PlanNode): PlanNode[] => (n['Index Name'] === undefined ? (n.Plans ?? []).flatMap(bitmapIndexes) : [n]);
  const bitmap = node['Node Type'] === 'Bitmap Heap Scan';
  const reads = node.Alias === undefined ? [] : bitmap ? (node.Plans ?? []).flatMap(bitmapIndexes) : [node];
  const own = reads.map((read) => ({ alias: node.Alias as string, index: read['Index Name'] ?? read['Node Type'], cond: read['Index Cond'] ?? '' }));
  return [...own, ...(bitmap ? [] : (node.Plans ?? []).flatMap(scans))];
}

/** The table reads of the one statement `run` sends from `table` as `alias`, planned as the app role with sequential scans and hash or merge joins off. */
function plannedScans(run: (tx: TenantTx) => Promise<unknown>, table: string, alias: string): Promise<Scan[]> {
  return inTenant(async (tx) => {
    const sent: { sql: string; params: unknown[] }[] = [];
    const query = ((sql: string, params?: unknown[]) => {
      sent.push({ sql, params: params ?? [] });
      return tx.query(sql, params);
    }) as TenantTx['query'];
    await run({ ...tx, query });
    const [statement, ...others] = sent.filter(({ sql }) => sql.includes(`"${handle.schema}"."${table}" ${alias} `));
    expect(statement).toBeDefined();
    expect(others).toEqual([]);
    for (const setting of ['enable_seqscan', 'enable_hashjoin', 'enable_mergejoin']) await tx.query(`SET LOCAL ${setting} = off`);
    const { rows } = await tx.query<ExplainRow>(`EXPLAIN (FORMAT JSON) ${statement?.sql ?? ''}`, statement?.params);
    return scans((rows[0] as ExplainRow)['QUERY PLAN'][0].Plan);
  });
}

const histIds = (rows: readonly { contenthistid: string | null }[]): (string | null)[] => rows.map((row) => row.contenthistid).sort();

describe.skipIf(!(await pgAvailable()))('content lookup and feed indexes', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    repo = createContentRepository({ schema: handle.schema });
    await inTenant(async (tx) => {
      await tx.query(
        `INSERT INTO ${handle.schema}.content (tenant_id, siteid, moduleid, contentid, contenthistid, type, active, approved, isnav, display, searchexclude, filename, remoteid)
         SELECT $1, $2, $3, upper(substr(md5(n::text), 1, 8)) || '-FFFF-BBBB-CCCCDDDDEEEEFFFF', upper(substr(md5(n::text), 1, 8)) || '-FFFE-BBBB-CCCCDDDDEEEEFFFF',
           'Page', n % 2, 1, n % 3, 1, 0, 'filler/page-' || n, 'F-' || n FROM generate_series(1, 400) n`,
        [tx.tenantId, SITE, SITE_TREE_MODULE_ID],
      );
      await insert(tx, 'content', [
        page(PAGE, PAGE_H, { filename: 'path/page', remoteid: 'REM-1' }),
        page(PAGE, PAGE_OLD_H, { filename: 'path/page', remoteid: 'REM-1', active: 0 }),
        page(CAFE, CAFE_H, { filename: 'café/été', remoteid: 'Café-3' }),
      ]);
      await tx.query(
        `INSERT INTO ${handle.schema}.category (tenant_id, categoryid, siteid, parentid, name, isinterestgroup, isactive)
         SELECT $1, upper(substr(md5(n::text), 1, 8)) || '-FFFF-BBBB-CCCCDDDDEEEEFFFF', $2,
           CASE WHEN n > 50 THEN upper(substr(md5((n % 50)::text), 1, 8)) || '-FFFF-BBBB-CCCCDDDDEEEEFFFF' END, 'Filler ' || n, n % 2, 1
         FROM generate_series(1, 300) n`,
        [tx.tenantId, SITE],
      );
      await insert(tx, 'category', [
        { categoryid: PARENT, siteid: SITE, name: 'Parent', isinterestgroup: 1, isactive: 1 },
        ...CHILDREN.map((categoryid, i) => ({ categoryid, siteid: SITE, parentid: PARENT, name: `Child ${i}`, isinterestgroup: 1, isactive: 1 })),
      ]);
    });
    await inTenant((tx) => insert(tx, 'content', [page(cfId('BBBB', 1), cfId('BBBC', 1), { filename: 'path/page', remoteid: 'REM-1' })]), TENANT_B.tenantId);
    const owner = await handle.migratorPool.connect();
    try {
      await owner.query(`SET ROLE ${handle.roles.owner}`);
      await owner.query(`ANALYZE ${handle.schema}.content, ${handle.schema}.category`);
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    await handle?.drop();
  });

  const sites = [{ siteId: SITE, site: 'Tenant A' }];
  it.each<[string, (tx: TenantTx) => Promise<unknown>, string, string, string, string]>([
    ['readActiveByFilename', (tx) => readActiveByFilename(tx, { siteId: SITE, filename: 'PATH/Page ' }), 'content', 'tcontent', 'content_tenant_siteid_filename_ci_idx', '(filename)::bpchar'],
    ['readActiveByRemoteId', (tx) => readActiveByRemoteId(tx, { siteId: SITE, remoteId: 'rem-1 ' }), 'content', 'tcontent', 'content_tenant_siteid_remoteid_ci_idx', '(remoteid)::bpchar ='],
    ['readActiveByRemoteIds', (tx) => readActiveByRemoteIds(tx, { siteId: SITE, remoteIds: ['rem-1', 'F-7'] }), 'content', 'tcontent', 'content_tenant_siteid_remoteid_ci_idx', '(remoteid)::bpchar = ANY'],
    ['listCategories of a parent', (tx) => repo.categories.listCategories(tx, { siteId: SITE, parentId: PARENT }), 'category', 'c', 'category_tenant_parentid_idx', 'parentid = ANY'],
    ['listCategories at the top level', (tx) => repo.categories.listCategories(tx, { siteId: SITE }), 'category', 'c', 'category_tenant_parentid_idx', 'parentid IS NULL'],
    ['listCategories child counts', (tx) => repo.categories.listCategories(tx, { siteId: SITE }), 'category', 'k', 'category_tenant_parentid_idx', 'parentid = c.categoryid'],
    ['privateInterestGroups of a parent', (tx) => repo.categories.privateInterestGroups(tx, { sites, parentId: PARENT }), 'category', 'c', 'category_tenant_parentid_idx', 'parentid = ANY'],
    ['privateInterestGroups child counts', (tx) => repo.categories.privateInterestGroups(tx, { sites }), 'category', 'k', 'category_tenant_parentid_idx', 'parentid = c.categoryid'],
    ['feedContent', (tx) => feedContent(tx, { siteId: SITE, today: TODAY, maxItems: 0 }), 'content', 'tcontent', 'content_tenant_siteid_moduleid_isnav_searchexclude_idx', 'moduleid ='],
  ])('%s seeks its index under forced RLS', async (_label, run, table, alias, index, cond) => {
    const reads = (await plannedScans(run, table, alias)).filter((scan) => scan.alias === alias);
    expect(reads).toEqual([expect.objectContaining({ index })]);
    expect(reads[0]?.cond).toContain(cond);
  });

  it.each<[string, string, (string | null)[]]>([
    ['its stored case', 'path/page', [PAGE_H]],
    ['another case with trailing spaces', 'PATH/Page  ', [PAGE_H]],
    ['upper-case accented letters', 'CAFÉ/ÉTÉ', [CAFE_H]],
    ['the letters without their accents', 'cafe/ete', []],
    ['a prefix', 'path/pag', []],
  ])('readActiveByFilename matches %s as legacy does', async (_label, filename, expected) => {
    expect(histIds(await inTenant((tx) => readActiveByFilename(tx, { siteId: SITE, filename })))).toEqual(expected);
  });

  it.each<[string, string, (string | null)[]]>([
    ['another case with trailing spaces', 'rem-1  ', [PAGE_H]],
    ['upper case', 'CAFÉ-3', [CAFE_H]],
    ['the letters without their accents', 'cafe-3', []],
  ])('readActiveByRemoteId matches %s as legacy does', async (_label, remoteId, expected) => {
    expect(histIds(await inTenant((tx) => readActiveByRemoteId(tx, { siteId: SITE, remoteId })))).toEqual(expected);
  });

  it('readActiveByRemoteIds keys each requested id by legacy matching', async () => {
    const found = await inTenant((tx) => readActiveByRemoteIds(tx, { siteId: SITE, remoteIds: ['rem-1', 'REM-1 ', 'cafe-3', 'CAFÉ-3', ''] }));
    expect(Object.fromEntries([...found].map(([id, rows]) => [id, histIds(rows)]))).toEqual({
      'rem-1': [PAGE_H],
      'REM-1 ': [PAGE_H],
      'cafe-3': [],
      'CAFÉ-3': [CAFE_H],
      '': [],
    });
  });
});
