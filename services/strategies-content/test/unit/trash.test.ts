/** domain/trash: throwIn's ttrash row rules and changelog over a throwaway `content` schema, the shared captured change-set packet, and the no-op takeOut. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import {
  TAKEOUT_UNBUILT,
  createTrashCounter,
  deleteMarkerAssignments,
  deleteMarkers,
  deletedParentId,
  takeOut,
  throwIn,
  trashObjectSubType,
  trashObjectType,
  type TrashEntry,
} from '../../src/domain/trash.js';
import { WddxNumber, cfStruct, wddx2cfml, wddxStruct, wddxStructGet, type WddxStruct, type WddxValue } from '../../src/domain/wddx.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const CHANGESET_TRASH = readFileSync(new URL('../fixtures/legacy-trash/changeset-trash.wddx', import.meta.url), 'utf8');
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 10, 10, 18, 29, 32, 456);
const SITE = TENANT_A.siteId;

const CLAIMS: UserClaims = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: cfId('U', 1),
  sid: 'session-1',
  tid: TENANT_A.tenantId,
  site: SITE,
  roles: ['s2'],
  s2: true,
  epoch: 1,
  iat: 0,
  exp: 0,
};
const actor = (fullName: string): Actor => actorFromClaims(CLAIMS, fullName);

const text = (values: WddxStruct, key: string): string => wddxStructGet(values, key) as string;

describe('trash value rules', () => {
  it.each<[string, Array<[string, WddxValue]>, string]>([
    ['deletedParentID first', [['parentID', 'P'], ['deletedParentID', 'D']], 'D'],
    ['deletedParentID even when empty', [['DELETEDPARENTID', ''], ['parentID', 'P']], ''],
    ['parentID next, any case', [['PARENTID', 'P']], 'P'],
    ['a numeric parent id as its text', [['parentID', new WddxNumber('7.0')]], '7.0'],
    ['NA otherwise', [['contentID', 'C']], 'NA'],
  ])('deletedParentId: %s', (_label, entries, expected) => {
    expect(deletedParentId(wddxStruct(entries))).toBe(expected);
  });

  it('deletedParentId fails fast on a non-simple parent id', () => {
    expect(() => deletedParentId(wddxStruct([['parentID', wddxStruct([])]]))).toThrow(TypeError);
  });

  it.each<[string, Array<[string, WddxValue]>, string, string, string]>([
    ['content', [['TYPE', 'Page'], ['SUBTYPE', 'Default']], 'content', 'Page', 'Default'],
    ['feed (its type, not the class)', [['type', 'local']], 'feed', 'local', 'Default'],
    ['change set', [['NAME', 'x']], 'changeset', 'changeset', 'Default'],
    ['content subtype', [['type', 'Folder'], ['subType', 'Blog']], 'content', 'Folder', 'Blog'],
  ])('objectType and objectSubType of a %s', (_label, entries, entityName, type, subType) => {
    const values = wddxStruct(entries);
    expect(trashObjectType(values, entityName)).toBe(type);
    expect(trashObjectSubType(values)).toBe(subType);
  });

  it('numbers throw-ins per delete id from 1', () => {
    const counter = createTrashCounter();
    expect([counter.next('D1'), counter.next('D1'), counter.next('D2'), counter.next('D1'), counter.next('d1')]).toEqual([1, 2, 1, 3, 1]);
  });

  it('keeps shared delete markers and creates them otherwise', () => {
    const shared = { deletedDate: new Date(2026, 0, 1), deleteId: cfId('D', 1) };
    expect(deleteMarkers(NOW, shared)).toEqual(shared);
    const fresh = deleteMarkers(NOW, { deleteId: '' });
    expect(fresh.deletedDate).toBe(NOW);
    expect(isCfUuid(fresh.deleteId)).toBe(true);
    expect(deleteMarkers(NOW).deleteId).not.toBe(fresh.deleteId);
  });

  it('renders the markers as setValue leaves them in the captured change-set packet', () => {
    const captured = wddx2cfml(CHANGESET_TRASH) as WddxStruct;
    const markers = { deletedDate: NOW, deleteId: text(captured, 'muraDeleteID') };
    expect(deleteMarkerAssignments(markers)).toEqual([
      ['muraDeleteDateTime', text(captured, 'muraDeleteDateTime')],
      ['muraDeleteID', 'C33986A8-0364-2330-D256B6987181DD66'],
    ]);
  });

  it('takeOut is a no-op and names what restore would add', () => {
    expect(takeOut(wddxStruct([['fromMuraTrash', true]]))).toBeUndefined();
    expect(takeOut({ fromMuraTrash: true })).toBeUndefined();
    expect(TAKEOUT_UNBUILT).toEqual(['fileManager.restoreVersion', 'child restore']);
  });
});

interface StoredTrash {
  tenant_id: string;
  objectid: string;
  parentid: string;
  siteid: string;
  objectlabel: string;
  objectclass: string;
  objecttype: string;
  objectsubtype: string;
  objectstring: string | null;
  deleteddate: Date | null;
  deletedby: string;
  deleteid: string | null;
  orderno: number | null;
}

interface Change {
  op: string;
  table: string;
}

let handle: ThrowawaySchema;
let repo: ContentRepository;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

async function stored(objectId: string): Promise<StoredTrash | undefined> {
  return inA(async (tx) => (await tx.query<StoredTrash>(`SELECT * FROM ${handle.schema}.trash WHERE objectid = $1`, [objectId])).rows[0]);
}

async function changeCount(): Promise<number> {
  return inA(async (tx) => (await tx.query<Change>(`SELECT op, "table" FROM ${handle.schema}.changelog`)).rows.length);
}

async function newChanges<T>(fn: () => Promise<T>): Promise<{ result: T; changes: Change[] }> {
  const before = await changeCount();
  const result = await fn();
  const changes = await inA(async (tx) => (await tx.query<Change>(`SELECT op, "table" FROM ${handle.schema}.changelog ORDER BY seq OFFSET $1`, [before])).rows);
  return { result, changes };
}

/** A content entry built as contentManager.deleteAll hands the bean to throwIn. */
function contentEntry(contentId: string, parentId: string, markers: { deletedDate: Date; deleteId: string }): TrashEntry {
  const values = cfStruct([
    ['CONTENTID', contentId],
    ['PARENTID', parentId],
    ['SITEID', SITE],
    ['TYPE', 'Page'],
    ['SUBTYPE', 'Default'],
    ['TITLE', `Item ${contentId.slice(0, 8)}`],
    ...deleteMarkerAssignments(markers),
  ]);
  return {
    objectClass: 'content',
    objectId: contentId,
    parentId: deletedParentId(values),
    siteId: SITE,
    label: text(values, 'title'),
    objectType: trashObjectType(values, 'content'),
    objectSubType: trashObjectSubType(values),
    values,
    ...markers,
  };
}

