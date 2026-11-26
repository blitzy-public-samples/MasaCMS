// Fixture data of the migration suites: legacy table shapes and rows for the fake SQL Server, the unit catalog, cut-over
// versions and groups, the scheduler capture, the legacy file store, the order inventory and target mappings.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LEGACY_ADMIN_SENTINEL_ID } from '@opt2/platform/legacy-compat';
import { DEFAULT_UMBRELLA_SITE_ID } from '@opt2/platform/migration-kit';
import type { CanonicalColumn, MappingSpec, TableDefinition } from '@opt2/platform/migration-kit';
import { rlsSql } from '@opt2/platform/tenancy';

import { loadConfig } from '../../src/config.js';
import { LOGIN_ROUTE_KEY } from '../../src/cutover/versions.js';
import type { Authority, CutoverEntry, CutoverGroup, CutoverVersion, GroupsFile, RollbackRef } from '../../src/cutover/versions.js';
import { parseStoredName, storePath } from '../../src/files/names.js';
import type { FileListing, LegacyFileEntry, ScheduledTaskDefinition } from '../../src/legacy/bridge.js';
import type { OrderInventory, OrderRelation } from '../../src/order/dependency-order.js';
import { UnknownLegacyTableError, loadUnitCatalog } from '../../src/owners/units.js';
import type { UnitCatalog } from '../../src/owners/units.js';
import type { NativeTasksFile } from '../../src/scheduler/import.js';

import { TEST_SOURCE_SHA, createTestDirs } from './env.js';
import type { FakeLegacyDb, LegacyColumnDef, LegacyColumnType, LegacyTableOptions, Row } from './fake-legacy-db.js';

// Shared values

/** Freezes `value` and everything reachable from it (Buffers excepted, which cannot be frozen), keeping its type. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodeUnit);
}

/** A local wall-clock instant, the form the mssql driver returns a `datetime` in. */
function wallClock(text: string): Date {
  return new Date(text);
}

/** Wall-clock time every seeded row carries. */
export const SEED_TIME: Date = wallClock('2026-06-01T09:00:00');

/** `createdAt` of every fixture cut-over version and `capturedAt` of the scheduler capture. */
export const FIXTURE_CREATED_AT = '2026-06-01T00:00:00.000Z';

/** Bridge wire form of {@link SEED_TIME}: legacy zone, no offset. */
const SEED_WIRE_TIME = '2026-06-01T09:00:00.000';

/**
 * Fixed 35-character ColdFusion-format id (8-4-4-16 upper-case hex) for `label`; equal labels give equal ids.
 * Derived instead of drawn from legacy-compat `cfUuid()`, which is random, so every fixture row is the same on every run.
 */
export function fixtureId(label: string): string {
  const hex = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 32).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
}

/** The seeded sites: Masa's installed site, the pool site and the two program sites. */
export const FIXTURE_SITES = deepFreeze(['default', DEFAULT_UMBRELLA_SITE_ID, 'tenant-a', 'tenant-b'] as const);

/** Site id of one of {@link FIXTURE_SITES}. */
export type FixtureSiteId = (typeof FIXTURE_SITES)[number];

/** Masa's Site Manager module id, the `ModuleID` of every site content node. */
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

// Legacy table definitions

/** One table of the fake legacy database, defined as the live SQL Server catalog holds it. */
export interface FixtureTable {
  qualified: string;
  columns: LegacyColumnDef[];
  options: LegacyTableOptions;
}

function col(name: string, type: LegacyColumnType, options: Omit<LegacyColumnDef, 'name' | 'type'> = {}): LegacyColumnDef {
  return { name, type, ...options };
}

const char35 = (name: string, nullable = true): LegacyColumnDef => col(name, 'char', { length: 35, nullable });
const nvarchar = (name: string, length: number | 'max', nullable = true): LegacyColumnDef => col(name, 'nvarchar', { length, nullable });
const varchar = (name: string, length: number): LegacyColumnDef => col(name, 'varchar', { length });

/** Legacy tables of the suites, keyed by the name suites pass to the fake; SQL Server types and live column order. */
export const TABLES = deepFreeze({
  // mssql.sql:467-505 and PK 871-876; Password as altered by 5.7.cfm:139-142; tablist from 5.2.1932.cfm:18.
  tusers: {
    qualified: 'dbo.tusers',
    columns: [
      char35('UserID', false),
      nvarchar('GroupName', 255),
      nvarchar('Fname', 50),
      nvarchar('Lname', 50),
      nvarchar('UserName', 255),
      varchar('Password', 100),
      col('PasswordCreated', 'datetime'),
      nvarchar('Email', 255),
      nvarchar('Company', 50),
      nvarchar('JobTitle', 50),
      nvarchar('mobilePhone', 50),
      nvarchar('Website', 255),
      col('Type', 'int'),
      nvarchar('subType', 50),
      col('Ext', 'int'),
      nvarchar('ContactForm', 'max'),
      col('Admin', 'int'),
      col('S2', 'int'),
      col('LastLogin', 'datetime'),
      col('LastUpdate', 'datetime'),
      nvarchar('LastUpdateBy', 50),
      nvarchar('LastUpdateByID', 35),
      col('Perm', 'tinyint'),
      col('InActive', 'tinyint'),
      col('isPublic', 'int'),
      nvarchar('SiteID', 50),
      col('Subscribe', 'int'),
      nvarchar('notes', 'max'),
      nvarchar('description', 'max'),
      nvarchar('interests', 'max'),
      col('keepPrivate', 'tinyint'),
      char35('photoFileID'),
      nvarchar('IMName', 100),
      nvarchar('IMService', 50),
      col('created', 'datetime'),
      nvarchar('remoteID', 35),
      nvarchar('tags', 'max'),
      nvarchar('tablist', 255),
    ],
    options: { primaryKey: ['UserID'] },
  },
  // Subset of mssql.sql:2-62 (PK 624-628, defaults 788-791) in live order; FileID closes the tcontent/tfiles cycle,
  // urltitle is the live spelling of 5.1.553.cfm:18.
  tcontent: {
    qualified: 'dbo.tcontent',
    columns: [
      col('tcontent_ID', 'int', { nullable: false }),
      nvarchar('SiteID', 25),
      char35('ModuleID'),
      char35('ParentID'),
      char35('ContentID'),
      char35('ContentHistID'),
      char35('FileID'),
      nvarchar('Type', 25),
      nvarchar('subType', 25),
      col('Active', 'tinyint', { default: 0 }),
      nvarchar('Title', 255),
      nvarchar('Filename', 255),
      nvarchar('Body', 'max'),
      col('lastUpdate', 'datetime'),
      col('forceSSL', 'tinyint', { nullable: false, default: 0 }),
      nvarchar('path', 'max'),
      nvarchar('urltitle', 255),
    ],
    options: { primaryKey: ['tcontent_ID'], identity: 'tcontent_ID' },
  },
  // mssql.sql:270-284, PK 730-734.
  tfiles: {
    qualified: 'dbo.tfiles',
    columns: [
      char35('fileID', false),
      char35('contentID'),
      nvarchar('siteID', 25),
      char35('moduleID'),
      nvarchar('filename', 200),
      col('image', 'varbinary', { length: 'max' }),
      col('imageSmall', 'varbinary', { length: 'max' }),
      col('imageMedium', 'varbinary', { length: 'max' }),
      col('fileSize', 'int'),
      nvarchar('contentType', 100),
      nvarchar('contentSubType', 200),
      nvarchar('fileExt', 50),
      col('created', 'datetime'),
    ],
    options: { primaryKey: ['fileID'] },
  },
  // Subset of mssql.sql:370-433 plus the pools of 6.1.cfm:155-157. Keyed on SiteID like the live catalog, where
  // 6.1.cfm:120-122 adds the primary key the bootstrap DDL lacks.
  tsettings: {
    qualified: 'dbo.tsettings',
    columns: [
      nvarchar('SiteID', 25, false),
      nvarchar('Site', 50),
      nvarchar('Domain', 100),
      col('EmailBroadcaster', 'int'),
      nvarchar('privateUserPoolID', 50),
      nvarchar('publicUserPoolID', 50),
      col('feedManager', 'int'),
      nvarchar('displayPoolID', 50),
      varchar('filePoolID', 25),
      varchar('categoryPoolID', 25),
      nvarchar('contentPoolID', 'max'),
    ],
    options: { primaryKey: ['SiteID'] },
  },
  // 5.7.cfm:94-102.
  timagesizes: {
    qualified: 'dbo.timagesizes',
    columns: [
      col('sizeID', 'char', { length: 35, nullable: false, default: '' }),
      varchar('siteID', 35),
      varchar('name', 50),
      varchar('height', 10),
      varchar('width', 10),
    ],
    options: { primaryKey: ['sizeID'] },
  },
  // mssql.sql:312-320; no key.
  tmailinglist: {
    qualified: 'dbo.tmailinglist',
    columns: [
      char35('MLID'),
      nvarchar('SiteID', 25),
      nvarchar('Name', 50),
      nvarchar('Description', 'max'),
      col('LastUpdate', 'datetime'),
      col('isPurge', 'int'),
      col('isPublic', 'int'),
    ],
    options: {},
  },
  // mssql.sql:323-331 plus created from 5.2.2655.cfm:9; no key.
  tmailinglistmembers: {
    qualified: 'dbo.tmailinglistmembers',
    columns: [
      char35('MLID'),
      nvarchar('Email', 100),
      nvarchar('SiteID', 25),
      nvarchar('fname', 50),
      nvarchar('lname', 50),
      nvarchar('company', 50),
      col('isVerified', 'bit', { nullable: false }),
      col('created', 'datetime'),
    ],
    options: {},
  },
  // The program-to-site map the `Program_<id>` fold reads (`PROGRAM_SITE_TABLE`).
  'synthetic.program_site': {
    qualified: 'synthetic.program_site',
    columns: [col('program_id', 'int', { nullable: false }), nvarchar('siteID', 25, false)],
    options: { primaryKey: ['program_id'] },
  },
  // legacy-fixtures/sql/people/100_person_archive.sql.
  'synthetic.person_archive': {
    qualified: 'synthetic.person_archive',
    columns: [
      char35('archive_id', false),
      char35('person_id', false),
      nvarchar('siteID', 50, false),
      col('effective_from', 'datetime', { nullable: false }),
      col('archived_at', 'datetime', { nullable: false }),
      char35('archived_by_id'),
      nvarchar('archived_by', 50),
    ],
    options: { primaryKey: ['archive_id'] },
  },
  'Program_1.enrolment': programEnrolment(1),
  'Program_2.enrolment': programEnrolment(2),
}) satisfies Readonly<Record<string, FixtureTable>>;

