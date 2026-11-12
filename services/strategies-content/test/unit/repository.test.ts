/** The content repository over a throwaway `content` schema: legacy storage rules, one changelog row per written row, keyless multiplicity, multi-row legacy writes, reads, tenant isolation and unit gates. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { OutsideTenantTransactionError, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const SITE = TENANT_A.siteId;
const TREE = '00000000000000000000000000000000000';

let handle: ThrowawaySchema;
let repo: ContentRepository;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_B.tenantId, fn);

interface Change {
  op: string;
  table: string;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
}

async function changelog(): Promise<Change[]> {
  return inA(async (tx) => (await tx.query<Change>(`SELECT op, "table", key, before, after, columns FROM ${handle.schema}.changelog ORDER BY seq`)).rows);
}

async function newChanges<T>(fn: () => Promise<T>): Promise<{ result: T; changes: Change[] }> {
  const before = (await changelog()).length;
  const result = await fn();
  const after = await changelog();
  return { result, changes: after.slice(before) };
}

async function setGates(state: 'open' | 'legacy', units: readonly string[] = CONTENT_UNITS): Promise<void> {
  await closeGates(handle.app, { units, holderId: 'repository-test', allowLegacy: true });
  await openGates(handle.app, { units, holderId: 'repository-test', state });
}

function version(contentId: string, histId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { contentid: contentId, contenthistid: histId, siteid: SITE, type: 'Page', subtype: 'Default', moduleid: TREE, active: 1, approved: 1, display: 1, ...extra };
}

describe.skipIf(!(await pgAvailable()))('repo/repository', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await setGates('open');
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('exposes every namespace and the platform repository', () => {
    expect(Object.keys(repo).sort()).toEqual(
      ['approvalQueues', 'approvals', 'categories', 'changesets', 'comments', 'content', 'extend', 'feeds', 'files', 'forms', 'platform', 'projections', 'stats', 'trash', 'variation'].sort(),
    );
    expect(repo.platform.schema).toBe(handle.schema);
    expect(typeof repo.content.readVersion).toBe('function');
    expect(typeof repo.feeds.feedById).toBe('function');
    expect(typeof repo.files.readFile).toBe('function');
  });

  it('insertVersion stores the version as contentDAO.create does, with a negative identity and one changelog row', async () => {
    const { result, changes } = await newChanges(() =>
      inA((tx) =>
        repo.content.insertVersion(
          tx,
          version(cfId('C', 1), cfId('H', 1), {
            display: 2,
            displaystart: new Date(2026, 5, 1, 9, 30, 45, 500),
            title: '  Hello ',
            menutitle: '',
            isfeature: 1,
            featurestart: new Date(2026, 5, 2),
            target: '_self',
            targetparams: 'width=1',
            parentid: cfId('P', 1),
            orderno: 1,
            path: `'${cfId('P', 1)}','${cfId('C', 1)}'`,
            filename: 'hello',
            releasedate: new Date(2026, 5, 3, 1, 2, 3, 456),
          }),
        ),
      ),
    );
    expect(result.tcontent_id).toBeLessThan(0);
    expect(result.title).toBe('Hello');
    expect(result.menutitle).toBeNull();
    expect(result.displaystart).toEqual(new Date(2026, 5, 1, 9, 30, 0, 0));
    expect(result.displaystop).toBeNull();
    expect(result.featurestart).toBeNull();
    expect(result.targetparams).toBeNull();
    expect(result.releasedate).toEqual(new Date(2026, 5, 3, 1, 2, 3, 0));
    expect(result.lastupdate).toEqual(NOW);
    expect(result.created).toEqual(NOW);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.op).toBe('insert');
    expect(changes[0]?.table).toBe('content');
    const second = await inA((tx) => repo.content.insertVersion(tx, version(cfId('C', 9), cfId('H', 9))));
    expect(second.tcontent_id).toBe(result.tcontent_id + 1);
    const blank = await inA((tx) => repo.content.insertVersion(tx, { siteid: SITE, type: 'Page', target: '_blank', targetparams: 'a=1' }));
    expect(blank.contentid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
    expect(blank.targetparams).toBe('a=1');
  });

  it('archiveActive writes one changelog update per affected version', async () => {
    const id = cfId('C', 2);
    await inA(async (tx) => {
      await repo.content.insertVersion(tx, version(id, cfId('H', 21)));
      await repo.content.insertVersion(tx, version(id, cfId('H', 22)));
      await repo.content.insertVersion(tx, version(id, cfId('H', 23), { active: 0 }));
    });
    const { result, changes } = await newChanges(() => inA((tx) => repo.content.archiveActive(tx, { contentId: id.toLowerCase(), siteId: SITE })));
    expect(result).toHaveLength(2);
    expect(changes.map((change) => [change.op, change.columns])).toEqual([
      ['update', ['active']],
      ['update', ['active']],
    ]);
    expect(changes.every((change) => change.before !== null && change.after !== null)).toBe(true);
    const activated = await inA((tx) => repo.content.setActive(tx, { contentHistId: cfId('H', 23) }));
    expect(activated?.active).toBe(1);
  });

  it('updates versions by filter, shifts siblings and rewrites paths', async () => {
    const parent = cfId('P', 3);
    await inA(async (tx) => {
      for (const n of [1, 2, 3]) {
        await repo.content.insertVersion(tx, version(cfId('S', n), cfId('T', n), { parentid: parent, orderno: n, path: `'${parent}','${cfId('S', n)}'` }));
      }
      await repo.content.insertVersion(tx, version(cfId('S', 4), cfId('T', 4), { parentid: parent, orderno: 9, type: 'Variation' }));
    });
    const shifted = await inA((tx) => repo.content.shiftSiblingOrder(tx, { parentId: parent, siteId: SITE, delta: 1, orderNoAbove: 1 }));
    expect(shifted.map((row) => row.orderno).sort()).toEqual([3, 4]);
    expect(await inA((tx) => repo.content.maxSiblingOrderNo(tx, { parentId: parent, siteId: SITE }))).toBe(4);
    const renamed = await inA((tx) => repo.content.replacePathPrefix(tx, { siteId: SITE, currentPath: `'${parent}'`, newPath: `'${cfId('Q', 1)}'` }));
    expect(renamed).toHaveLength(3);
    expect(renamed.every((row) => row.path?.startsWith(`'${cfId('Q', 1)}'`))).toBe(true);
    const updated = await inA((tx) => repo.content.updateVersion(tx, cfId('T', 1), { menutitle: 'Menu' }));
    expect(updated?.menutitle).toBe('Menu');
    expect(await inA((tx) => repo.content.updateVersion(tx, cfId('Z', 1), { menutitle: 'none' }))).toBeNull();
    await expect(inA((tx) => repo.content.updateVersions(tx, {}, { menutitle: 'x' }))).rejects.toThrow(/names no column/);
    await inA((tx) => repo.content.updateVersion(tx, cfId('T', 2), { changesetid: cfId('X', 1), active: 0 }));
    const cleared = await inA((tx) => repo.content.clearChangeset(tx, { contentId: cfId('S', 2), changesetId: cfId('X', 1), siteId: SITE }));
    expect(cleared[0]?.changesetid).toBeNull();
    const moved = await inA((tx) => repo.content.reparentInactive(tx, { contentId: cfId('S', 2), siteId: SITE, parentId: cfId('Q', 2) }));
    expect(moved[0]?.parentid).toBe(cfId('Q', 2));
  });

  it('replaces version children and deletes one version with them', async () => {
    const id = cfId('D', 1);
    const hist = cfId('E', 1);
    await inA(async (tx) => {
      await repo.content.insertVersion(tx, version(id, hist));
      await repo.content.replaceObjects(tx, hist, [{ objectid: 'o1', object: 'component', contentid: id, name: 'n', orderno: 1, siteid: SITE, columnid: 1, params: '{"a":1}' }]);
      const tags = await repo.content.replaceTags(tx, hist, [{ contentid: id, siteid: SITE, tag: 'red' }, { contentid: id, siteid: SITE, tag: 'blue' }]);
      expect(tags.every((tag) => tag.tagid < 0)).toBe(true);
      const related = await repo.content.replaceRelatedItems(tx, hist, SITE, [{ contentid: id, relatedid: cfId('R', 1), orderno: 1 }]);
      expect(related[0]?.relatedcontentid).toBeLessThan(0);
      const assigned = await repo.content.replaceCategoryAssignments(tx, hist, [
        { categoryid: cfId('K', 1), contentid: id, siteid: SITE, isfeature: 1, featurestart: new Date(2026, 1, 1), orderno: 1 },
      ]);
      expect(assigned[0]?.featurestart).toBeNull();
      await repo.content.replaceContentAssignments(tx, { contentId: id, contentHistId: hist, siteId: SITE, type: 'expire', userIds: [cfId('U', 1), cfId('U', 1)] });
      await repo.files.insertFileMetadata(tx, { contenthistid: hist, contentid: id, fileid: cfId('F', 1), siteid: SITE, alttext: '' });
      const params = await repo.content.updateObjectParams(tx, { contentHistId: hist, columnId: 1, orderNo: 1, params: '{"b":2}' });
      expect(params[0]?.params).toBe('{"b":2}');
    });
    const copies = await inA((tx) => repo.content.persistVersionedObjects(tx, hist, cfId('E', 2), { fileIds: [cfId('F', 1).toLowerCase()] }));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.alttext).toBeNull();
    expect(copies[0]?.contenthistid).toBe(cfId('E', 2));
    const { result, changes } = await newChanges(() => inA((tx) => repo.content.deleteVersion(tx, { contentHistId: hist, siteId: SITE })));
    expect(result.versions).toHaveLength(1);
    const tables = changes.map((change) => change.table);
    expect(tables).toEqual(expect.arrayContaining(['content', 'content_tag', 'content_object', 'content_category_assign', 'content_assignment', 'file_metadata']));
    expect(changes.every((change) => change.op === 'delete')).toBe(true);
    // Related items are not part of contentManager.deleteVersion.
    expect(tables).not.toContain('content_related');
  });

  it('deleteHistAll keeps pending and active versions and removes requests with actions', async () => {
    const id = cfId('G', 1);
    await inA(async (tx) => {
      await repo.content.insertVersion(tx, version(id, cfId('J', 1)));
      await repo.content.insertVersion(tx, version(id, cfId('J', 2), { active: 0 }));
      await repo.content.insertVersion(tx, version(id, cfId('J', 3), { active: 0, approved: 0 }));
      await repo.content.insertVersion(tx, version(id, cfId('J', 4), { active: 0, approved: 0 }));
      const request = await repo.approvals.insertRequest(tx, { contenthistid: cfId('J', 2), status: 'Rejected', siteid: SITE });
      await repo.approvals.insertAction(tx, { requestid: request.requestid, actiontype: 'Reject', siteid: SITE });
      await repo.approvals.insertRequest(tx, { contenthistid: cfId('J', 4), siteid: SITE });
      await repo.content.insertSourceMap(tx, { contentid: id, siteid: SITE, created: new Date(2020, 0, 1), contenthistid: cfId('J', 1) });
    });
    const result = await inA((tx) => repo.content.deleteHistAll(tx, { contentId: id, siteId: SITE }));
    expect(result.versions.map((row) => row.contenthistid).sort()).toEqual([cfId('J', 2), cfId('J', 3)]);
    const left = await inA(async (tx) =>
      (await tx.query<{ contenthistid: string }>(`SELECT contenthistid FROM ${handle.schema}.content WHERE contentid = $1 ORDER BY contenthistid`, [id])).rows,
    );
    expect(left.map((row) => row.contenthistid)).toEqual([cfId('J', 1), cfId('J', 4)]);
    expect(await inA((tx) => repo.approvals.requestForVersion(tx, { contentHistId: cfId('J', 2) }))).toBeNull();
    expect(await inA((tx) => repo.approvals.requestForVersion(tx, { contentHistId: cfId('J', 4) }))).not.toBeNull();
    const maps = await inA(async (tx) => (await tx.query(`SELECT * FROM ${handle.schema}.source_map WHERE contentid = $1`, [id])).rows);
    expect(maps).toHaveLength(0);
    const drafts = await inA((tx) => repo.content.deleteDraftHistAll(tx, { contentId: id, siteId: SITE }));
    expect(drafts.versions).toHaveLength(0);
  });

  it('deleteContent reparents children, keeps the home node and returns File extend values', async () => {
    const id = cfId('L', 1);
    await inA(async (tx) => {
      await repo.platform.insert(tx, 'extend_attribute', { attributeid: 501, siteid: SITE, name: 'doc', type: 'File' });
      await repo.platform.insert(tx, 'extend_attribute', { attributeid: 502, siteid: SITE, name: 'txt', type: 'TextBox' });
      await repo.content.insertVersion(tx, version(id, cfId('M', 1), { parentid: cfId('P', 9) }));
      await repo.content.insertVersion(tx, version(cfId('L', 2), cfId('M', 2), { parentid: id }));
      await repo.extend.replaceExtendData(tx, cfId('M', 1), [
        { attributeid: 501, siteid: SITE, attributevalue: cfId('F', 7), stringvalue: cfId('F', 7) },
        { attributeid: 502, siteid: SITE, attributevalue: 'hello' },
      ]);
      await repo.content.upsertRemotePointer(tx, { contentid: id, siteid: SITE, remoteid: 'r', created: 'now' });
      await repo.content.replaceRelatedItems(tx, cfId('M', 9), SITE, [{ contentid: cfId('L', 3), relatedid: id }]);
    });
    const result = await inA((tx) => repo.content.deleteContent(tx, { contentId: id, siteId: SITE, parentId: cfId('P', 9), type: 'Page' }));
    expect(result.versions).toHaveLength(1);
    expect(result.extendFileIds).toEqual([cfId('F', 7)]);
    const parent = await inA(async (tx) =>
      (await tx.query<{ parentid: string }>(`SELECT parentid FROM ${handle.schema}.content WHERE contenthistid = $1`, [cfId('M', 2)])).rows[0],
    );
    expect(parent?.parentid).toBe(cfId('P', 9));
    const related = await inA(async (tx) => (await tx.query(`SELECT * FROM ${handle.schema}.content_related WHERE relatedid = $1`, [id])).rows);
    expect(related).toHaveLength(0);
    const home = await inA((tx) =>
      repo.content.deleteContent(tx, { contentId: '00000000000000000000000000000000001', siteId: SITE, parentId: null, type: 'Page' }),
    );
    expect(home).toEqual({ versions: [], extendFileIds: [] });
  });

  it.each<[string, number, [number, number, number]]>([
    ['Form', 1, [1, 1, 0]],
    ['form', 2, [1, 1, 0]],
    ['COMPONENT', 3, [1, 1, 0]],
    ['page', 4, [0, 0, 1]],
  ])('deleteContent of type %s takes the legacy branch of its type in any case', async (type, n, [pointers, links, placements]) => {
    const id = cfId('L', 10 + n);
    await inA(async (tx) => {
      await repo.content.insertVersion(tx, version(id, cfId('M', 10 + n), { type }));
      await repo.content.upsertRemotePointer(tx, { contentid: id, siteid: SITE, remoteid: `r${n}`, created: 'now' });
      await repo.content.replaceRelatedItems(tx, cfId('M', 30 + n), SITE, [{ contentid: cfId('L', 30 + n), relatedid: id }]);
      await repo.content.replaceObjects(tx, cfId('M', 20 + n), [{ objectid: id, object: 'form', contentid: cfId('L', 20 + n), name: 'n', orderno: 1, siteid: SITE, columnid: 1 }]);
    });
    await inA((tx) => repo.content.deleteContent(tx, { contentId: id, siteId: SITE, parentId: null, type }));
    const left = (table: string, column: string): Promise<number> =>
      inA(async (tx) => (await tx.query(`SELECT 1 FROM ${handle.schema}.${table} WHERE ${column} = $1`, [id])).rows.length);
    expect([await left('content_remote_pointer', 'contentid'), await left('content_related', 'relatedid'), await left('content_object', 'objectid')]).toEqual([
      pointers,
      links,
      placements,
    ]);
  });

  it('selects, replaces and deletes expire and draft assignments in any case, keeping the stored spelling', async () => {
    const id = cfId('N', 31);
    const hist = cfId('N', 32);
    const other = cfId('N', 33);
    const [u1, u2, u3, u4] = [31, 32, 33, 34].map((k) => cfId('U', k)) as [string, string, string, string];
    await inA(async (tx) => {
      await repo.content.insertVersion(tx, version(id, hist));
      await repo.content.insertContentAssignment(tx, { contentid: id, contenthistid: hist, siteid: SITE, userid: u1, type: 'Expire' });
      await repo.content.insertContentAssignment(tx, { contentid: id, contenthistid: other, siteid: SITE, userid: u2, type: 'expire' });
      await repo.content.insertContentAssignment(tx, { contentid: id, contenthistid: other, siteid: SITE, userid: u4, type: 'Draft' });
    });
    const assignments = (): Promise<[string | null, string | null, string | null][]> =>
      inA(async (tx) =>
        (
          await tx.query<{ contenthistid: string; userid: string; type: string }>(
            `SELECT contenthistid, userid, type FROM ${handle.schema}.content_assignment WHERE contentid = $1 ORDER BY userid`,
            [id],
          )
        ).rows.map((row) => [row.contenthistid, row.userid, row.type]),
      );
    await inA((tx) => repo.content.replaceContentAssignments(tx, { contentId: id, contentHistId: hist, siteId: SITE, type: 'EXPIRE', userIds: [u3] }));
    expect(await assignments()).toEqual([[other, u2, 'expire'], [hist, u3, 'EXPIRE'], [other, u4, 'Draft']]);
    await inA((tx) => repo.content.deleteVersion(tx, { contentHistId: hist, siteId: SITE }));
    expect(await assignments()).toEqual([[other, u2, 'expire'], [other, u4, 'Draft']]);
    await inA((tx) => repo.content.deleteContentAssignments(tx, { id, siteId: SITE, type: 'DRAFT' }));
    await inA((tx) => repo.content.deleteContentAssignments(tx, { id: other, siteId: SITE, type: 'eXpire' }));
    expect(await assignments()).toEqual([]);
  });

  it('upserts stats as the stats bean saves them and computes ratings', async () => {
    const key = { contentId: cfId('N', 1), siteId: SITE };
    const created = await inA((tx) => repo.stats.setLock(tx, { ...key, lockId: cfId('U', 2), lockType: 'node' }));
    expect(created).toMatchObject({ views: 0, rating: 0, comments: 0, lockid: cfId('U', 2), locktype: 'node' });
    const cleared = await inA((tx) => repo.stats.clearLock(tx, key));
    expect(cleared.lockid).toBeNull();
    expect(cleared.locktype).toBeNull();
    const versions = await inA((tx) => repo.stats.setVersionNumbers(tx, { ...key, majorVersion: 2, minorVersion: 3 }));
    expect([versions.majorversion, versions.minorversion]).toEqual([2, 3]);
    const ignored = await inA((tx) => repo.stats.upsertStats(tx, { ...key, views: Number.NaN }));
    expect(ignored.views).toBe(0);
    await inA(async (tx) => {
      await repo.comments.insertComment(tx, { contentid: key.contentId, siteid: SITE, isapproved: 1, isspam: 0, isdeleted: 0, entered: NOW, name: 'a' });
      await repo.comments.insertComment(tx, { contentid: key.contentId, siteid: SITE, isapproved: 0, isspam: 0, isdeleted: 0, entered: NOW, name: 'b' });
    });
    expect((await inA((tx) => repo.stats.setCommentCount(tx, key))).comments).toBe(1);
    expect((await inA((tx) => repo.stats.readStats(tx, key)))?.comments).toBe(1);
    await inA(async (tx) => {
      for (const [n, rate] of [[1, 1], [2, 4], [3, 5]] as const) {
        await repo.platform.insert(tx, 'content_rating', { contentid: key.contentId, userid: cfId('U', n), siteid: SITE, rate, entered: NOW });
      }
      await repo.content.insertVersion(tx, version(key.contentId, cfId('N', 2)));
    });
    expect(await inA((tx) => repo.stats.avgRating(tx, key))).toEqual({ theavg: 3, thecount: 3, upvotes: 2, downvotes: 1 });
    expect(await inA((tx) => repo.stats.avgRating(tx, { contentId: cfId('N', 9), siteId: SITE }))).toBeNull();
    expect((await inA((tx) => repo.stats.readRate(tx, { ...key, userId: cfId('U', 2) })))?.rate).toBe(4);
    const top = await inA((tx) => repo.stats.topRated(tx, { siteId: SITE, threshold: 2, limit: 5, startDate: new Date(2026, 5, 30) }));
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ contentid: key.contentId, theavg: 3, thecount: 3 });
    expect(await inA((tx) => repo.stats.topRated(tx, { siteId: SITE, threshold: 4 }))).toHaveLength(0);
  });

  it('writes files as fileDAO does and marks only a one-element unused list deleted', async () => {
    const file = await inA((tx) => repo.files.insertFile(tx, { siteid: SITE, contentid: cfId('W', 1), filename: 'a.PDF', fileext: 'PDF', caption: '' }));
    expect(file).toMatchObject({ fileext: 'pdf', moduleid: TREE, filesize: 0, deleted: 0, caption: null, image: null });
    expect(file.created).toEqual(NOW);
    const second = await inA((tx) => repo.files.insertFile(tx, { siteid: SITE, fileext: 'txt' }));
    await inA((tx) => repo.content.insertVersion(tx, version(cfId('W', 1), cfId('V', 1), { fileid: file.fileid })));
    await inA((tx) => repo.content.insertVersion(tx, version(cfId('W', 1), cfId('V', 2), { fileid: file.fileid, active: 0 })));
    const both = await inA((tx) => repo.files.deleteAllForContent(tx, { contentId: cfId('W', 1) }));
    expect(both.versionFiles).toHaveLength(2);
    expect(both.deletedFileIds).toEqual([]);
    expect(await inA((tx) => repo.files.deleteIfNotUsed(tx, { fileIds: [second.fileid], baseIds: [] }))).toEqual([second.fileid]);
    expect(await inA((tx) => repo.files.deleteIfNotUsed(tx, { fileIds: [file.fileid], baseIds: [cfId('V', 1)] }))).toEqual([]);
    expect(await inA((tx) => repo.files.deleteIfNotUsed(tx, { fileIds: [file.fileid], baseIds: [cfId('V', 1), cfId('V', 2)], referencedElsewhere: ['x'] }))).toEqual([]);
    expect(await inA((tx) => repo.files.deleteIfNotUsed(tx, { fileIds: [file.fileid], baseIds: [cfId('V', 1), cfId('V', 2)] }))).toEqual([file.fileid]);
    expect((await inA((tx) => repo.files.restoreVersion(tx, { fileId: file.fileid })))[0]?.deleted).toBe(0);
    const purged = await inA((tx) => repo.files.purgeDeleted(tx, { siteId: SITE }));
    expect(purged.map((row) => row.fileid)).toEqual([second.fileid]);
    const updated = await inA((tx) => repo.files.updateFile(tx, file.fileid, { caption: 'Cap', alttext: '' }));
    expect(updated).toMatchObject({ caption: 'Cap', alttext: null });
    const object = await inA((tx) =>
      repo.files.upsertFileObject(tx, { file_id: file.fileid, variant: '', ext: 'pdf', object_key: `k/${file.fileid}.pdf`, size: 12, sha256: 'a'.repeat(64), content_type: 'application/pdf' }),
    );
    expect(object).toMatchObject({ size: '12', orphan: false });
    expect(await inA((tx) => repo.files.findFileObject(tx, file.fileid, ''))).not.toBeNull();
    expect(await inA((tx) => repo.files.deleteFileObject(tx, { objectKey: `k/${file.fileid}.pdf` }))).not.toBeNull();
    const meta = await inA((tx) => repo.files.insertFileMetadata(tx, { fileid: file.fileid, contenthistid: cfId('V', 1), siteid: SITE }));
    expect((await inA((tx) => repo.files.updateFileMetadata(tx, meta.metaid, { caption: 'c' })))?.caption).toBe('c');
    expect(await inA((tx) => repo.files.deleteFileMetadata(tx, { metaId: meta.metaid }))).not.toBeNull();
  });

  it('writes feeds with their items and params; delete keeps the children as legacy does', async () => {
    const feed = await inA((tx) =>
      repo.feeds.insertFeed(
        tx,
        { siteid: SITE, name: 'News', description: '', isactive: 1, lastupdate: 'x' as never },
        { contentIds: [cfId('A', 1), ''], categoryIds: [cfId('K', 1)], advancedParams: [{ param: 1, relationship: 'and', field: 'tcontent.title', datatype: 'varchar', condition: 'like', criteria: 'x' }] },
      ),
    );
    expect(feed).toMatchObject({ name: 'News', description: null, lastupdate: null });
    const items = await inA(async (tx) => (await tx.query(`SELECT itemid, type FROM ${handle.schema}.feed_item WHERE feedid = $1 ORDER BY type`, [feed.feedid])).rows);
    expect(items).toEqual([
      { itemid: cfId('K', 1), type: 'categoryID' },
      { itemid: cfId('A', 1), type: 'contentID' },
    ]);
    const updated = await inA((tx) => repo.feeds.updateFeed(tx, feed.feedid, { name: 'Renamed' }, { contentIds: [cfId('A', 2)] }));
    expect(updated?.name).toBe('Renamed');
    const after = await inA(async (tx) => (await tx.query(`SELECT itemid FROM ${handle.schema}.feed_item WHERE feedid = $1`, [feed.feedid])).rows);
    expect(after).toEqual([{ itemid: cfId('A', 2) }]);
    const params = await inA(async (tx) => (await tx.query(`SELECT param FROM ${handle.schema}.feed_advanced_param WHERE feedid = $1`, [feed.feedid])).rows);
    expect(params).toHaveLength(1);
    expect(await inA((tx) => repo.feeds.updateFeed(tx, cfId('Z', 3), { name: 'x' }))).toBeNull();
    expect(await inA((tx) => repo.feeds.deleteFeed(tx, { feedId: feed.feedid }))).not.toBeNull();
    const orphans = await inA(async (tx) => (await tx.query(`SELECT itemid FROM ${handle.schema}.feed_item WHERE feedid = $1`, [feed.feedid])).rows);
    expect(orphans).toHaveLength(1);
  });

  it('writes and reads comments as the comment bean and manager do', async () => {
    const contentId = cfId('O', 1);
    const root = await inA((tx) =>
      repo.comments.insertComment(tx, { contentid: contentId, siteid: SITE, name: 'Ann', email: 'a@x.test', url: '', entered: new Date(2026, 5, 1), isapproved: 1, isspam: 0, isdeleted: 0, flagcount: 0, subscribe: 0, parentid: '' }),
    );
    expect(root).toMatchObject({ url: null, parentid: null });
    await inA((tx) => repo.comments.updateComment(tx, root.commentid, { path: root.commentid }));
    const reply = await inA((tx) =>
      repo.comments.insertComment(tx, { contentid: contentId, siteid: SITE, name: 'Bob', email: 'A@X.test', entered: new Date(2026, 5, 2), isapproved: 1, isspam: 0, isdeleted: 0, parentid: root.commentid, path: `${root.commentid},X` }),
    );
    await inA((tx) => repo.comments.updateComment(tx, reply.commentid, { path: `${root.commentid},${reply.commentid}` }));
    expect((await inA((tx) => repo.comments.incrementFlagCount(tx, { commentId: root.commentid })))?.flagcount).toBe(1);
    const subscribed = await inA((tx) => repo.comments.setSubscribe(tx, { contentId, siteId: SITE, email: 'a@x.TEST', subscribe: 1 }));
    expect(subscribed).toHaveLength(2);
    expect(await inA((tx) => repo.comments.commentSubscribers(tx, { contentId, siteId: SITE }))).toHaveLength(2);
    const roots = await inA((tx) => repo.comments.listComments(tx, { contentId, siteId: SITE, includeKids: true }));
    expect(roots.map((row) => [row.commentid, row.kids])).toEqual([[root.commentid, 1]]);
    const kids = await inA((tx) => repo.comments.commentKids(tx, { commentId: root.commentid, contentId, siteId: SITE }));
    expect(kids.map((row) => row.commentid)).toEqual([reply.commentid]);
    const crumbs = await inA((tx) => repo.comments.commentCrumbs(tx, { path: `${root.commentid},${reply.commentid}` }));
    expect(crumbs.map((row) => row.commentid)).toEqual([root.commentid, reply.commentid]);
    const found = await inA((tx) => repo.comments.findComment(tx, { commentId: root.commentid.toLowerCase() }));
    expect(found).toMatchObject({ commentid: root.commentid, kids: null, flagcount: 1 });
    await inA((tx) => repo.comments.setSpam(tx, { commentId: reply.commentid, isSpam: 1 }));
    expect(await inA((tx) => repo.comments.commentCount(tx, { contentId, siteId: SITE }))).toBe(1);
    expect(await inA((tx) => repo.comments.commentCount(tx, { contentId, siteId: SITE, includeSpam: true }))).toBe(2);
    const feed = await inA((tx) => repo.comments.commentFeed(tx, { siteId: SITE, contentId, sortBy: 'Entered', sortDirection: 'DESC', maxItems: 1 }));
    expect(feed.map((row) => row.commentid)).toEqual([reply.commentid]);
    const keyword = await inA((tx) => repo.comments.commentFeed(tx, { siteId: SITE, keywords: 'ann' }));
    expect(keyword.map((row) => row.commentid)).toEqual([root.commentid]);
    await expect(inA((tx) => repo.comments.commentFeed(tx, { siteId: SITE, sortBy: 'nope' }))).rejects.toThrow(/Invalid column/);
    await expect(inA((tx) => repo.comments.recentComments(tx, { siteId: SITE }))).rejects.toThrow(/approved/);
    expect(await inA((tx) => repo.comments.recentComments(tx, { siteId: SITE, approvedOnly: false, size: 1 }))).toHaveLength(1);
    await inA((tx) => repo.comments.setDeleted(tx, { commentId: reply.commentid, isDeleted: 1 }));
    expect((await inA((tx) => repo.comments.purgeDeleted(tx, { siteId: SITE }))).map((row) => row.commentid)).toEqual([reply.commentid]);
    const commenter = await inA((tx) => repo.comments.upsertCommenter(tx, { email: 'a@x.test', name: 'Ann' }));
    expect(commenter.commenterid).toHaveLength(35);
  });

  it('writes and reads categories as categoryDAO and categoryGateway do', async () => {
    const parent = await inA((tx) => repo.categories.insertCategory(tx, { siteid: SITE, name: 'Parent', path: '', isopen: 1 }));
    expect(parent).toMatchObject({ isinterestgroup: 0, isactive: 0, isopen: 1, path: null, datecreated: null });
    await inA((tx) => repo.categories.updateCategory(tx, parent.categoryid, { path: `'${parent.categoryid}'`, isinterestgroup: 1, filename: 'parent' }));
    const child = await inA((tx) =>
      repo.categories.insertCategory(tx, { siteid: SITE, name: 'child', parentid: parent.categoryid, path: `'${parent.categoryid}','X'`, isinterestgroup: 1 }),
    );
    const list = await inA((tx) => repo.categories.listCategories(tx, { siteId: SITE }));
    expect(list.map((row) => [row.name, row.haskids])).toEqual([['Parent', 1]]);
    expect(await inA((tx) => repo.categories.categoryCount(tx, { siteId: SITE }))).toBe(2);
    expect(await inA((tx) => repo.categories.interestGroupCount(tx, { siteId: SITE }))).toBe(2);
    expect((await inA((tx) => repo.categories.categoriesBySite(tx, { siteId: SITE, keywords: 'CHI' }))).map((row) => row.name)).toEqual(['child']);
    expect(await inA((tx) => repo.categories.descendantIds(tx, parent.categoryid))).toHaveLength(2);
    const groups = await inA((tx) => repo.categories.privateInterestGroups(tx, { sites: [{ siteId: SITE, site: 'Site A' }] }));
    expect(groups).toEqual([expect.objectContaining({ site: 'Site A', name: 'Parent', haskids: 1 })]);
    expect(await inA((tx) => repo.categories.filenameInUse(tx, { categoryId: child.categoryid, filename: 'PARENT', siteId: SITE }))).toBe(true);
    expect(await inA((tx) => repo.categories.filenameInUse(tx, { categoryId: parent.categoryid, filename: 'parent', siteId: SITE }))).toBe(false);
    const crumbs = await inA((tx) => repo.categories.crumbQuery(tx, { path: `${parent.categoryid},${child.categoryid}`, siteId: SITE }));
    expect(crumbs.map((row) => row.categoryid)).toEqual([parent.categoryid, child.categoryid]);
    const renamed = await inA((tx) => repo.categories.replacePathPrefix(tx, { siteId: SITE, currentPath: `'${parent.categoryid}'`, newPath: `'Y'` }));
    expect(renamed.map((row) => row.path).sort()).toEqual([`'Y'`, `'Y','X'`]);
    const contentId = cfId('Y', 1);
    await inA((tx) => repo.content.insertVersion(tx, version(contentId, cfId('Y', 2), { display: 1 })));
    const demoted = await inA((tx) =>
      repo.categories.setAssignment(tx, { categoryId: parent.categoryid, contentId, contentHistId: cfId('Y', 2), isFeature: 2, orderNo: 1, siteId: SITE }),
    );
    expect(demoted).toMatchObject({ isfeature: 1, featurestart: null });
    await inA((tx) =>
      repo.categories.setAssignment(tx, {
        categoryId: child.categoryid, contentId, contentHistId: cfId('Y', 2), isFeature: 2, orderNo: 4, siteId: SITE,
        featureStart: new Date(2026, 0, 1, 8, 30, 15), featureStop: new Date(2027, 0, 1, 8, 30, 15),
      }),
    );
    const pushed = await inA((tx) => repo.categories.pushCategory(tx, { categoryId: parent.categoryid, siteIds: [SITE] }));
    expect(pushed[0]?.orderno).toBe(2);
    await inA((tx) => repo.categories.setListOrder(tx, { categoryId: child.categoryid, items: [{ contentId, orderNo: 7 }], siteIds: [SITE] }));
    expect(await inA((tx) => repo.categories.currentOrderNo(tx, { contentId, categoryId: child.categoryid, siteIds: [SITE] }))).toBe(7);
    expect(await inA((tx) => repo.categories.currentOrderNo(tx, { contentId, categoryId: cfId('Z', 5), siteIds: [SITE] }))).toBe(0);
    const live = await inA((tx) => repo.categories.liveCategoryFeatures(tx, { categoryId: child.categoryid, sortBy: 'orderno', sortDirection: 'asc' }));
    expect(live.map((row) => [row.contentid, row.orderno, row.featurestart])).toEqual([[contentId, 7, new Date(2026, 0, 1, 8, 30, 0)]]);
    expect(await inA((tx) => repo.categories.categoryFeatures(tx, { categoryId: parent.categoryid, sortBy: 'menutitle', sortDirection: 'desc' }))).toHaveLength(1);
    await expect(inA((tx) => repo.categories.categoryFeatures(tx, { categoryId: parent.categoryid, sortBy: 'bogus', sortDirection: 'asc' }))).rejects.toThrow(/Invalid/);
    const kept = await inA((tx) =>
      repo.categories.keepCategories(tx, cfId('Y', 3), [{ categoryid: child.categoryid, contentid: contentId, siteid: SITE, orderno: 7, isfeature: 0, featurestart: new Date() }]),
    );
    expect(kept[0]).toMatchObject({ contenthistid: cfId('Y', 3), featurestart: null });
    const removed = await inA((tx) => repo.categories.deleteCategory(tx, { categoryId: parent.categoryid, parentId: '' }));
    expect(removed?.categoryid).toBe(parent.categoryid);
    expect((await inA((tx) => repo.categories.readCategory(tx, { categoryId: child.categoryid })))[0]?.parentid).toBeNull();
    expect(await inA((tx) => repo.categories.readCategory(tx, { name: 'CHILD', siteId: SITE }))).toHaveLength(1);
  });

  it('writes and queries change sets as changesetManager does', async () => {
    const due = await inA((tx) =>
      repo.changesets.insertChangeset(tx, { siteid: SITE, name: 'b-due', published: 0, publishdate: new Date(2026, 5, 29, 8, 0, 33) }, { categoryIds: [cfId('K', 1), cfId('K', 1).toLowerCase()], tags: ['t1', 'T1', 't2'] }),
    );
    expect(due.publishdate).toEqual(new Date(2026, 5, 29, 8, 0, 0));
    expect(due.created).toEqual(NOW);
    expect(await inA((tx) => repo.changesets.assignedCategoryIds(tx, { changesetId: due.changesetid }))).toHaveLength(1);
    expect(await inA((tx) => repo.changesets.assignedTags(tx, { changesetId: due.changesetid }))).toEqual(['t1', 't2']);
    const early = await inA((tx) => repo.changesets.insertChangeset(tx, { siteid: SITE, name: 'a-early', published: 0, publishdate: new Date(2026, 5, 1) }));
    await inA((tx) => repo.changesets.insertChangeset(tx, { siteid: SITE, name: 'c-future', published: 0, publishdate: new Date(2026, 6, 1) }));
    await inA((tx) => repo.changesets.insertChangeset(tx, { siteid: SITE, name: 'd-done', published: 1, publishdate: new Date(2026, 4, 1) }));
    await inA((tx) => repo.changesets.insertChangeset(tx, { siteid: SITE, name: 'e-undated', published: 0 }));
    expect(await inA((tx) => repo.changesets.pendingScheduledChangesets(tx, NOW))).toEqual([early.changesetid, due.changesetid]);
    const byPublished = await inA((tx) => repo.changesets.changesetQuery(tx, { siteId: SITE }));
    expect(byPublished.map((row) => row.name)).toEqual(['a-early', 'b-due', 'c-future', 'e-undated', 'd-done']);
    const byDate = await inA((tx) => repo.changesets.changesetQuery(tx, { siteId: SITE, sortBy: 'PublishDate', published: 0, publishDate: new Date(2026, 5, 15), publishDateOnly: false }));
    expect(byDate.map((row) => row.name)).toEqual(['c-future', 'b-due', 'e-undated']);
    await expect(inA((tx) => repo.changesets.changesetQuery(tx, { siteId: SITE, tag: 't1' }))).rejects.toThrow(/tchangesettagassign/);
    const updated = await inA((tx) => repo.changesets.updateChangeset(tx, due.changesetid, { name: 'b-due2' }, { tags: ['t3'] }));
    expect(updated?.name).toBe('b-due2');
    expect(await inA((tx) => repo.changesets.assignedTags(tx, { changesetId: due.changesetid }))).toEqual(['t3']);
    expect(await inA((tx) => repo.changesets.assignedCategoryIds(tx, { changesetId: due.changesetid }))).toEqual([]);
    const published = await inA((tx) => repo.changesets.markPublished(tx, { changesetId: due.changesetid }));
    expect(published).toMatchObject({ published: 1, publishdate: new Date(2026, 5, 30, 10, 15, 0) });
    const rollback = { changesetid: due.changesetid, changesethistid: cfId('H', 81), previoushistid: cfId('H', 80), siteid: SITE };
    const first = await inA((tx) => repo.changesets.insertRollback(tx, rollback));
    expect((await inA((tx) => repo.changesets.insertRollback(tx, rollback))).rollbackid).toBe(first.rollbackid);
    expect(await inA((tx) => repo.changesets.rollbackRows(tx, { changesetId: due.changesetid, siteId: SITE }))).toHaveLength(1);
    await inA(async (tx) => {
      await repo.content.insertVersion(tx, version(cfId('I', 1), cfId('I', 2), { changesetid: early.changesetid, menutitle: 'zz', title: 'Find me' }));
      await repo.approvals.insertRequest(tx, { contenthistid: cfId('I', 2), status: 'Pending', siteid: SITE });
    });
    expect(await inA((tx) => repo.changesets.hasPendingApprovals(tx, { changesetId: early.changesetid }))).toBe(1);
    const assignments = await inA((tx) => repo.changesets.assignmentsQuery(tx, { changesetId: early.changesetid, keywords: 'FIND' }));
    expect(assignments.map((row) => [row.contenthistid, row.approvalstatus])).toEqual([[cfId('I', 2), 'Pending']]);
    const pending = await inA((tx) => repo.changesets.pendingByContentId(tx, { contentId: cfId('I', 1), siteId: SITE }));
    expect(pending[0]).toMatchObject({ changesetname: 'a-early', approvalstatus: 'Pending' });
    expect(await inA((tx) => repo.changesets.removeItem(tx, { changesetId: early.changesetid, contentHistId: cfId('I', 2) }))).toHaveLength(1);
    expect((await inA((tx) => repo.changesets.changesetTagCloud(tx))).map((row) => [row.tag, row.tagcount])).toEqual([['t3', 1]]);
    expect(await inA((tx) => repo.changesets.findChangeset(tx, { name: 'B-DUE2', siteId: SITE }))).not.toBeNull();
    expect(await inA((tx) => repo.changesets.deleteChangeset(tx, { changesetId: due.changesetid }))).not.toBeNull();
    expect(await inA((tx) => repo.changesets.assignedTags(tx, { changesetId: due.changesetid }))).toEqual([]);
  });

  it('saves approval chains and memberships as approvalChainBean.save does', async () => {
    const chain = await inA((tx) => repo.approvals.insertChain(tx, { siteid: SITE, name: 'Chain', description: '' }));
    expect(chain).toMatchObject({ lastupdate: NOW, description: null });
    const [g1, g2, g3] = [cfId('A', 71), cfId('A', 72), cfId('A', 73)];
    await inA((tx) => repo.approvals.replaceChainMemberships(tx, chain.chainid, [g1, g2]));
    const r1 = await inA((tx) => repo.approvals.insertRequest(tx, { contenthistid: cfId('H', 91), chainid: chain.chainid, groupid: g2, siteid: SITE }));
    const r2 = await inA((tx) => repo.approvals.insertRequest(tx, { contenthistid: cfId('H', 92), chainid: chain.chainid, groupid: '', siteid: SITE }));
    expect(r2.groupid).toBeNull();
    await inA((tx) => repo.approvals.insertAction(tx, { requestid: r1.requestid, chainid: chain.chainid, actiontype: 'Approve', siteid: SITE }));
    const { memberships, removed } = await inA((tx) => repo.approvals.replaceChainMemberships(tx, chain.chainid, [g3, g1]));
    expect(memberships.map((row) => [row.groupid, row.orderno])).toEqual([[g3, 1], [g1, 2]]);
    expect(removed.map((row) => row.groupid)).toEqual([g2]);
    const listed = await inA((tx) => repo.approvals.chainMemberships(tx, { chainId: chain.chainid }));
    expect(listed.map((row) => row.groupid)).toEqual([g3, g1]);
    // The joined list never equals a single group id, so every request moves to the first group.
    expect((await inA((tx) => repo.approvals.requestForVersion(tx, { contentHistId: cfId('H', 91) })))?.groupid).toBe(g3);
    expect((await inA((tx) => repo.approvals.requestForVersion(tx, { contentHistId: cfId('H', 92) })))?.groupid).toBe(g3);
    expect(await inA((tx) => repo.approvals.requestsByStatus(tx, { status: 'pending', chainId: chain.chainid }))).toHaveLength(2);
    expect(await inA((tx) => repo.approvals.actionsForRequest(tx, { requestId: r1.requestid }))).toHaveLength(1);
    expect((await inA((tx) => repo.approvals.updateChain(tx, chain.chainid, { name: 'Renamed' })))?.name).toBe('Renamed');
    const assignment = await inA((tx) => repo.approvals.upsertAssignment(tx, { contentid: cfId('C', 1), chainid: chain.chainid, siteid: SITE }));
    expect((await inA((tx) => repo.approvals.assignmentFor(tx, { contentId: cfId('C', 1), siteId: SITE })))?.assignmentid).toBe(assignment.assignmentid);
    expect(await inA((tx) => repo.approvals.listChains(tx, { siteId: SITE }))).toHaveLength(1);
    expect(await inA((tx) => repo.approvals.deleteChain(tx, { chainId: chain.chainid }))).not.toBeNull();
    expect(await inA((tx) => repo.approvals.requestsByStatus(tx, { status: 'Pending', chainId: chain.chainid }))).toHaveLength(0);
    expect(await inA((tx) => repo.approvals.actionsForRequest(tx, { requestId: r1.requestid }))).toHaveLength(0);
    expect(await inA((tx) => repo.approvals.chainMemberships(tx, { chainId: chain.chainid }))).toHaveLength(0);
  });

  it('writes form responses byte-exact and filters them as getData does', async () => {
    const formId = cfId('B', 51);
    const data = '<wddxPacket version="1.0"><data><struct><var name="A"><string>x</string></var></struct></data></wddxPacket>';
    const long = 'v'.repeat(300);
    const first = await inA((tx) =>
      repo.forms.insertResponse(tx, {
        formid: formId, siteid: SITE, entered: new Date(2026, 5, 1), data, fieldlist: 'name,attachment1',
        questions: [{ formfield: 'name', formvalue: long }, { formfield: 'attachment1', formvalue: cfId('F', 51) }],
      }),
    );
    expect(first.packet.data).toBe(data);
    expect(first.questions[0]?.pollvalue).toHaveLength(255);
    await inA((tx) =>
      repo.forms.insertResponse(tx, { formid: formId, siteid: SITE, entered: new Date(2026, 5, 2), data: 'b', fieldlist: 'name', questions: [{ formfield: 'name', formvalue: 'alpha' }] }),
    );
    const byField = await inA((tx) => repo.forms.responses(tx, { formId, siteId: SITE, fieldNames: ['name'], sortBy: 'name', sortDirection: 'asc' }));
    expect(byField.map((row) => row.data)).toEqual(['b', data]);
    const byKeyword = await inA((tx) => repo.forms.responses(tx, { formId, siteId: SITE, keywords: 'ALPHA' }));
    expect(byKeyword.map((row) => row.data)).toEqual(['b']);
    expect(await inA((tx) => repo.forms.responses(tx, { formId, siteId: SITE, keywords: 'alp' }))).toHaveLength(0);
    expect(await inA((tx) => repo.forms.fullFieldList(tx, { formId }))).toBe('attachment1,name');
    await inA((tx) => repo.content.insertVersion(tx, version(formId, cfId('B', 52), { type: 'Form', responsedisplayfields: '~name^email' })));
    expect(await inA((tx) => repo.forms.currentFieldList(tx, { formId }))).toBe('name,email');
    const updated = await inA((tx) =>
      repo.forms.updateResponse(tx, { responseid: first.packet.responseid, formid: formId, siteid: SITE, entered: first.packet.entered as Date, data: 'c', fieldlist: 'name', questions: [{ formfield: 'name', formvalue: 'z' }] }),
    );
    expect(updated.packet.responseid).toBe(first.packet.responseid);
    const deleted = await inA((tx) => repo.forms.deleteResponse(tx, { responseId: first.packet.responseid }));
    expect(deleted.attachmentFileIds).toEqual([]);
    expect((await inA((tx) => repo.forms.readResponse(tx, { responseId: first.packet.responseid })))).toBeNull();
    const withFile = await inA((tx) =>
      repo.forms.insertResponse(tx, { formid: formId, siteid: SITE, entered: NOW, data: 'd', fieldlist: 'attachment1', questions: [{ formfield: 'Attachment1', formvalue: cfId('F', 52) }] }),
    );
    expect((await inA((tx) => repo.forms.deleteResponse(tx, { responseId: withFile.packet.responseid }))).attachmentFileIds).toEqual([cfId('F', 52)]);
  });

  it('writes extend data per attribute and reads definitions', async () => {
    const base = cfId('X', 61);
    await inA(async (tx) => {
      await repo.platform.insert(tx, 'extend_subtype', { subtypeid: cfId('Q', 61), siteid: SITE, type: 'Page', subtype: 'Default', basetable: 'tcontent' });
      await repo.platform.insert(tx, 'extend_set', { extendsetid: cfId('Q', 62), subtypeid: cfId('Q', 61), siteid: SITE, name: 'set', orderno: 1 });
      await repo.platform.insert(tx, 'extend_attribute', { attributeid: 601, extendsetid: cfId('Q', 62), siteid: SITE, name: 'b', type: 'File', orderno: 2 });
      await repo.platform.insert(tx, 'extend_attribute', { attributeid: 602, extendsetid: cfId('Q', 62), siteid: SITE, name: 'a', type: 'TextBox', orderno: 1 });
      await repo.platform.insert(tx, 'extend_rc_set', { relatedcontentsetid: cfId('Q', 63), subtypeid: cfId('Q', 61), siteid: SITE, name: 'rc', orderno: 1 });
      await repo.extend.replaceExtendData(tx, base, [{ attributeid: 601, siteid: SITE, attributevalue: cfId('F', 61) }, { attributeid: 602, siteid: SITE, attributevalue: 'one' }]);
      await repo.extend.replaceExtendData(tx, base, [{ attributeid: 602, siteid: SITE, attributevalue: 'two' }]);
    });
    const values = await inA((tx) => repo.extend.extendDataFor(tx, { baseId: base }));
    expect(values.map((row) => [row.attributeid, row.attributevalue])).toEqual([[601, cfId('F', 61)], [602, 'two']]);
    expect(values.every((row) => row.dataid < 0)).toBe(true);
    const detail = await inA((tx) => repo.extend.extendDataDetail(tx, { baseId: base }));
    expect(detail.map((row) => row.name)).toEqual(['b', 'a']);
    expect((await inA((tx) => repo.extend.subtypes(tx, { siteId: SITE, type: 'PAGE' }))).map((row) => row.subtypeid)).toEqual([cfId('Q', 61)]);
    expect(await inA((tx) => repo.extend.setsForSubtype(tx, { subTypeId: cfId('Q', 61) }))).toHaveLength(1);
    expect((await inA((tx) => repo.extend.attributesForSet(tx, { extendSetId: cfId('Q', 62) }))).map((row) => row.name)).toEqual(['a', 'b']);
    expect(await inA((tx) => repo.extend.rcsetsForSubtype(tx, { subTypeId: cfId('Q', 61) }))).toHaveLength(1);
    expect(await inA((tx) => repo.extend.deleteExtendDataForBase(tx, base))).toEqual([cfId('F', 61)]);
    expect(await inA((tx) => repo.extend.extendDataFor(tx, { baseId: base }))).toHaveLength(0);
  });

  it('keeps keyless queue multiplicity, targeting, trash and projections', async () => {
    const contentId = cfId('Q', 71);
    await inA(async (tx) => {
      await repo.approvalQueues.insertSubmissionApproval(tx, { contentId, email: 'x@y.test', siteId: SITE });
      await repo.approvalQueues.insertSubmissionApproval(tx, { contentId, email: 'x@y.test', siteId: SITE });
    });
    expect(await inA((tx) => repo.approvalQueues.pendingSubmissionApprovals(tx, { contentHistId: contentId }))).toHaveLength(2);
    const { result, changes } = await newChanges(() => inA((tx) => repo.approvalQueues.approveSubmission(tx, { contentId })));
    expect(result.map((row) => [row.isapproved, row.occurrence]).sort()).toEqual([[1, 1], [1, 2]]);
    expect(changes.map((change) => change.op)).toEqual(['update', 'update']);
    expect(await inA((tx) => repo.approvalQueues.pendingSubmissionApprovals(tx, { contentHistId: contentId }))).toHaveLength(0);
    expect(await inA((tx) => repo.approvalQueues.displayTitleApprovals(tx, { contentId }))).toEqual([]);
    const targeting = await inA((tx) => repo.variation.upsertTargeting(tx, { contentid: contentId, siteid: SITE, initjs: 'a()' }));
    expect((await inA((tx) => repo.variation.targetingFor(tx, { contentId, siteId: SITE })))?.initjs).toBe('a()');
    expect(await inA((tx) => repo.variation.deleteTargeting(tx, { targetingId: targeting.targetingid }))).not.toBeNull();
    const trashRow = { objectid: contentId, siteid: SITE, objectclass: 'content', objecttype: 'Page', objectsubtype: 'Default', objectlabel: 'L', parentid: cfId('P', 1), deletedby: 'Admin', deleteid: cfId('D', 71), orderno: 1, deleteddate: NOW, objectstring: '<wddx/>' };
    expect(await inA((tx) => repo.trash.insertTrashIfAbsent(tx, trashRow))).not.toBeNull();
    expect(await inA((tx) => repo.trash.insertTrashIfAbsent(tx, trashRow))).toBeNull();
    expect(await inA((tx) => repo.trash.trashFor(tx, { siteId: SITE, objectClass: 'CONTENT', keywords: 'adm' }))).toHaveLength(1);
    expect((await inA((tx) => repo.trash.trashItem(tx, { objectId: contentId })))?.objectstring).toBe('<wddx/>');
    const [g1, g2] = [cfId('G', 81), cfId('G', 82)];
    await inA(async (tx) => {
      await repo.projections.upsertGroupProjection(tx, { groupId: g1, siteId: SITE, groupName: 'Editors', isPublic: 0, deleted: false });
      await repo.projections.upsertGroupProjection(tx, { groupId: g1, siteId: SITE, groupName: 'Editors 2', isPublic: 0, deleted: false });
      await repo.projections.replaceGroupPermissions(tx, g1, SITE, [{ contentId: 'node1', siteId: SITE, type: 'Editor' }, { contentId: 'node1', siteId: SITE, type: 'Editor' }]);
      await repo.projections.replaceGroupPermissions(tx, g1, SITE, [{ contentId: 'node2', siteId: SITE, type: 'Read' }]);
      await repo.projections.replaceUserMemberships(tx, cfId('U', 81), SITE, [g1, g2]);
      await repo.projections.replaceUserMemberships(tx, cfId('U', 81), SITE, [g2]);
    });
    expect((await inA((tx) => repo.projections.groupNames(tx, [g1])))[0]).toMatchObject({ group_name: 'Editors 2', deleted: false });
    expect((await inA((tx) => repo.projections.markGroupDeleted(tx, g1)))?.deleted).toBe(true);
    expect(await inA((tx) => repo.projections.groupsOfUser(tx, cfId('U', 81)))).toEqual([g2]);
    const verdicts = await inA((tx) => repo.projections.permissionsForNodes(tx, { siteId: SITE, contentIds: ['node1', 'node2'] }));
    expect(verdicts.map((row) => [row.content_id, row.type])).toEqual([['node2', 'Read']]);
    await inA((tx) => repo.projections.replaceUserMemberships(tx, cfId('U', 81), SITE, []));
    expect(await inA((tx) => repo.projections.groupsOfUser(tx, cfId('U', 81)))).toEqual([]);
  });

  it('isolates tenants, rejects calls outside a tenant transaction and honours legacy gates', async () => {
    const histA = cfId('H', 1);
    expect(await inB((tx) => repo.content.updateVersion(tx, histA, { menutitle: 'B' }))).toBeNull();
    expect(await inB((tx) => repo.categories.listCategories(tx, { siteId: SITE }))).toEqual([]);
    expect(await inB((tx) => repo.projections.groupsOfUser(tx, cfId('U', 81)))).toEqual([]);
    const own = await inB((tx) => repo.content.insertVersion(tx, version(cfId('C', 1), cfId('H', 1), { siteid: TENANT_B.siteId })));
    expect(own.siteid).toBe(TENANT_B.siteId);
    expect((await inA((tx) => repo.content.archiveActive(tx, { contentId: cfId('C', 1), siteId: TENANT_B.siteId })))).toEqual([]);
    const fake = { kind: 'tenant', tenantId: TENANT_A.tenantId, schema: handle.schema, query: () => Promise.reject(new Error('no')), onCommit: () => undefined } as unknown as TenantTx;
    await expect(repo.content.updateVersion(fake, histA, { menutitle: 'x' })).rejects.toBeInstanceOf(OutsideTenantTransactionError);
    await setGates('legacy', ['content.content']);
    try {
      await expect(inA((tx) => repo.content.updateVersion(tx, histA, { menutitle: 'x' }))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    } finally {
      await setGates('open', ['content.content']);
    }
    const other = createContentRepository({ clock: fixedClock(NOW) });
    await expect(inA((tx) => other.content.updateVersion(tx, histA, { menutitle: 'x' }))).rejects.toThrow(/needs a tenant transaction on schema content/);
  });
});