describe.skipIf(!(await pgAvailable()))('domain/trash throwIn', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'trash-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'trash-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('stores a change-set delete with every column, byte-exact WDDX and one changelog row', async () => {
    const values = wddx2cfml(CHANGESET_TRASH) as WddxStruct;
    const entry: TrashEntry = {
      objectClass: 'changeset',
      objectId: text(values, 'changesetID'),
      parentId: deletedParentId(values),
      siteId: text(values, 'siteid'),
      label: text(values, 'name'),
      objectType: trashObjectType(values, 'changeset'),
      objectSubType: trashObjectSubType(values),
      values,
      deletedDate: NOW,
      deleteId: text(values, 'muraDeleteID'),
    };
    const { result, changes } = await newChanges(() => inA((tx) => throwIn(tx, repo, entry, actor('Admin User'), createTrashCounter())));
    expect(result).not.toBeNull();
    expect(changes).toEqual([{ op: 'insert', table: 'trash' }]);
    expect(await stored(entry.objectId)).toEqual({
      tenant_id: TENANT_A.tenantId,
      objectid: 'C339851E-F35C-D931-94E0F789891A922C',
      parentid: 'NA'.padEnd(35),
      siteid: 'default',
      objectlabel: 'Blitzy CS <1> & co',
      objectclass: 'changeset',
      objecttype: 'changeset',
      objectsubtype: 'Default',
      objectstring: CHANGESET_TRASH,
      deleteddate: new Date(2026, 10, 10, 18, 29, 32, 0),
      deletedby: 'Admin User',
      deleteid: 'C33986A8-0364-2330-D256B6987181DD66',
      orderno: 1,
    });
  });

  it('numbers a recursive delete 1, 2, 3 under one delete id and skips an object already in the trash', async () => {
    const markers = deleteMarkers(NOW);
    const counter = createTrashCounter();
    const parent = cfId('A', 1);
    const items = [contentEntry(cfId('A', 3), cfId('A', 2), markers), contentEntry(cfId('A', 2), parent, markers), contentEntry(parent, cfId('A', 0), markers)];
    const { changes } = await newChanges(() =>
      inA(async (tx) => {
        for (const item of items) await throwIn(tx, repo, item, actor('Admin User'), counter);
      }),
    );
    expect(changes).toEqual(items.map(() => ({ op: 'insert', table: 'trash' })));
    const rows = await Promise.all(items.map((item) => stored(item.objectId)));
    expect(rows.map((row) => [row?.orderno, row?.deleteid, row?.objecttype, row?.parentid.trimEnd()])).toEqual([
      [1, markers.deleteId, 'Page', cfId('A', 2)],
      [2, markers.deleteId, 'Page', parent],
      [3, markers.deleteId, 'Page', cfId('A', 0)],
    ]);

    const again = contentEntry(cfId('A', 2).toLowerCase(), parent, markers);
    const skipped = await newChanges(() => inA((tx) => throwIn(tx, repo, again, actor('Other'), counter)));
    expect(skipped.result).toBeNull();
    expect(skipped.changes).toEqual([]);
    expect((await stored(cfId('A', 2)))?.deletedby).toBe('Admin User');
    // The skipped throw-in still took number 4.
    const next = contentEntry(cfId('A', 9), parent, markers);
    await inA((tx) => throwIn(tx, repo, next, actor('Admin User'), counter));
    expect((await stored(next.objectId))?.orderno).toBe(5);
  });

  it('truncates deletedby to 50 characters and writes an anonymous delete as empty', async () => {
    const long = `${'Firstname'.repeat(5)} Lastname-Beyond-Fifty`;
    const markers = deleteMarkers(NOW);
    const named = contentEntry(cfId('B', 1), cfId('B', 0), markers);
    const anonymous = contentEntry(cfId('B', 2), cfId('B', 0), markers);
    await inA(async (tx) => {
      const counter = createTrashCounter();
      await throwIn(tx, repo, named, actor(long), counter);
      await throwIn(tx, repo, anonymous, actorFromClaims(undefined, ''), counter);
    });
    expect((await stored(named.objectId))?.deletedby).toBe(long.slice(0, 50));
    expect((await stored(named.objectId))?.deletedby).toHaveLength(50);
    expect((await stored(anonymous.objectId))?.deletedby).toBe('');
  });

  it('rolls back with the deleting transaction', async () => {
    const entry = contentEntry(cfId('E', 1), cfId('E', 0), deleteMarkers(NOW));
    const before = await changeCount();
    await expect(
      inA(async (tx) => {
        await throwIn(tx, repo, entry, actor('Admin User'), createTrashCounter());
        throw new Error('delete failed');
      }),
    ).rejects.toThrow('delete failed');
    expect(await stored(entry.objectId)).toBeUndefined();
    expect(await changeCount()).toBe(before);
  });
});
