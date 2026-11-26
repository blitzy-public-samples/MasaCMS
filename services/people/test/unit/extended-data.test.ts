/** Extended attributes over the people repository's SQL: the extendManager rules on a recording database holding tenant-a's seeded User extension. */
import { describe, expect, it } from 'vitest';
import type { WriteContext } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import {
  EXTEND_CONFIG_DEFAULTS,
  UnsupportedBranchError,
  assertNoFileAttributeWrites,
  castColumnFor,
  deleteExtendedData,
  extendSetData,
  loadSubmittedAttributes,
  saveExtendedData,
  validateExtendedData,
  type CastColumn,
  type ExtendConfig,
  type ExtendSaveContext,
  type ExtendedAttribute,
} from '../../src/domain/extended-data.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import type { ExtendAttributeRow, ExtendDataRow, ExtendSetRow, ExtendSubtypeRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, createRecordingDb, type RecordingDb } from '../helpers/app.js';
import { DEFAULT_PEOPLE_SEED, extendAttributeRow, extendDataRow, extendSetRow, extendSubtypeRow } from '../helpers/fixtures.js';

const TENANT = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const WRITE: WriteContext = { actorUserId: 'ACTOR-EXT', requestId: 'REQ-EXT-1' };
// Masa saves user and address values to tclassextenddatauseractivity, not tclassextenddata (people.extend_data).
const DATA_TABLE = 'extend_data_user_activity';
const repo = createPeopleRepository({ clock: TEST_CLOCK });

/** The first row of `rows` that `match` selects; throws when tenant-a's seed lacks it. */
function seeded<R>(rows: readonly R[] | undefined, match: (row: R) => boolean, what: string): R {
  const row = rows?.find(match);
  if (row === undefined) throw new Error(`DEFAULT_PEOPLE_SEED holds no ${what} for tenant-a`);
  return row;
}

const SEED = DEFAULT_PEOPLE_SEED[TENANT];
const USER_SUBTYPE = seeded(SEED?.extendSubtypes, (row) => row.type === 'User', 'User subtype');
const USER_SET = seeded(SEED?.extendSets, (row) => row.subtypeid === USER_SUBTYPE.subtypeid, 'User set');
const seededAttribute = (name: string): ExtendAttributeRow => seeded(SEED?.extendAttributes, (row) => row.name === name, `attribute ${name}`);
const REQUIRED = seededAttribute('employeeNumber');
const REGEX = seededAttribute('badgeCode');
const PHOTO = seededAttribute('badgePhoto');
const SEEDED_DATA: readonly ExtendDataRow[] = SEED?.extendData ?? [];
const USER_ID = seeded(SEEDED_DATA, (row) => row.attributeid === REQUIRED.attributeid, 'stored value').baseid;

const PROFILE_SET = extendSetRow({ subtypeid: USER_SUBTYPE.subtypeid, name: 'Profile', orderno: 2 });
const SHOE = extendAttributeRow({
  extendsetid: PROFILE_SET.extendsetid,
  name: 'shoeSize',
  orderno: 1,
  validation: 'Numeric',
  message: 'Shoe size must be a number.',
  defaultvalue: '10',
});
const START = extendAttributeRow({ extendsetid: PROFILE_SET.extendsetid, name: 'startDate', orderno: 2, validation: 'Date' });
const ADDRESS_SUBTYPE = extendSubtypeRow({ type: 'Address' });
const ADDRESS_SET = extendSetRow({ subtypeid: ADDRESS_SUBTYPE.subtypeid, name: 'Delivery' });
const GATE_CODE = extendAttributeRow({ extendsetid: ADDRESS_SET.extendsetid, name: 'gateCode', defaultvalue: '0000' });
// Fixture builders mint CF UUIDs; these stand for tfiles ids.
const FILE_ID = extendDataRow().baseid;
const OTHER_FILE_ID = extendDataRow().baseid;
const STORED_PHOTO = extendDataRow({ baseid: USER_ID, attributeid: PHOTO.attributeid, attributevalue: FILE_ID });
const BOTH_SETS = `${USER_SET.extendsetid},${PROFILE_SET.extendsetid}`;

