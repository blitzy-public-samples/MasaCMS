// The orphan archive probe over the in-memory legacy database: which archive rows a legacy 404 render deletes, and its bound filenames.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';

import { OrphanArchiveUnavailableError, hasOrphanArchive, orphanArchiveSql } from '../../src/windows/index.js';
import { connectionLost, createFakeLegacyDb, type FakeLegacyDb, type Row } from '../helpers/fake-legacy-db.js';

const CONTENT_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const ARCHIVE_ID = '7B2C3D4E-5F60-4172-8394A50516273849';

/** A live database holding one archive row of `filename` for `CONTENT_ID` in tenant-a, and `content` as its tcontent rows. */
function legacyWith(content: readonly Row[], filename = 'about/team'): FakeLegacyDb {
  const db = createFakeLegacyDb();
  db.defineTable('dbo.tcontentfilenamearchive', [
    { name: 'archiveid', type: 'char', length: 35, nullable: false },
    { name: 'contentID', type: 'char', length: 35 },
    { name: 'siteID', type: 'nvarchar', length: 50 },
    { name: 'filename', type: 'nvarchar', length: 255 },
  ], { primaryKey: ['archiveid'] });
  db.defineTable('dbo.tcontent', [
    { name: 'ContentID', type: 'char', length: 35 },
    { name: 'SiteID', type: 'nvarchar', length: 50 },
    { name: 'Active', type: 'tinyint' },
    { name: 'Approved', type: 'tinyint' },
    { name: 'Type', type: 'nvarchar', length: 50 },
  ]);
  db.seed('dbo.tcontentfilenamearchive', [{ archiveid: ARCHIVE_ID, contentID: CONTENT_ID, siteID: 'tenant-a', filename }]);
  db.seed('dbo.tcontent', content);
  return db;
}

/** A tcontent row of `CONTENT_ID` in tenant-a as readActive finds it, with `overrides`. */
function version(overrides: Row = {}): Row {
  return { ContentID: CONTENT_ID, SiteID: 'tenant-a', Active: 1, Approved: 1, Type: 'Page', ...overrides };
}

describe('hasOrphanArchive', () => {
  it.each<[string, boolean, Row[], string[]]>([
    ['an archive row whose content is gone', true, [], ['about/team']],
    ['an archive row whose content has an active page', false, [version()], ['about/team']],
    ['an archive row whose content has only an inactive version', true, [version({ Active: 0 })], ['about/team']],
    ['an archive row whose active version is unapproved, which readActive still reads', false, [version({ Approved: 0 })], ['about/team']],
    ['an archive row whose active version is of a type readActive skips', true, [version({ Type: 'Portal' })], ['about/team']],
    ['an archive row whose content is active only in another site', true, [version({ SiteID: 'tenant-b' })], ['about/team']],
    ['a filename spelled in another case', true, [], ['ABOUT/Team']],
    ['one orphan filename among others', true, [], ['about', 'about/team', 'team']],
    ['no listed filename', false, [], ['about', 'team']],
  ])('answers for %s: %s', async (_label, expected, content, filenames) => {
    await expect(hasOrphanArchive(legacyWith(content), filenames)).resolves.toBe(expected);
  });

  it('binds every filename as a parameter and never writes it into the statement', async () => {
    const quoted = "o'brien/team";
    const db = legacyWith([], quoted);
    await expect(hasOrphanArchive(db, ['o', quoted])).resolves.toBe(true);
    const [statement] = db.statements;
    expect(statement?.sql).toBe(orphanArchiveSql(2));
    expect(statement?.sql).not.toContain('brien');
    expect(statement?.params).toEqual({ f0: 'o', f1: quoted });
  });

  it('answers false for no filename without reading the database', async () => {
    const db = legacyWith([]);
    await expect(hasOrphanArchive(db, [])).resolves.toBe(false);
    expect(db.statements).toEqual([]);
  });

  it('fails as the legacy 503 when the live database cannot be read', async () => {
    const db = legacyWith([]);
    db.failNext(() => true, connectionLost());
    const error = await hasOrphanArchive(db, ['about/team']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrphanArchiveUnavailableError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ reason: 'orphan-archive-unavailable' });
  });
});