/** Key of one of {@link TABLES}. */
export type FixtureTableName = keyof typeof TABLES;

/** Every {@link TABLES} key, in definition order. */
export const TABLE_NAMES = deepFreeze(Object.keys(TABLES) as FixtureTableName[]);

/** `[Program_<id>].[enrolment]`: the fixture's per-program table, folded across the program schemas. */
function programEnrolment(programId: number): FixtureTable {
  return {
    qualified: `Program_${String(programId)}.enrolment`,
    columns: [
      char35('enrolment_id', false),
      char35('cohort_id', false),
      char35('person_id', false),
      char35('archive_id'),
      nvarchar('status', 50, false),
      col('created', 'datetime', { nullable: false }),
    ],
    options: { primaryKey: ['enrolment_id'] },
  };
}

/** Defines `names` (default every table) in the fake, in `opts.database` when given. */
export function defineFixtureTables(
  db: FakeLegacyDb,
  names: readonly FixtureTableName[] = TABLE_NAMES,
  opts: { database?: string } = {},
): void {
  for (const name of names) {
    const table: FixtureTable = TABLES[name];
    const options = opts.database === undefined ? table.options : { ...table.options, database: opts.database };
    db.defineTable(table.qualified, table.columns, options);
  }
}

// Legacy file store

/** One original of the fake file store and the renditions Masa's fileDAO wrote for it. */
export interface FixtureFile {
  fileId: string;
  /** Site whose `<siteid>/cache/file/` holds the bytes: the file pool site. */
  siteId: FixtureSiteId;
  ext: string;
  /** Stored names, original first. */
  names: readonly string[];
  /** False for a stored object with no `tfiles` row. */
  catalogued: boolean;
  filename: string;
  contentType: string;
  contentSubType: string;
}

// fileDAO.cfc:153-199: png/gif/jpg/jpeg add _source, _small and _medium in the same extension; flv adds _small.jpg and _medium.jpg.
function storedNames(fileId: string, ext: string): string[] {
  if (['png', 'gif', 'jpg', 'jpeg'].includes(ext)) return ['', '_source', '_small', '_medium'].map((variant) => `${fileId}${variant}.${ext}`);
  if (ext === 'flv') return [`${fileId}.flv`, `${fileId}_small.jpg`, `${fileId}_medium.jpg`];
  return [`${fileId}.${ext}`];
}

function fixtureFile(siteId: FixtureSiteId, filename: string, contentType: string, contentSubType: string, catalogued = true): FixtureFile {
  const ext = filename.slice(filename.lastIndexOf('.') + 1);
  const fileId = fixtureId(`tfiles:${siteId}/${filename}`);
  return { fileId, siteId, ext, names: storedNames(fileId, ext), catalogued, filename, contentType, contentSubType };
}

/** The stored files: a pooled image and PDF under `umbrella`, a `tenant-b` video, and a `tenant-b` orphan without a `tfiles` row. */
export const FIXTURE_FILES = deepFreeze({
  image: fixtureFile(DEFAULT_UMBRELLA_SITE_ID, 'logo.jpg', 'image', 'jpeg'),
  pdf: fixtureFile(DEFAULT_UMBRELLA_SITE_ID, 'handbook.pdf', 'application', 'pdf'),
  video: fixtureFile('tenant-b', 'intro.flv', 'video', 'x-flv'),
  orphan: fixtureFile('tenant-b', 'stray.txt', 'text', 'plain', false),
});

const FILE_LIST = Object.values(FIXTURE_FILES);

/** Bytes of every stored name. */
export const FILE_BYTES: Readonly<Record<string, Buffer>> = Object.freeze(
  Object.fromEntries(FILE_LIST.flatMap((file) => file.names.map((name) => [name, Buffer.from(`opt2 fixture bytes of ${name}\n`, 'utf8')]))),
);

function bytesOf(name: string): Buffer {
  const bytes = FILE_BYTES[name];
  if (bytes === undefined) throw new Error(`No fixture bytes for ${name}`);
  return bytes;
}

/** Bytes of every stored name by store path `<siteid>/cache/file/<name>`, the form the bridge double serves. */
export const FILE_STORE: Readonly<Record<string, Buffer>> = Object.freeze(
  Object.fromEntries(FILE_LIST.flatMap((file) => file.names.map((name) => [storePath(file.siteId, name), bytesOf(name)]))),
);

function fileEntry(name: string): LegacyFileEntry {
  const parsed = parseStoredName(name);
  if (parsed === null) throw new Error(`Fixture file name ${name} is not a stored name`);
  const bytes = bytesOf(name);
  return {
    name,
    fileId: parsed.fileId,
    variant: parsed.variant,
    ext: parsed.ext,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lastModified: SEED_WIRE_TIME,
  };
}

/** Recorded `files.cfm?op=list` answers per site; `tenant-a` lists nothing because its file pool is `umbrella`. */
export const FILE_LISTINGS: Readonly<Record<FixtureSiteId, FileListing>> = deepFreeze(
  Object.fromEntries(
    FIXTURE_SITES.map((siteId): [FixtureSiteId, FileListing] => [
      siteId,
      {
        fileStore: 'fileDir',
        files: FILE_LIST.filter((file) => file.siteId === siteId)
          .flatMap((file) => file.names)
          .sort(byCodeUnit)
          .map(fileEntry),
        serverTime: SEED_WIRE_TIME,
      },
    ]),
  ) as Record<FixtureSiteId, FileListing>,
);

// Seed rows

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A `tsettings` row; every pool names the site itself, except `tenant-a`, whose public user, category, file and display pools are `umbrella`. */
export function siteRow(siteId: string, overrides: Row = {}): Row {
  const pooled = siteId === 'tenant-a' ? DEFAULT_UMBRELLA_SITE_ID : siteId;
  return {
    SiteID: siteId,
    Site: `Fixture site ${siteId}`,
    Domain: siteId === 'default' ? 'localhost' : `${siteId}.example.test`,
    // tenant-a runs every site-monitor step; tenant-b only feed imports.
    EmailBroadcaster: siteId === 'tenant-a' ? 1 : 0,
    privateUserPoolID: siteId,
    publicUserPoolID: pooled,
    feedManager: siteId === 'tenant-a' || siteId === 'tenant-b' ? 1 : 0,
    displayPoolID: pooled,
    filePoolID: pooled,
    categoryPoolID: pooled,
    contentPoolID: siteId,
    ...overrides,
  };
}