const DELETED = [`delete people.${DATA_TABLE}`, `changelog delete ${DATA_TABLE}`];
const INSERTED = [`insert people.${DATA_TABLE}`, `changelog insert ${DATA_TABLE}`];

/** The repository statement of `table` whose collapsed text starts with `head`. */
const statementOf = (head: string, table: string): RegExp => new RegExp(`^${head} "people"\\."${table}" `);
const SUBTYPE_READ = statementOf('SELECT \\* FROM', 'extend_subtype');
const SET_READ = statementOf('SELECT \\* FROM', 'extend_set');
const ATTRIBUTE_READ = statementOf('SELECT \\* FROM', 'extend_attribute');
const DATA_READ = statementOf('SELECT \\* FROM', DATA_TABLE);
const LOCK_BY_BASE = statementOf('SELECT dataid FROM', DATA_TABLE);
const LOCK_BY_ATTRIBUTES = statementOf('SELECT dataid, attributeid FROM', DATA_TABLE);
const DATA_INSERT = statementOf('INSERT INTO', DATA_TABLE);
const DATA_DELETE = statementOf('DELETE FROM', DATA_TABLE);
const CHANGELOG_INSERT = statementOf('INSERT INTO', 'changelog');
const NEXT_IDS = /^SELECT nextval\(pg_get_serial_sequence/;

interface ExtendTables {
  subtypes: ExtendSubtypeRow[];
  sets: ExtendSetRow[];
  attributes: ExtendAttributeRow[];
  data: ExtendDataRow[];
}

/** Fresh copies of the seeded User extension, the Profile set and an Address subtype, holding `data`. */
function userTables(data: readonly ExtendDataRow[] = SEEDED_DATA, extraAttributes: readonly ExtendAttributeRow[] = []): ExtendTables {
  return {
    subtypes: [USER_SUBTYPE, ADDRESS_SUBTYPE],
    sets: [USER_SET, PROFILE_SET, ADDRESS_SET],
    attributes: [REQUIRED, REGEX, PHOTO, SHOE, START, GATE_CODE, ...extraAttributes],
    data: [...data],
  };
}

/** SQL Server char and varchar equality: case-insensitive, trailing spaces ignored. */
function sameId(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.replace(/ +$/, '').toLowerCase() === b.replace(/ +$/, '').toLowerCase();
}

/** A NULL array parameter matches every row, as the repository's `$n IS NULL OR …` terms do. */
function listed(list: unknown, value: unknown): boolean {
  return list === null || (list as readonly unknown[]).some((item) => sameId(item, value));
}

/** A recording database answering the people extend-table statements from `tables`, which its inserts and deletes change. */
function extendDb(tables: ExtendTables): RecordingDb {
  const db = createRecordingDb();
  let nextDataId = 5000;
  const stored = (tenant: unknown, baseId: unknown): ExtendDataRow[] =>
    tables.data.filter((row) => row.tenant_id === tenant && sameId(row.baseid, baseId)).sort((a, b) => a.attributeid - b.attributeid || a.dataid - b.dataid);
  db.respond(SUBTYPE_READ, (_text, [tenant, siteId]) => tables.subtypes.filter((row) => row.tenant_id === tenant && sameId(row.siteid, siteId)));
  db.respond(SET_READ, (_text, [tenant, subtypeIds]) => tables.sets.filter((row) => row.tenant_id === tenant && listed(subtypeIds, row.subtypeid)));
  db.respond(ATTRIBUTE_READ, (_text, [tenant, setIds, attributeIds, siteId]) =>
    tables.attributes.filter(
      (row) =>
        row.tenant_id === tenant &&
        listed(setIds, row.extendsetid) &&
        (attributeIds === null || (attributeIds as readonly number[]).includes(row.attributeid)) &&
        (siteId === null || sameId(row.siteid, siteId)),
    ),
  );
  db.respond(DATA_READ, (_text, [tenant, baseIds]) => (baseIds as readonly string[]).flatMap((baseId) => stored(tenant, baseId)));
  db.respond(LOCK_BY_BASE, (_text, [tenant, baseId]) => stored(tenant, baseId).map(({ dataid }) => ({ dataid })));
  db.respond(LOCK_BY_ATTRIBUTES, (_text, [tenant, baseId, attributeIds]) =>
    stored(tenant, baseId)
      .filter((row) => (attributeIds as readonly number[]).includes(row.attributeid))
      .map(({ dataid, attributeid }) => ({ dataid, attributeid })),
  );
  db.respond(NEXT_IDS, (_text, [, , count]) => Array.from({ length: Number(count) }, () => ({ id: String(nextDataId++) })));
  db.respond(DATA_INSERT, (text, values) => {
    const columns = (/\(([^)]*)\) VALUES/.exec(text)?.[1] ?? '').split(',').map((column) => column.trim().replace(/"/g, ''));
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index]])) as unknown as ExtendDataRow;
    tables.data.push(row);
    return [row];
  });
  db.respond(DATA_DELETE, (_text, [tenant, dataid]) => {
    const index = tables.data.findIndex((row) => row.tenant_id === tenant && row.dataid === dataid);
    return index === -1 ? [] : tables.data.splice(index, 1);
  });
  return db;
}