/** A `tusers` row with every column; a system user (`Type` 2) unless `Type: 1` makes it a group. */
export function userRow(overrides: Row = {}): Row {
  const isGroup = overrides.Type === 1;
  const siteId = text(overrides.SiteID, 'tenant-a');
  const userName = isGroup ? null : text(overrides.UserName, 'fixture.user');
  const groupName = isGroup ? text(overrides.GroupName, 'Fixture Group') : null;
  return {
    UserID: fixtureId(`tusers:${siteId}/${isGroup ? `group/${groupName ?? ''}` : `user/${userName ?? ''}`}`),
    GroupName: groupName,
    Fname: isGroup ? null : 'Fixture',
    Lname: isGroup ? null : 'User',
    UserName: userName,
    Password: isGroup ? null : `fixture-hash-${userName ?? ''}`,
    PasswordCreated: isGroup ? null : SEED_TIME,
    Email: isGroup ? null : `${userName ?? 'user'}@example.test`,
    Company: null,
    JobTitle: null,
    mobilePhone: null,
    Website: null,
    Type: isGroup ? 1 : 2,
    subType: 'Default',
    Ext: null,
    ContactForm: null,
    Admin: 0,
    S2: 0,
    LastLogin: null,
    LastUpdate: SEED_TIME,
    LastUpdateBy: 'System',
    LastUpdateByID: null,
    Perm: 0,
    InActive: 0,
    isPublic: 0,
    SiteID: siteId,
    Subscribe: 0,
    notes: null,
    description: null,
    interests: null,
    keepPrivate: 0,
    photoFileID: null,
    IMName: null,
    IMService: null,
    created: SEED_TIME,
    remoteID: null,
    tags: null,
    tablist: null,
    ...overrides,
  };
}

/** A `timagesizes` row; its `sizeID` derives from site and name. */
export function imageSizeRow(overrides: Row = {}): Row {
  const siteId = text(overrides.siteID, 'tenant-a');
  const name = text(overrides.name, 'thumbnail');
  return { sizeID: fixtureId(`timagesizes:${siteId}/${name}`), siteID: siteId, name, height: '100', width: '100', ...overrides };
}

/** A `tmailinglist` row; its `MLID` derives from site and name. */
export function mailingListRow(overrides: Row = {}): Row {
  const siteId = text(overrides.SiteID, 'tenant-a');
  const name = text(overrides.Name, 'Newsletter');
  return {
    MLID: fixtureId(`tmailinglist:${siteId}/${name}`),
    SiteID: siteId,
    Name: name,
    Description: `${name} subscribers`,
    LastUpdate: SEED_TIME,
    isPurge: 0,
    isPublic: 1,
    ...overrides,
  };
}

/** A `tmailinglistmembers` row of the default list of its site. */
export function mailingListMemberRow(overrides: Row = {}): Row {
  const siteId = text(overrides.SiteID, 'tenant-a');
  return {
    MLID: mailingListRow({ SiteID: siteId }).MLID,
    Email: 'reader@example.test',
    SiteID: siteId,
    fname: 'Reader',
    lname: 'One',
    company: 'Example',
    isVerified: 1,
    created: SEED_TIME,
    ...overrides,
  };
}

/** A `tcontent` Page under the site home node, outside the start-up predicate; `tcontent_ID` is left to the identity. */
export function contentRow(overrides: Row = {}): Row {
  const siteId = text(overrides.SiteID, 'tenant-a');
  const filename = text(overrides.Filename, 'about');
  const contentId = fixtureId(`tcontent:${siteId}/${filename}`);
  return {
    SiteID: siteId,
    ModuleID: SITE_MANAGER_MODULE_ID,
    ParentID: LEGACY_ADMIN_SENTINEL_ID,
    ContentID: contentId,
    ContentHistID: fixtureId(`tcontent-history:${siteId}/${filename}/1`),
    FileID: null,
    Type: 'Page',
    subType: 'Default',
    Active: 1,
    Title: 'About',
    Filename: filename,
    Body: '<p>About this site.</p>',
    lastUpdate: SEED_TIME,
    forceSSL: 0,
    path: `${LEGACY_ADMIN_SENTINEL_ID},${contentId}`,
    urltitle: filename,
    ...overrides,
  };
}

/** A `tcontent` row Masa's start-up converts (onApplicationStart_include.cfm:896-899): active File, `Body` NULL, `Filename` set. */
export function startupMatchRow(overrides: Row = {}): Row {
  return contentRow({ Type: 'File', Title: 'Report', Filename: 'report.pdf', Body: null, urltitle: 'report', ...overrides });
}

/** A `tfiles` row of a catalogued {@link FixtureFile}; the bytes stay in the file store, so the image columns are NULL. */
export function fileRow(file: FixtureFile, overrides: Row = {}): Row {
  const original = file.names[0];
  return {
    fileID: file.fileId,
    contentID: null,
    siteID: file.siteId,
    moduleID: SITE_MANAGER_MODULE_ID,
    filename: file.filename,
    image: null,
    imageSmall: null,
    imageMedium: null,
    fileSize: original === undefined ? 0 : bytesOf(original).length,
    contentType: file.contentType,
    contentSubType: file.contentSubType,
    fileExt: file.ext,
    created: SEED_TIME,
    ...overrides,
  };
}

/** A `synthetic.person_archive` row of a person, keyed by person and effective date. */
export function personArchiveRow(overrides: Row = {}): Row {
  const personId = text(overrides.person_id, userRow().UserID as string);
  const effectiveFrom = overrides.effective_from instanceof Date ? overrides.effective_from : wallClock('2026-06-15T00:00:00');
  return {
    archive_id: fixtureId(`person_archive:${personId}/${effectiveFrom.toISOString()}`),
    person_id: personId,
    siteID: 'tenant-a',
    effective_from: effectiveFrom,
    archived_at: SEED_TIME,
    archived_by_id: null,
    archived_by: 'System',
    ...overrides,
  };
}

/** A `Program_<id>.enrolment` row of a cohort. */
export function enrolmentRow(overrides: Row = {}): Row {
  const cohortId = text(overrides.cohort_id, fixtureId('cohort:fixture'));
  return {
    enrolment_id: fixtureId(`enrolment:${cohortId}`),
    cohort_id: cohortId,
    person_id: userRow().UserID,
    archive_id: null,
    status: 'enrolled',
    created: SEED_TIME,
    ...overrides,
  };
}

/** `synthetic.program_site`: program 1 is `tenant-a`, program 2 `tenant-b`. */
export const PROGRAM_SITES = deepFreeze([
  { program_id: 1, siteID: 'tenant-a' },
  { program_id: 2, siteID: 'tenant-b' },
] as const);

/** Options of {@link seedFakeLegacy}. */
export interface SeedFakeLegacyOptions {
  /** Sites to seed, default {@link FIXTURE_SITES}; rows of other sites are left out. */
  sites?: readonly string[];
  /** Occurrences of the duplicated `tmailinglistmembers` row, at least 1; default 2. */
  duplicates?: number;
  /** Adds a {@link startupMatchRow}, so the start-up predicate matches. */
  startupMatch?: boolean;
}

/** Seeded committed rows of every fixture table, as the fake returns them. */
export type SeededRows = Record<FixtureTableName, Row[]>;

/** Defines every fixture table in the live database and seeds sites, users, image sizes, mailing lists, content and files. */
export function seedFakeLegacy(db: FakeLegacyDb, opts: SeedFakeLegacyOptions = {}): SeededRows {
  const sites = new Set<string>(opts.sites ?? FIXTURE_SITES);
  const duplicates = opts.duplicates ?? 2;
  if (!Number.isInteger(duplicates) || duplicates < 1) throw new RangeError(`duplicates must be a positive integer, got ${String(duplicates)}`);
  const inSite = (column: string) => (row: Row): boolean => sites.has(text(row[column], ''));

  defineFixtureTables(db);
  const member = mailingListMemberRow();
  // Two rows differing only in NULL against empty string, which null-aware matching keeps apart.
  const blank = { Email: 'blank@example.test', company: null, created: null };
  const rows: Partial<Record<FixtureTableName, Row[]>> = {
    tsettings: [...sites].map((siteId) => siteRow(siteId)),
    tusers: [
      userRow({ UserName: 'admin', SiteID: 'default', Fname: 'Admin', Lname: 'User', S2: 1 }),
      userRow({ Type: 1, GroupName: 'Admin', SiteID: 'tenant-a' }),
      userRow({ UserName: 'ana.editor', SiteID: 'tenant-a', Fname: 'Ana', Lname: 'Editor' }),
      userRow({ UserName: 'uma.member', SiteID: DEFAULT_UMBRELLA_SITE_ID, Fname: 'Uma', Lname: 'Member', isPublic: 1 }),
      userRow({ UserName: 'ben.user', SiteID: 'tenant-b', Fname: 'Ben', Lname: 'User' }),
    ].filter(inSite('SiteID')),
    timagesizes: [
      imageSizeRow(),
      imageSizeRow({ siteID: 'tenant-b', name: 'banner', height: '300', width: '1200' }),
    ].filter(inSite('siteID')),
    tmailinglist: [mailingListRow()].filter(inSite('SiteID')),
    tmailinglistmembers: [
      ...Array.from({ length: duplicates }, () => ({ ...member })),
      mailingListMemberRow({ ...blank, fname: null, lname: null }),
      mailingListMemberRow({ ...blank, fname: '', lname: '' }),
    ].filter(inSite('SiteID')),
    tcontent: [
      ...[...sites].filter((siteId) => siteId !== DEFAULT_UMBRELLA_SITE_ID).map((siteId) => contentRow({ SiteID: siteId })),
      ...(opts.startupMatch === true ? [startupMatchRow({ SiteID: sites.has('tenant-a') ? 'tenant-a' : ([...sites][0] ?? 'tenant-a') })] : []),
    ],
    tfiles: FILE_LIST.filter((file) => file.catalogued).map((file) => fileRow(file)).filter(inSite('siteID')),
    'synthetic.program_site': PROGRAM_SITES.map((row) => ({ ...row })).filter(inSite('siteID')),
  };
  for (const [name, seeded] of Object.entries(rows)) db.seed(TABLES[name as FixtureTableName].qualified, seeded);
  return Object.fromEntries(TABLE_NAMES.map((name) => [name, db.rows(TABLES[name].qualified)])) as SeededRows;
}

// Units and table ownership

/** Unit ids the suites use, as `opt2/table-ownership.json` names them. */
export const UNITS = deepFreeze({
  groupAccount: 'identity.group_account',
  userAccount: 'identity.user_account',
  credential: 'identity.credential',
  loginState: 'identity.login_state',
  person: 'people.person',
  personArchive: 'people.person_archive',
  content: 'content.content',
  file: 'content.file',
  /** The file-store unit, which `fileUnitIds` of the migration config names; it is not a catalog unit. */
  fileObject: 'content.file_object',
  enrolment: 'programs_sites.enrolment',
  site: 'programs_sites.site',
  imageSize: 'programs_sites.image_size',
  mailingList: 'programs_sites.mailing_list',
  mailingListMember: 'programs_sites.mailing_list_member',
} as const);

/** One of the {@link UNITS} ids. */
export type FixtureUnitId = (typeof UNITS)[keyof typeof UNITS];

/** A target of an ownership table entry, as `opt2/table-ownership.json` records it. */
export interface OwnershipTargetDoc {
  unit: string;
  owner: string;
  schema: string;
  table: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
  ruleSteps: number[];
}

/** A legacy table entry of an ownership file. */
export interface OwnershipTableDoc {
  table: string;
  schema: string;
  origin: 'bootstrap' | 'migration' | 'fixture';
  liveCatalog: boolean;
  hasSiteId: boolean;
  siteIdColumn: string | null;
  hasPrimaryKey: boolean;
  primaryKey: string[];
  rowIdentity: 'key' | 'multiset';
  columns: string[];
  tenantResolution: string | null;
  owner: string;
  ruleSteps: number[];
  targets: OwnershipTargetDoc[];
  split?: { by: string; typeColumn: string };
  migrated?: boolean;
  programFold?: boolean;
  programSchemas?: string[];
}

/** A unit entry of an ownership file. */
export interface OwnershipUnitDoc {
  unit: string;
  owner: string;
  schema: string;
  table: string;
  legacyTables: string[];
  tenantOwned: boolean;
}

/** An ownership document in the `opt2/table-ownership.json` shape. */
export interface OwnershipDoc {
  sourceSha: string;
  schemaVersion: number;
  description: string;
  units: OwnershipUnitDoc[];
  tables: OwnershipTableDoc[];
}

const fixtureTable = (name: FixtureTableName): FixtureTable => TABLES[name];
const columnsOf = (name: FixtureTableName): string[] => fixtureTable(name).columns.map((column) => column.name);
const keyOf = (name: FixtureTableName): string[] => [...(fixtureTable(name).options.primaryKey ?? [])];

interface EntryInput {
  fixture: FixtureTableName;
  table?: string;
  origin: OwnershipTableDoc['origin'];
  owner: string;
  siteIdColumn: string | null;
  tenantResolution: string | null;
  /** Whole-table target; none for an unmigrated table. */
  unit?: string;
  extra?: Partial<OwnershipTableDoc>;
}

function ownershipEntry(input: EntryInput): OwnershipTableDoc {
  const table = input.table ?? TABLES[input.fixture].qualified.replace(/^dbo\./, '');
  const columns = columnsOf(input.fixture);
  const primaryKey = keyOf(input.fixture);
  const unit = input.unit;
  const targets: OwnershipTargetDoc[] =
    unit === undefined
      ? []
      : [
          {
            unit,
            owner: input.owner,
            schema: unit.slice(0, unit.indexOf('.')),
            table: unit.slice(unit.indexOf('.') + 1),
            rowPredicate: null,
            keyColumns: primaryKey,
            columnPolicy: 'whole-table',
            ownedColumns: columns,
            ruleSteps: [1],
          },
        ];
  return {
    table,
    schema: table.includes('.') ? table.slice(0, table.indexOf('.')) : 'dbo',
    origin: input.origin,
    liveCatalog: true,
    hasSiteId: input.siteIdColumn !== null,
    siteIdColumn: input.siteIdColumn,
    hasPrimaryKey: primaryKey.length > 0,
    primaryKey,
    rowIdentity: primaryKey.length > 0 ? 'key' : 'multiset',
    columns,
    tenantResolution: input.tenantResolution,
    owner: input.owner,
    ruleSteps: unit === undefined ? [] : [1],
    targets,
    ...input.extra,
  };
}

const USER_ACCOUNT_COLUMNS = ['UserID', 'UserName', 'Type', 'Admin', 'S2', 'Perm', 'InActive', 'isPublic', 'SiteID', 'remoteID', 'tablist'];
const CREDENTIAL_COLUMNS = ['Password', 'PasswordCreated'];
const LOGIN_STATE_COLUMNS = ['LastLogin'];
const IDENTITY_USER_COLUMNS = new Set([...USER_ACCOUNT_COLUMNS, ...CREDENTIAL_COLUMNS, ...LOGIN_STATE_COLUMNS]);

function tusersTarget(unit: string, owner: string, rowPredicate: string, ownedColumns: string[], keyColumns = ['UserID']): OwnershipTargetDoc {
  return {
    unit,
    owner,
    schema: unit.slice(0, unit.indexOf('.')),
    table: unit.slice(unit.indexOf('.') + 1),
    rowPredicate,
    keyColumns,
    columnPolicy: 'explicit',
    ownedColumns,
    ruleSteps: [1],
  };
}

// The tusers split of opt2/table-ownership.json: groups keep every column; for users each column has one owner.
const TUSERS_ENTRY: OwnershipTableDoc = {
  ...ownershipEntry({ fixture: 'tusers', origin: 'bootstrap', owner: 'split', siteIdColumn: 'SiteID', tenantResolution: 'siteID-or-umbrella' }),
  ruleSteps: [1],
  split: { by: 'Type+column', typeColumn: 'Type' },
  targets: [
    tusersTarget(UNITS.groupAccount, 'identity', 'Type = 1', columnsOf('tusers')),
    tusersTarget(UNITS.userAccount, 'identity', 'Type = 2', USER_ACCOUNT_COLUMNS),
    tusersTarget(UNITS.credential, 'identity', 'Type = 2', CREDENTIAL_COLUMNS),
    tusersTarget(UNITS.loginState, 'identity', 'Type = 2', LOGIN_STATE_COLUMNS),
    tusersTarget(
      UNITS.person,
      'people',
      'Type = 2',
      columnsOf('tusers').filter((column) => !IDENTITY_USER_COLUMNS.has(column)),
      ['UserID', 'SiteID'],
    ),
  ],
};

function unitDoc(unit: string, owner: string, legacyTables: string[]): OwnershipUnitDoc {
  return { unit, owner, schema: unit.slice(0, unit.indexOf('.')), table: unit.slice(unit.indexOf('.') + 1), legacyTables, tenantOwned: true };
}