function inTenant<T>(db: RecordingDb, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(db, TENANT, fn);
}

/** Request params keyed by lower-cased name, as normaliseParams builds them. */
function posted(params: Readonly<Record<string, unknown>>): Map<string, unknown> {
  return new Map(Object.entries(params).map(([key, value]) => [key.toLowerCase(), value]));
}

function saveContext(config: Partial<ExtendConfig> = {}): ExtendSaveContext {
  return { siteId: SITE, config: { ...EXTEND_CONFIG_DEFAULTS, ...config }, write: WRITE };
}

/** Bound parameters of every statement whose collapsed text `matcher` finds. */
function boundBy(db: RecordingDb, matcher: RegExp): unknown[][] {
  return db
    .statements()
    .filter(({ text }) => matcher.test(text))
    .map(({ values }) => [...values]);
}

/** Each write as `<verb> <table>`; a changelog row as `changelog <op> <table>`. */
function writeLog(db: RecordingDb): string[] {
  return db.writes().map(({ text, values }) => {
    if (CHANGELOG_INSERT.test(text)) return `changelog ${String(values[2])} ${String(values[1])}`;
    const [verb = '', , table = ''] = text.split(' ');
    return `${verb.toLowerCase()} ${table.replace(/"/g, '')}`;
  });
}

/** Table, origin, actor and request of every changelog row written. */
function changelogProvenance(db: RecordingDb): unknown[][] {
  return db
    .writes()
    .filter(({ text }) => CHANGELOG_INSERT.test(text))
    .map(({ values }) => [values[1], values[7], values[8], values[11]]);
}

/** The data ids the DELETE statements of the data table bound. */
function deletedIds(db: RecordingDb): unknown[] {
  return boundBy(db, DATA_DELETE).map((values) => values[1]);
}

/** The loaded query-shape attribute of `row`; throws when the load left it out. */
function loadedAttribute(attributes: readonly ExtendedAttribute[], row: ExtendAttributeRow): ExtendedAttribute {
  const attribute = attributes.find((candidate) => candidate.attributeId === row.attributeid);
  if (attribute === undefined) throw new Error(`attribute ${String(row.name)} was not loaded`);
  return attribute;
}