/** Ownership of exactly the fixture tables, plus a decision-list and a retired table, in the `opt2/table-ownership.json` shape. */
export const FIXTURE_OWNERSHIP: OwnershipDoc = deepFreeze({
  sourceSha: TEST_SOURCE_SHA,
  schemaVersion: 1,
  description: 'Fixture ownership of the migration suites: the opt2/table-ownership.json entries of the fixture tables.',
  units: [
    unitDoc(UNITS.content, 'strategies-content', ['tcontent']),
    unitDoc(UNITS.file, 'strategies-content', ['tfiles']),
    unitDoc(UNITS.credential, 'identity', ['tusers']),
    unitDoc(UNITS.groupAccount, 'identity', ['tusers']),
    unitDoc(UNITS.loginState, 'identity', ['tusers']),
    unitDoc(UNITS.userAccount, 'identity', ['tusers']),
    unitDoc(UNITS.person, 'people', ['tusers']),
    unitDoc(UNITS.personArchive, 'people', ['synthetic.person_archive']),
    unitDoc(UNITS.enrolment, 'programs-sites', ['Program_N.enrolment']),
    unitDoc(UNITS.imageSize, 'programs-sites', ['timagesizes']),
    unitDoc(UNITS.mailingList, 'programs-sites', ['tmailinglist']),
    unitDoc(UNITS.mailingListMember, 'programs-sites', ['tmailinglistmembers']),
    unitDoc(UNITS.site, 'programs-sites', ['tsettings']),
  ],
  tables: [
    TUSERS_ENTRY,
    ownershipEntry({ fixture: 'tcontent', origin: 'bootstrap', owner: 'strategies-content', siteIdColumn: 'SiteID', tenantResolution: 'siteID-or-umbrella', unit: UNITS.content }),
    ownershipEntry({ fixture: 'tfiles', origin: 'bootstrap', owner: 'strategies-content', siteIdColumn: 'siteID', tenantResolution: 'siteID-or-umbrella', unit: UNITS.file }),
    ownershipEntry({ fixture: 'tsettings', origin: 'bootstrap', owner: 'programs-sites', siteIdColumn: 'SiteID', tenantResolution: 'siteID', unit: UNITS.site }),
    ownershipEntry({ fixture: 'timagesizes', origin: 'migration', owner: 'programs-sites', siteIdColumn: 'siteID', tenantResolution: 'siteID-or-umbrella', unit: UNITS.imageSize }),
    ownershipEntry({ fixture: 'tmailinglist', origin: 'bootstrap', owner: 'programs-sites', siteIdColumn: 'SiteID', tenantResolution: 'siteID-or-umbrella', unit: UNITS.mailingList }),
    ownershipEntry({
      fixture: 'tmailinglistmembers',
      origin: 'bootstrap',
      owner: 'programs-sites',
      siteIdColumn: 'SiteID',
      tenantResolution: 'siteID-or-umbrella',
      unit: UNITS.mailingListMember,
    }),
    ownershipEntry({
      fixture: 'synthetic.person_archive',
      origin: 'fixture',
      owner: 'people',
      siteIdColumn: 'siteID',
      tenantResolution: 'siteID',
      unit: UNITS.personArchive,
      extra: { migrated: true },
    }),
    ownershipEntry({
      fixture: 'Program_1.enrolment',
      table: 'Program_N.enrolment',
      origin: 'fixture',
      owner: 'programs-sites',
      siteIdColumn: null,
      tenantResolution: 'program_site',
      unit: UNITS.enrolment,
      extra: { migrated: true, programFold: true, programSchemas: ['Program_1', 'Program_2'] },
    }),
    // Not migrated: the fold mapping each Program_<id> schema resolves its site through.
    ownershipEntry({
      fixture: 'synthetic.program_site',
      origin: 'fixture',
      owner: 'programs-sites',
      siteIdColumn: 'siteID',
      tenantResolution: null,
      extra: { migrated: false, ruleSteps: [1] },
    }),
    {
      table: 'tcontenteventreminders',
      schema: 'dbo',
      origin: 'bootstrap',
      liveCatalog: true,
      hasSiteId: true,
      siteIdColumn: 'siteId',
      hasPrimaryKey: false,
      primaryKey: [],
      rowIdentity: 'multiset',
      columns: ['contentId', 'siteId', 'email', 'RemindDate', 'RemindHour', 'RemindMinute', 'RemindInterval', 'isSent'],
      tenantResolution: null,
      owner: 'decision-list',
      ruleSteps: [5],
      targets: [],
    },
    {
      table: 'tglobals',
      schema: 'dbo',
      origin: 'bootstrap',
      liveCatalog: false,
      hasSiteId: false,
      siteIdColumn: null,
      hasPrimaryKey: false,
      primaryKey: [],
      rowIdentity: 'multiset',
      columns: ['appreload', 'loadlist'],
      tenantResolution: null,
      owner: 'retired',
      ruleSteps: [],
      targets: [],
    },
  ],
});

/** Every catalog unit of {@link FIXTURE_OWNERSHIP}, sorted; `UNITS.fileObject` is not among them. */
export const UNIT_IDS: readonly string[] = deepFreeze(sortedUnique(FIXTURE_OWNERSHIP.units.map((unit) => unit.unit)));

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Writes {@link FIXTURE_OWNERSHIP} as `table-ownership.json` under `dir` (created when missing) and returns its path. */
export async function writeOwnershipFile(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(path.resolve(dir), 'table-ownership.json');
  await writeJson(file, FIXTURE_OWNERSHIP);
  return file;
}

/** A fresh unit catalog of {@link FIXTURE_OWNERSHIP}, loaded by `loadUnitCatalog` from a temporary file it then removes. */
export async function fixtureCatalog(): Promise<UnitCatalog> {
  const dirs = await createTestDirs();
  try {
    return loadUnitCatalog(await writeOwnershipFile(dirs.stateDir));
  } finally {
    await dirs.cleanup();
  }
}

/** The unit catalog of {@link FIXTURE_OWNERSHIP}, loaded once when this module is imported; catalogs are immutable. */
export const FIXTURE_CATALOG: UnitCatalog = await fixtureCatalog();

// Cut-over groups and versions

/** Group ids of {@link fixtureGroups}, each `grp:<smallest unit id>`. */
export const FIXTURE_GROUP_IDS = deepFreeze({
  /** Holds the write entry of `admin:clogin.login`, so its authority decides the session mode. */
  login: `grp:${UNITS.groupAccount}`,
  /** The people roster create and edit, over the person and its identity account and credential. */
  roster: `grp:${UNITS.credential}`,
  /** The fixture archive route. */
  archive: `grp:${UNITS.personArchive}`,
  content: `grp:${UNITS.content}`,
  programsSites: `grp:${UNITS.imageSize}`,
  /** No carry write entry, so it stays `legacy` in every version. */
  mailingLists: `grp:${UNITS.mailingList}`,
  /** The folded program table; no write entry, so it stays `legacy` in every version. */
  enrolment: `grp:${UNITS.enrolment}`,
} as const);

/** Route keys of the fixture cut-over entries, canonical lower case. */
export const FIXTURE_ROUTES = deepFreeze({
  login: LOGIN_ROUTE_KEY,
  groupUpdate: 'admin:cusers.update{type=1}',
  rosterAdd: 'admin:cusers.update{type=2,action=add}',
  rosterUpdate: 'admin:cusers.update{type=2,action=update}',
  archive: 'fixture:people/persons/{id}/archive@post',
  archiveRead: 'fixture:people/persons/{id}/archive@get',
  contentUpdate: 'admin:carch.update',
  contentRead: 'api:content.findone',
  imageUpload: 'admin:carch.update{upload=image}',
  siteUpdate: 'admin:csettings.updatesite{action=update}',
  siteEdit: 'admin:csettings.editsite',
  siteDelete: 'admin:csettings.updatesite{action=delete}',
  listUsers: 'admin:cusers.listusers',
  mailingLists: 'admin:cmailinglist.list',
  siteMonitor: 'sitemonitor:run',
  adminAssets: 'static:/admin/assets/**',
} as const);

const GROUP_DEFINITIONS: readonly CutoverGroup[] = deepFreeze([
  {
    id: FIXTURE_GROUP_IDS.login,
    units: [UNITS.groupAccount, UNITS.loginState],
    writeEntries: [FIXTURE_ROUTES.login, FIXTURE_ROUTES.groupUpdate],
    hasCarryWrite: true,
  },
  {
    id: FIXTURE_GROUP_IDS.roster,
    units: [UNITS.credential, UNITS.userAccount, UNITS.person],
    writeEntries: [FIXTURE_ROUTES.rosterAdd, FIXTURE_ROUTES.rosterUpdate],
    hasCarryWrite: true,
  },
  { id: FIXTURE_GROUP_IDS.archive, units: [UNITS.personArchive], writeEntries: [FIXTURE_ROUTES.archive], hasCarryWrite: true },
  { id: FIXTURE_GROUP_IDS.content, units: [UNITS.content, UNITS.file], writeEntries: [FIXTURE_ROUTES.contentUpdate], hasCarryWrite: true },
  { id: FIXTURE_GROUP_IDS.programsSites, units: [UNITS.imageSize, UNITS.site], writeEntries: [FIXTURE_ROUTES.siteUpdate], hasCarryWrite: true },
  { id: FIXTURE_GROUP_IDS.mailingLists, units: [UNITS.mailingList, UNITS.mailingListMember], writeEntries: [], hasCarryWrite: false },
  { id: FIXTURE_GROUP_IDS.enrolment, units: [UNITS.enrolment], writeEntries: [], hasCarryWrite: false },
]);

/** The fixture `groups.json`: every catalog unit in exactly one group, sorted as `build-groups.ts` sorts it. */
export function fixtureGroups(): GroupsFile {
  return {
    sourceSha: TEST_SOURCE_SHA,
    generatedBy: 'migration/test/helpers/fixtures.ts',
    inputs: { inventorySha256: '0'.repeat(64), tableOwnershipSha256: '0'.repeat(64) },
    groups: GROUP_DEFINITIONS.map((group) => ({
      id: group.id,
      units: sortedUnique(group.units),
      writeEntries: sortedUnique(group.writeEntries),
      hasCarryWrite: group.hasCarryWrite,
    })).sort((a, b) => byCodeUnit(a.id, b.id)),
  };
}

type EntryTemplate = Omit<CutoverEntry, 'tableVersion' | 'state'>;

const SITE_DELETE_UNITS = [
  UNITS.mailingList,
  UNITS.mailingListMember,
  UNITS.content,
  UNITS.file,
  UNITS.credential,
  UNITS.groupAccount,
  UNITS.loginState,
  UNITS.userAccount,
  UNITS.person,
  UNITS.imageSize,
  UNITS.site,
];

function writeEntry(route: string, owningService: string, group: string, units: string[]): EntryTemplate {
  return { route, owningService, kind: 'write', group, units: sortedUnique(units), disposition: 'carry' };
}

function readEntry(route: string, owningService: string, units: string[], disposition: CutoverEntry['disposition'] = 'carry'): EntryTemplate {
  return { route, owningService, kind: 'read', group: null, units: sortedUnique(units), disposition };
}

const TEMPLATES: EntryTemplate[] = [
  writeEntry(FIXTURE_ROUTES.login, 'identity', FIXTURE_GROUP_IDS.login, [UNITS.groupAccount, UNITS.loginState]),
  writeEntry(FIXTURE_ROUTES.groupUpdate, 'identity', FIXTURE_GROUP_IDS.login, [UNITS.groupAccount]),
  writeEntry(FIXTURE_ROUTES.rosterAdd, 'people', FIXTURE_GROUP_IDS.roster, [UNITS.credential, UNITS.userAccount, UNITS.person]),
  writeEntry(FIXTURE_ROUTES.rosterUpdate, 'people', FIXTURE_GROUP_IDS.roster, [UNITS.credential, UNITS.userAccount, UNITS.person]),
  writeEntry(FIXTURE_ROUTES.archive, 'people', FIXTURE_GROUP_IDS.archive, [UNITS.personArchive]),
  writeEntry(FIXTURE_ROUTES.contentUpdate, 'strategies-content', FIXTURE_GROUP_IDS.content, [UNITS.content, UNITS.file]),
  writeEntry(FIXTURE_ROUTES.siteUpdate, 'programs-sites', FIXTURE_GROUP_IDS.programsSites, [UNITS.imageSize, UNITS.site]),
  readEntry(FIXTURE_ROUTES.listUsers, 'people', [UNITS.userAccount, UNITS.person]),
  readEntry(FIXTURE_ROUTES.archiveRead, 'people', [UNITS.person, UNITS.personArchive]),
  readEntry(FIXTURE_ROUTES.contentRead, 'strategies-content', [UNITS.content]),
  readEntry(FIXTURE_ROUTES.siteEdit, 'programs-sites', [UNITS.imageSize, UNITS.site]),
  readEntry(FIXTURE_ROUTES.mailingLists, 'programs-sites', [UNITS.mailingList, UNITS.mailingListMember], 'legacy-served'),
  { route: FIXTURE_ROUTES.imageUpload, owningService: 'none', kind: 'legacy-write', group: null, units: [UNITS.content, UNITS.file], disposition: 'decision' },
  {
    route: FIXTURE_ROUTES.siteDelete,
    owningService: 'programs-sites',
    kind: 'legacy-write',
    group: null,
    units: sortedUnique(SITE_DELETE_UNITS),
    disposition: 'decision',
  },
  { route: FIXTURE_ROUTES.siteMonitor, owningService: 'programs-sites', kind: 'job', group: null, units: [UNITS.content, UNITS.file], disposition: 'carry' },
  { route: FIXTURE_ROUTES.adminAssets, owningService: 'none', kind: 'static', group: null, units: [], disposition: 'legacy-served' },
];
const ENTRY_TEMPLATES: readonly EntryTemplate[] = deepFreeze(TEMPLATES.sort((a, b) => byCodeUnit(a.route, b.route)));

/** Group authority with every fixture group present: `legacy` unless `authority` names it. */
function completeAuthority(authority: Readonly<Record<string, Authority>>): Record<string, Authority> {
  const all: Record<string, Authority> = Object.fromEntries(GROUP_DEFINITIONS.map((group) => [group.id, 'legacy']));
  return Object.fromEntries(Object.entries({ ...all, ...authority }).sort(([a], [b]) => byCodeUnit(a, b)));
}

// State rules of the gateway's validator: a write follows its group; a carry read is target only when all its units
// are; legacy-write and legacy-served entries stay legacy; the job is legacy in v0001 and target afterwards.
function stateOf(
  template: EntryTemplate,
  tableVersion: string,
  groupAuthority: Readonly<Record<string, Authority>>,
  unitAuthority: ReadonlyMap<string, Authority>,
): Authority {
  switch (template.kind) {
    case 'write':
      return template.group === null || template.group === undefined ? 'legacy' : (groupAuthority[template.group] ?? 'legacy');
    case 'read':
      return template.disposition === 'carry' && template.units.length > 0 && template.units.every((unit) => unitAuthority.get(unit) === 'target')
        ? 'target'
        : 'legacy';
    case 'job':
      return tableVersion === 'v0001' ? 'legacy' : 'target';
    default:
      return 'legacy';
  }
}

/** The fixture route set under `groupAuthority`, each entry stamped with `tableVersion`. */
export function fixtureEntries(tableVersion: string, groupAuthority: Readonly<Record<string, Authority>> = {}): CutoverEntry[] {
  const authority = completeAuthority(groupAuthority);
  const unitAuthority = new Map(GROUP_DEFINITIONS.flatMap((group) => group.units.map((unit) => [unit, authority[group.id] ?? 'legacy'] as const)));
  return ENTRY_TEMPLATES.map((template) => ({
    ...template,
    units: [...template.units],
    tableVersion,
    state: stateOf(template, tableVersion, authority, unitAuthority),
  }));
}

/** Settings of {@link fixtureVersion} beyond authority and entries. */
export interface FixtureVersionOptions {
  /** Defaults to the preceding `vNNNN`, or null for `v0001`. */
  previous?: string | null;
  rollbackRefs?: RollbackRef[];
  createdAt?: string;
}

function precedingVersion(name: string): string | null {
  const number = /^v(\d{4})$/.exec(name)?.[1];
  if (number === undefined) throw new Error(`Cut-over version "${name}" does not match vNNNN`);
  const previous = Number(number) - 1;
  return previous < 1 ? null : `v${String(previous).padStart(4, '0')}`;
}

/**
 * A cut-over version bound to the pin: every fixture group in `groupAuthority` (`legacy` unless given) and `entries`
 * (default {@link fixtureEntries}), each stamped with `name`.
 */