/** The caught error of `promise`; fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

describe('loadSubmittedAttributes over the repository [legacy: core/mura/extend/extendManager.cfc:381-388,487-494]', () => {
  // Another site's attribute in the seeded set, under the transaction tenant as a pool tenant holds its member sites' rows.
  const REGION = extendAttributeRow({ tenant_id: TENANT, extendsetid: USER_SET.extendsetid, siteid: 'tenant-b', name: 'region' });
  const SUBMITTED = [USER_SET.extendsetid, PROFILE_SET.extendsetid.toLowerCase()];
  const USER_NAMES = ['employeeNumber', 'badgeCode', 'badgePhoto', 'shoeSize', 'startDate'];

  it.each<[string, boolean, string | null, string[]]>([
    ['of every site for validation', false, null, [...USER_NAMES, 'region']],
    ['of the save site only for a save', true, SITE, USER_NAMES],
  ])('reads only the submitted extendSetID list, attributes %s', async (_label, forSave, boundSite, names) => {
    const db = extendDb(userTables(SEEDED_DATA, [REGION]));
    const attributes = await inTenant(db, (tx) => loadSubmittedAttributes(repo, tx, SUBMITTED.join(','), SITE, { forSave }));
    expect(attributes.map((attribute) => attribute.name)).toStrictEqual(names);
    expect(boundBy(db, ATTRIBUTE_READ)).toStrictEqual([[TENANT, SUBMITTED, null, boundSite]]);
  });
});

describe('validateExtendedData of the seeded User extension [legacy: core/mura/extend/extendManager.cfc:362-437]', () => {
  async function validate(params: Readonly<Record<string, unknown>>): Promise<Record<string, string>> {
    const input = posted({ siteID: SITE, extendSetID: BOTH_SETS, ...params });
    const db = extendDb(userTables());
    const attributes = await inTenant(db, (tx) => loadSubmittedAttributes(repo, tx, String(input.get('extendsetid')), SITE, { forSave: false }));
    return validateExtendedData(attributes, input, EXTEND_CONFIG_DEFAULTS);
  }

  // Legacy selects neither the required nor the regex column; only the admin form's script checks them.
  it.each<[string, Record<string, unknown>]>([
    ['the required employeeNumber posted empty', { [`ext${REQUIRED.attributeid}`]: '', employeeNumber: '' }],
    ['the required employeeNumber not posted', { badgeCode: 'AB1234' }],
    ['a badgeCode its regex refuses', { badgeCode: 'not a badge' }],
    ['valid Numeric and Date values', { shoeSize: '9.5', startDate: '06/30/2026' }],
    ['invalid values of a set not submitted', { extendSetID: USER_SET.extendsetid, shoeSize: 'abc', startDate: 'not a date' }],
  ])('accepts %s', async (_label, params) => {
    expect(await validate(params)).toStrictEqual({});
  });

  it.each<[string, Record<string, unknown>, Record<string, string>]>([
    ['a Numeric value, with the attribute message', { shoeSize: 'abc' }, { shoeSize: 'Shoe size must be a number.' }],
    ['a Date value, with the bundle text', { [`ext${START.attributeid}`]: 'not a date' }, { startDate: 'STARTDATE must be a valid date.' }],
    [
      'only the typed attributes beside an empty required value and a refused regex',
      { employeeNumber: '', badgeCode: 'x', shoeSize: 'abc', startDate: 'not a date' },
      { shoeSize: 'Shoe size must be a number.', startDate: 'STARTDATE must be a valid date.' },
    ],
  ])('reports %s, keyed by the attribute name', async (_label, params, expected) => {
    expect(await validate(params)).toStrictEqual(expected);
  });
});

describe('File attributes, whose writes reach strategies-content tfiles [legacy: core/mura/extend/extendManager.cfc:562-642,1060-1091]', () => {
  const PHOTO_KEY = `ext${PHOTO.attributeid}`;
  const REPLACES = 'replaces a stored file, which fileManager.deleteIfNotUsed removes from tfiles';

  async function prepare(data: readonly ExtendDataRow[], params: Readonly<Record<string, unknown>>) {
    const tables = userTables(data);
    const db = extendDb(tables);
    const input = posted({ extendSetID: USER_SET.extendsetid, employeeNumber: 'E2002', ...params });
    const attributes = await inTenant(db, (tx) => loadSubmittedAttributes(repo, tx, USER_SET.extendsetid, SITE, { forSave: true }));
    return { tables, db, input, attributes };
  }

  it.each<[string, Record<string, unknown>, readonly ExtendDataRow[], string]>([
    ['an uploaded file', { badgePhoto: 'badge.jpg' }, [], 'uploads a file through fileManager.process and fileManager.create'],
    ['extDelete<attributeID> beside a stored file', { [`extDelete${PHOTO.attributeid}`]: '' }, [STORED_PHOTO], REPLACES],
    ['a new file id replacing a stored file', { [PHOTO_KEY]: OTHER_FILE_ID }, [STORED_PHOTO], REPLACES],
  ])('refuses %s before any write', async (_label, params, photo, detail) => {
    const { tables, db, input, attributes } = await prepare([...SEEDED_DATA, ...photo], params);
    const before = [...tables.data];
    expect(() => assertNoFileAttributeWrites(attributes, input, tables.data)).toThrow(UnsupportedBranchError);
    const error = await rejection(inTenant(db, (tx) => saveExtendedData(repo, tx, USER_ID, input, saveContext())));
    expect(error).toBeInstanceOf(UnsupportedBranchError);
    expect(error).toMatchObject({ attributeId: PHOTO.attributeid, message: `Extended attribute ${PHOTO.attributeid} ${detail}` });
    expect(db.writes()).toStrictEqual([]);
    expect(tables.data).toStrictEqual(before);
  });

  it.each<[string, Record<string, unknown>, number[]]>([
    ['extDelete<name> with no stored file, saving no file row', { extDeleteBadgePhoto: '' }, [REQUIRED.attributeid]],
    ['an existing file id with no stored file, saved as a plain row', { [PHOTO_KEY]: FILE_ID }, [REQUIRED.attributeid, PHOTO.attributeid]],
  ])('passes %s', async (_label, params, savedIds) => {
    const { tables, db, input, attributes } = await prepare(SEEDED_DATA, params);
    expect(() => assertNoFileAttributeWrites(attributes, input, tables.data)).not.toThrow();
    const saved = await inTenant(db, (tx) => saveExtendedData(repo, tx, USER_ID, input, saveContext()));
    expect(saved.map((row) => row.attributeid)).toStrictEqual(savedIds);
  });

  it('refuses to delete the extended data while badgePhoto holds a file id, writing nothing', async () => {
    const tables = userTables([...SEEDED_DATA, STORED_PHOTO]);
    const db = extendDb(tables);
    const error = await rejection(inTenant(db, (tx) => deleteExtendedData(repo, tx, USER_ID, { write: WRITE })));
    expect(error).toBeInstanceOf(UnsupportedBranchError);
    expect(error).toMatchObject({
      attributeId: PHOTO.attributeid,
      message: `Extended attribute ${PHOTO.attributeid} holds a stored file, which fileManager.deleteIfNotUsed removes from tfiles`,
    });
    expect(db.writes()).toStrictEqual([]);
    expect(tables.data).toStrictEqual([...SEEDED_DATA, STORED_PHOTO]);
  });
});

describe('saveExtendedData through the repository [legacy: core/mura/extend/extendManager.cfc:439-560; core/mura/user/userManager.cfc:490-492]', () => {
  it('deletes then inserts each submitted attribute, every write with its changelog row', async () => {
    const tables = userTables();
    const db = extendDb(tables);
    const input = posted({
      siteID: SITE,
      extendSetID: BOTH_SETS,
      [`ext${REQUIRED.attributeid}`]: 'E2002',
      badgeCode: '',
      shoeSize: '9.5',
      startDate: '06/30/2026',
      remoteID: 'R-7',
    });
    const saved = await inTenant(db, (tx) => saveExtendedData(repo, tx, USER_ID, input, saveContext()));
    expect(writeLog(db)).toStrictEqual([...DELETED, ...INSERTED, ...DELETED, ...INSERTED, ...INSERTED, ...INSERTED]);
    expect(deletedIds(db)).toStrictEqual(SEEDED_DATA.map((row) => row.dataid));
    expect(changelogProvenance(db)).toStrictEqual(Array.from({ length: 6 }, () => [DATA_TABLE, 'target', WRITE.actorUserId, WRITE.requestId]));
    const written = [REQUIRED, REGEX, SHOE, START].map((attribute) => [attribute.attributeid, USER_ID, SITE, 'R-7']);
    expect(saved.map((row) => [row.attributeid, row.baseid, row.siteid, row.remoteid])).toStrictEqual(written);
    expect(tables.data.map((row) => [row.attributeid, row.baseid, row.siteid, row.remoteid])).toStrictEqual(written);
  });

  it('locks and replaces only the posted attributes, keeping the other stored values', async () => {
    const tables = userTables();
    const db = extendDb(tables);
    await inTenant(db, (tx) => saveExtendedData(repo, tx, USER_ID, posted({ extendSetID: BOTH_SETS, employeeNumber: 'E2002' }), saveContext()));
    expect(boundBy(db, LOCK_BY_ATTRIBUTES)).toStrictEqual([[TENANT, USER_ID, [REQUIRED.attributeid]]]);
    expect(writeLog(db)).toStrictEqual([...DELETED, ...INSERTED]);
    expect(tables.data.map((row) => [row.attributeid, row.attributevalue])).toStrictEqual([
      [REGEX.attributeid, 'AB1234'],
      [REQUIRED.attributeid, 'E2002'],
    ]);
  });

  it.each<[string, ExtendAttributeRow, string, Partial<ExtendConfig>, CastColumn, unknown]>([
    ['a TextBox value', REQUIRED, 'E2002', {}, 'stringvalue', 'E2002'],
    ['a Regex-validated value', REGEX, 'AB1234', {}, 'stringvalue', 'AB1234'],
    ['a Numeric value, rounded as cf_sql_numeric binds it', SHOE, '9.5', {}, 'numericvalue', 10],
    ['a Date value', START, '06/30/2026', {}, 'datetimevalue', new Date(2026, 5, 30)],
    ['a Numeric value with strictExtendedData off', SHOE, '9.5', { strictExtendedData: false }, 'stringvalue', '9.5'],
  ])('stores %s in the column castColumnFor reads [legacy: core/mura/extend/extendManager.cfc:1147-1184]', async (_label, row, value, config, column, stored) => {
    const db = extendDb(userTables());
    const input = posted({ extendSetID: BOTH_SETS, [`ext${row.attributeid}`]: value });
    const ctx = saveContext(config);
    const { attributes, saved } = await inTenant(db, async (tx) => ({
      attributes: await loadSubmittedAttributes(repo, tx, BOTH_SETS, SITE, { forSave: true }),
      saved: await saveExtendedData(repo, tx, USER_ID, input, ctx),
    }));
    expect(castColumnFor(loadedAttribute(attributes, row), ctx.config)).toBe(column);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[column]).toStrictEqual(stored);
  });

  it.each<[string, ExtendConfig, string[], Array<Partial<ExtendDataRow>>]>([
    [
      'stores NULL value columns under the configBean defaults',
      EXTEND_CONFIG_DEFAULTS,
      [...DELETED, ...INSERTED],
      [{ attributeid: REGEX.attributeid, attributevalue: null, stringvalue: '', datetimevalue: null, numericvalue: null }],
    ],
    ['only deletes with saveEmptyExtendedValues off', { ...EXTEND_CONFIG_DEFAULTS, saveEmptyExtendedValues: false }, [...DELETED], []],
  ])('an empty badgeCode %s [legacy: core/mura/extend/extendManager.cfc:459,528]', async (_label, config, writes, saved) => {
    const db = extendDb(userTables());
    const input = posted({ extendSetID: USER_SET.extendsetid, badgeCode: '' });
    const rows = await inTenant(db, (tx) => saveExtendedData(repo, tx, USER_ID, input, { ...saveContext(), config }));
    expect(writeLog(db)).toStrictEqual(writes);
    expect(rows).toHaveLength(saved.length);
    expect(rows).toMatchObject(saved);
  });
});

describe('deleteExtendedData through the repository [legacy: core/mura/extend/extendManager.cfc:1060-1091]', () => {
  it('deletes every stored value of the base, each with its changelog row, and no other base\'s', async () => {
    const otherBase = extendDataRow({ attributeid: REQUIRED.attributeid, attributevalue: 'E9999' });
    const tables = userTables([...SEEDED_DATA, otherBase]);
    const db = extendDb(tables);
    expect(await inTenant(db, (tx) => deleteExtendedData(repo, tx, USER_ID, { write: WRITE }))).toBe(2);
    expect(boundBy(db, LOCK_BY_BASE)).toStrictEqual([[TENANT, USER_ID]]);
    expect(writeLog(db)).toStrictEqual([...DELETED, ...DELETED]);
    expect(deletedIds(db)).toStrictEqual(SEEDED_DATA.map((row) => row.dataid));
    expect(changelogProvenance(db)).toStrictEqual(Array.from({ length: 2 }, () => [DATA_TABLE, 'target', WRITE.actorUserId, WRITE.requestId]));
    expect(tables.data).toStrictEqual([otherBase]);
  });
});

describe('extendSetData through the repository [legacy: core/mura/extend/extendData.cfc:218-440]', () => {
  it('merges the stored values by attribute name, extendSetID listing each row\'s set', async () => {
    const startedOn = new Date(2026, 0, 5);
    const profile = [
      extendDataRow({ baseid: USER_ID, attributeid: SHOE.attributeid, attributevalue: '9' }),
      extendDataRow({ baseid: USER_ID, attributeid: START.attributeid, attributevalue: "{ts '2026-01-05 00:00:00'}", datetimevalue: startedOn }),
      extendDataRow({ attributeid: REQUIRED.attributeid, attributevalue: 'another base' }),
    ];
    const db = extendDb(userTables([...SEEDED_DATA, ...profile]));
    const result = await inTenant(db, (tx) => extendSetData(repo, tx, USER_ID));
    expect(result.data).toEqual({ employeeNumber: 'E1001', badgeCode: 'AB1234', shoeSize: '9', startDate: startedOn });
    expect(result.extendSetId).toBe([USER_SET, USER_SET, PROFILE_SET, PROFILE_SET].map((set) => set.extendsetid).join(','));
    expect(boundBy(db, DATA_READ)).toStrictEqual([[TENANT, [USER_ID]]]);
    expect(boundBy(db, ATTRIBUTE_READ)).toStrictEqual([[TENANT, null, [REQUIRED, REGEX, SHOE, START].map((row) => row.attributeid), null]]);
  });

  it('unions the defaults of the site\'s User Default sets, leaving out the Address subtype', async () => {
    const db = extendDb(userTables());
    const result = await inTenant(db, (tx) => extendSetData(repo, tx, USER_ID, { siteId: SITE, type: 'User', subtype: 'Default' }));
    expect(result.entries).toStrictEqual([
      ['employeeNumber', 'E1001'],
      ['badgeCode', 'AB1234'],
      ['badgePhoto', ''],
      ['shoeSize', '10'],
      ['startDate', ''],
    ]);
    expect(result.extendSetId).toBe([USER_SET, USER_SET, USER_SET, PROFILE_SET, PROFILE_SET].map((set) => set.extendsetid).join(','));
    expect(boundBy(db, SUBTYPE_READ)).toStrictEqual([[TENANT, SITE, null]]);
    expect(boundBy(db, SET_READ)).toStrictEqual([[TENANT, [USER_SUBTYPE.subtypeid]]]);
  });
});