export function fixtureVersion(
  name: string,
  groupAuthority: Readonly<Record<string, Authority>> = {},
  entries?: readonly CutoverEntry[],
  opts: FixtureVersionOptions = {},
): CutoverVersion {
  const authority = completeAuthority(groupAuthority);
  return {
    tableVersion: name,
    previous: opts.previous === undefined ? precedingVersion(name) : opts.previous,
    sourceSha: TEST_SOURCE_SHA,
    createdAt: opts.createdAt ?? FIXTURE_CREATED_AT,
    groupAuthority: authority,
    rollbackRefs: (opts.rollbackRefs ?? []).map((ref) => ({ ...ref })),
    entries:
      entries === undefined
        ? fixtureEntries(name, authority)
        : entries.map((entry) => ({ ...entry, units: [...entry.units], tableVersion: name })),
  };
}

const CARRY_TARGET: Record<string, Authority> = Object.fromEntries(
  GROUP_DEFINITIONS.filter((group) => group.hasCarryWrite).map((group) => [group.id, 'target']),
);

/** The roster rollback set R: the groups of the roster and archive routes, which `V0003` returns to legacy. */
export const ROLLBACK_GROUPS: readonly string[] = deepFreeze(sortedUnique([FIXTURE_GROUP_IDS.roster, FIXTURE_GROUP_IDS.archive]));

/** Every group `legacy`; the job entry `legacy`. */
export const V0001: CutoverVersion = deepFreeze(fixtureVersion('v0001'));

/** Every group with a carry write `target`; the job entry `target`. */
export const V0002: CutoverVersion = deepFreeze(fixtureVersion('v0002', CARRY_TARGET));

/** `V0002` with the roster and archive groups back on `legacy`, the login group kept `target`. */
export const V0003: CutoverVersion = deepFreeze(
  fixtureVersion(
    'v0003',
    { ...CARRY_TARGET, ...Object.fromEntries(ROLLBACK_GROUPS.map((id) => [id, 'legacy' as const])) },
    undefined,
    {
      rollbackRefs: [
        {
          groups: [...ROLLBACK_GROUPS],
          rollbackSet: [...ROLLBACK_GROUPS],
          report: 'opt2/reports/reconciliation/rollback-before.json',
          evidence: ['migration/runbooks/people-roster-rollback.md', 'opt2/reports/reconciliation/rollback-before.json'],
        },
      ],
    },
  ),
);

/** Content `target`, every other group `legacy`. */
export const VA: CutoverVersion = deepFreeze(fixtureVersion('v0101', { [FIXTURE_GROUP_IDS.content]: 'target' }));

/** `VA` with the programs-sites group also `target`: the two differ in that one group. */
export const VB: CutoverVersion = deepFreeze(
  fixtureVersion('v0102', { [FIXTURE_GROUP_IDS.content]: 'target', [FIXTURE_GROUP_IDS.programsSites]: 'target' }),
);

/** Settings of {@link writeCutoverDir}. */
export interface WriteCutoverDirOptions {
  /** Default V0001, V0002, V0003, VA and VB. */
  versions?: readonly CutoverVersion[];
  /** Default {@link fixtureGroups}. */
  groups?: GroupsFile;
  /** Directory to write into; default a fresh one from `createTestDirs()`. */
  dir?: string;
}

/** A written cut-over directory; `cleanup` removes a directory this module created and leaves a given `dir` alone. */
export interface FixtureCutoverDir {
  cutoverDir: string;
  groupsFile: string;
  cleanup(): Promise<void>;
}

/** Writes `versions/<tableVersion>.json`, `groups.json` and copies of the committed schema and variants, as the gateway's cut-over directory holds them. */
export async function writeCutoverDir(opts: WriteCutoverDirOptions = {}): Promise<FixtureCutoverDir> {
  const dirs = opts.dir === undefined ? await createTestDirs() : undefined;
  try {
    const cutoverDir = dirs === undefined ? path.resolve(opts.dir ?? '') : path.join(dirs.stateDir, 'cutover');
    const groupsFile = path.join(cutoverDir, 'groups.json');
    const committed = loadConfig().paths.cutoverDir;
    await mkdir(path.join(cutoverDir, 'versions'), { recursive: true });
    await Promise.all([
      copyFile(path.join(committed, 'cutover-table.schema.json'), path.join(cutoverDir, 'cutover-table.schema.json')),
      copyFile(path.join(committed, 'variants.json'), path.join(cutoverDir, 'variants.json')),
      writeJson(groupsFile, opts.groups ?? fixtureGroups()),
      ...(opts.versions ?? [V0001, V0002, V0003, VA, VB]).map((version) =>
        writeJson(path.join(cutoverDir, 'versions', `${version.tableVersion}.json`), version),
      ),
    ]);
    return { cutoverDir, groupsFile, cleanup: dirs === undefined ? () => Promise.resolve() : dirs.cleanup };
  } catch (error) {
    await dirs?.cleanup();
    throw error;
  }
}

// Scheduler capture

/** Webroot of the fixture ColdFusion server, which names Masa's ACF monitor task. */
const LEGACY_WEBROOT = '/srv/masa';

/** Gateway origin the bridge double re-points restored tasks at, as `OPT2_GATEWAY_ORIGIN` sets it. */
export const FIXTURE_GATEWAY_ORIGIN = 'http://127.0.0.1:8100';

/** Masa's monitor task name on ACF (onApplicationStart_include.cfm:556-560). */
export const SITE_MONITOR_TASK = `${LEGACY_WEBROOT}/index.cfm/_api/sitemonitor/`;

/** Names of the capture's two tasks beside the monitor, which an operator scheduled and the hand-off leaves alone. */
export const OPERATOR_TASKS = deepFreeze(['ops-cache-warm', 'ops-link-check'] as const);

/** Captured ACF tasks in the bridge wire shape, sorted by name as `normaliseNativeTasksFile` sorts them. */
const CAPTURED_TASKS: readonly ScheduledTaskDefinition[] = [
  // onApplicationStart_include.cfm:561-575: the URL takes the host without its port, which goes in `port`.
  {
    task: SITE_MONITOR_TASK,
    group: 'default',
    url: 'http://127.0.0.1/index.cfm/_api/sitemonitor/',
    port: '8080',
    interval: '900',
    startDate: '06/01/2026',
    startTime: '00:15:00',
    requestTimeOut: '600',
    operation: 'HTTPRequest',
    paused: false,
  },
  {
    task: OPERATOR_TASKS[0],
    group: 'default',
    url: 'http://127.0.0.1/ops/cache-warm.cfm?siteid=tenant-a',
    port: '8080',
    interval: 'once',
    startDate: '07/01/2026',
    startTime: '09:00:00',
    requestTimeOut: '600',
    operation: 'HTTPRequest',
    paused: false,
  },
  {
    task: OPERATOR_TASKS[1],
    group: 'default',
    url: 'http://127.0.0.1/ops/link-check.cfm',
    port: '8080',
    interval: 'daily',
    startDate: '07/02/2026',
    startTime: '09:00:00',
    requestTimeOut: '600',
    operation: 'HTTPRequest',
    paused: false,
  },
];

/** The first-run capture in the `native-tasks.json` form: Masa's monitor task with `ping` on, plus the two operator tasks. */
export const NATIVE_TASKS_SAMPLE: NativeTasksFile = deepFreeze({
  capturedAt: FIXTURE_CREATED_AT,
  originalPing: true,
  siteMonitorTask: SITE_MONITOR_TASK,
  tasks: CAPTURED_TASKS.map((task) => ({ ...task })),
});

/** The same capture in the raw `box cfconfig export` form: `scheduledTasks` keyed by name, `URL`, numeric `httpPort` and a status. */
export const BOX_CFCONFIG_EXPORT_SAMPLE = deepFreeze({
  capturedAt: FIXTURE_CREATED_AT,
  ping: true,
  siteMonitorTask: SITE_MONITOR_TASK,
  scheduledTasks: Object.fromEntries(
    CAPTURED_TASKS.map((task) => [
      task.task,
      {
        task: task.task,
        group: task.group,
        URL: task.url,
        httpPort: Number(task.port),
        interval: /^\d+$/.test(task.interval) ? Number(task.interval) : task.interval,
        startDate: task.startDate,
        startTime: task.startTime,
        requestTimeOut: Number(task.requestTimeOut),
        status: task.paused ? 'Paused' : 'Running',
      },
    ]),
  ),
});

// Order inventory

function relation(kind: OrderRelation['kind'], child: string, parent: string, source: OrderRelation['source']): OrderRelation {
  const [childTable = '', childColumn = ''] = splitColumn(child);
  const [parentTable = '', parentColumn = ''] = splitColumn(parent);
  return {
    id: `rel:${child}->${parent}`,
    kind,
    child: { table: childTable, column: childColumn },
    parent: { table: parentTable, column: parentColumn },
    ...(source === undefined ? {} : { source }),
  };
}

/** `<table>.<column>` split at its last dot. */
function splitColumn(qualifiedColumn: string): [string, string] {
  const dot = qualifiedColumn.lastIndexOf('.');
  return [qualifiedColumn.slice(0, dot), qualifiedColumn.slice(dot + 1)];
}

/** Tables and code relations of the fixture tables, as the legacy inventory records them; tcontent and tfiles reference each other. */
export const FIXTURE_INVENTORY: OrderInventory = deepFreeze({
  tables: [
    { table: 'tsettings', hasSiteId: true },
    { table: 'tusers', hasSiteId: true },
    { table: 'tcontent', hasSiteId: true },
    { table: 'tfiles', hasSiteId: true },
    { table: 'timagesizes', hasSiteId: true },
    { table: 'tmailinglist', hasSiteId: true },
    { table: 'tmailinglistmembers', hasSiteId: true },
    { table: 'synthetic.program_site', hasSiteId: true },
    { table: 'synthetic.person_archive', hasSiteId: true },
    { table: 'Program_N.enrolment', hasSiteId: false },
  ],
  relations: [
    relation('daoJoin', 'tusers.SiteID', 'tsettings.SiteID', { path: 'core/mura/user/userGateway.cfc', lines: [599, 599] }),
    relation('beanORM', 'tcontent.SiteID', 'tsettings.SiteID', { path: 'core/mura/content/contentBean.cfc', lines: [84, 84] }),
    relation('beanORM', 'tfiles.contentID', 'tcontent.ContentID', { path: 'core/mura/content/file/fileBean.cfc', lines: [4, 4] }),
    // The back-reference of the cycle; FileID is not part of the tcontent key, so the order defers it.
    relation('daoJoin', 'tcontent.FileID', 'tfiles.fileID', { path: 'core/mura/category/categoryGateway.cfc', lines: [193, 193] }),
    relation('daoJoin', 'tmailinglistmembers.MLID', 'tmailinglist.MLID', { path: 'core/mura/email/emailUtility.cfc', lines: [639, 639] }),
    relation('programFk', 'Program_N.enrolment.archive_id', 'synthetic.person_archive.archive_id', undefined),
  ],
});

/** Site-monitor steps and their write sets in the inventory's unit form, read by `legacyStepUnits`. */
export const FIXTURE_SCHEDULED_JOBS = deepFreeze([
  {
    routeKey: FIXTURE_ROUTES.siteMonitor,
    steps: [
      { step: 'reminders', writeSet: [{ unit: 'legacy:tcontenteventreminders' }] },
      { step: 'email-send', writeSet: [] },
      { step: 'changeset-publish', writeSet: [{ unit: UNITS.content }] },
      { step: 'bounces', writeSet: [] },
      { step: 'feed-import', writeSet: [{ unit: UNITS.content }] },
      { step: 'cache-purge', writeSet: [] },
      { step: 'cluster-cleanup', writeSet: [{ unit: 'legacy:tclustercommands' }] },
      { step: 'plugin-events', writeSet: [] },
    ],
  },
]);

/** {@link FIXTURE_INVENTORY} without the tables `catalog` does not record, such as the fold tables for the committed ownership, and their relations. */
export function fixtureInventoryFor(catalog: Pick<UnitCatalog, 'isMigratable'>): OrderInventory {
  const recorded = (table: string): boolean => {
    try {
      catalog.isMigratable(table);
      return true;
    } catch (error) {
      if (error instanceof UnknownLegacyTableError) return false;
      throw error;
    }
  };
  return {
    tables: FIXTURE_INVENTORY.tables.filter(({ table }) => recorded(table)),
    relations: FIXTURE_INVENTORY.relations.filter(({ child, parent }) => recorded(child.table) && recorded(parent.table)),
  };
}

/** Writes `inventory`, {@link FIXTURE_INVENTORY} by default, with {@link FIXTURE_SCHEDULED_JOBS} as `legacy-inventory.json` under `dir` and returns its path. */
export async function writeInventoryFile(dir: string, inventory: OrderInventory = FIXTURE_INVENTORY): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(path.resolve(dir), 'legacy-inventory.json');
  await writeJson(file, { sourceSha: TEST_SOURCE_SHA, ...inventory, scheduledJobs: FIXTURE_SCHEDULED_JOBS });
  return file;
}

// Target tables and mappings

const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };

/** Repository definition of the keyed fixture target `image_size`. */
export const TIMAGESIZES_TABLE: TableDefinition = deepFreeze({
  table: 'image_size',
  columns: [
    TENANT_ID,
    { name: 'sizeid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'height', type: 's' },
    { name: 'width', type: 's' },
  ],
  key: ['sizeid'],
  unit: UNITS.imageSize,
});

/** Repository definition of the keyless fixture target `mailing_list_member`. */
export const MAILINGLIST_MEMBERS_TABLE: TableDefinition = deepFreeze({
  table: 'mailing_list_member',
  columns: [
    TENANT_ID,
    { name: 'mlid', type: 's' },
    { name: 'email', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'fname', type: 's' },
    { name: 'lname', type: 's' },
    { name: 'company', type: 's' },
    { name: 'isverified', type: 'i' },
    { name: 'created', type: 't' },
    { name: 'legacy_row_hash', type: 's' },
    { name: 'occurrence', type: 'i' },
  ],
  key: null,
  unit: UNITS.mailingListMember,
});

/** Both fixture target tables. */
export const FIXTURE_TARGET_TABLES: readonly TableDefinition[] = deepFreeze([TIMAGESIZES_TABLE, MAILINGLIST_MEMBERS_TABLE]);

/** `timagesizes` ↔ `programs_sites.image_size`, keyed on `sizeID`, tenant from the row's `siteID`. */
export const TIMAGESIZES_MAPPING: MappingSpec = deepFreeze({
  legacyTable: 'timagesizes',
  targetTable: UNITS.imageSize,
  unit: UNITS.imageSize,
  columns: [
    { legacy: 'sizeID', target: 'sizeid', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'name', target: 'name', type: 's' },
    { legacy: 'height', target: 'height', type: 's' },
    { legacy: 'width', target: 'width', type: 's' },
  ],
  key: ['sizeID'],
  tenant: { kind: 'site', column: 'siteID' },
});

/** `tmailinglistmembers` ↔ `programs_sites.mailing_list_member`, keyless, tenant from the row's `SiteID`. */
export const MAILINGLIST_MEMBERS_MAPPING: MappingSpec = deepFreeze({
  legacyTable: 'tmailinglistmembers',
  targetTable: UNITS.mailingListMember,
  unit: UNITS.mailingListMember,
  columns: [
    { legacy: 'MLID', target: 'mlid', type: 's' },
    { legacy: 'Email', target: 'email', type: 's' },
    { legacy: 'SiteID', target: 'siteid', type: 's' },
    { legacy: 'fname', target: 'fname', type: 's' },
    { legacy: 'lname', target: 'lname', type: 's' },
    { legacy: 'company', target: 'company', type: 's' },
    { legacy: 'isVerified', target: 'isverified', type: 'i' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: null,
  tenant: { kind: 'site', column: 'SiteID' },
});

/** PostgreSQL DDL of both fixture target tables in `schema`, each with RLS enabled and forced by the tenancy helper. */
export function fixtureTargetDdl(schema: string): string {
  return [
    `CREATE TABLE ${schema}.${TIMAGESIZES_TABLE.table} (`,
    '  tenant_id uuid NOT NULL,',
    '  sizeid char(35) NOT NULL,',
    '  siteid text,',
    '  name text,',
    '  height text,',
    '  width text,',
    '  PRIMARY KEY (tenant_id, sizeid)',
    ');',
    rlsSql(schema, TIMAGESIZES_TABLE.table),
    `CREATE TABLE ${schema}.${MAILINGLIST_MEMBERS_TABLE.table} (`,
    '  tenant_id uuid NOT NULL,',
    '  mlid char(35),',
    '  email text,',
    '  siteid text,',
    '  fname text,',
    '  lname text,',
    '  company text,',
    '  isverified smallint NOT NULL,',
    '  created timestamp(3) without time zone,',
    '  legacy_row_hash text NOT NULL,',
    '  occurrence integer NOT NULL,',
    '  PRIMARY KEY (tenant_id, legacy_row_hash, occurrence)',
    ');',
    rlsSql(schema, MAILINGLIST_MEMBERS_TABLE.table),
  ].join('\n');
}
