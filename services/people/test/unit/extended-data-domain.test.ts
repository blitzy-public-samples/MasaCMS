/** User and address extended attributes: Masa extendManager and extendData rules over an in-memory repository, and a round trip on a throwaway `people` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  EXTEND_CONFIG_DEFAULTS,
  EXTEND_MESSAGES,
  UnsupportedBranchError,
  assertNoFileAttributeWrites,
  castColumnFor,
  deleteExtendedData,
  extendSetData,
  extendSetsData,
  extendedDataRequested,
  loadSubmittedAttributes,
  saveExtendedData,
  toExtendedAttribute,
  validateExtendedData,
  type CastColumn,
  type ExtendConfig,
  type ExtendDataBase,
  type ExtendDataScope,
  type ExtendSaveContext,
  type ExtendedAttribute,
} from '../../src/domain/extended-data.js';
import { enPeopleMessages, type PeopleMessageKey, type PeopleMessages } from '../../src/domain/messages.js';
import { normaliseParams } from '../../src/domain/person.js';
import { createPeopleRepository, type ExtendAttributeFilter, type PeopleRepository } from '../../src/repo/repository.js';
import {
  EXTEND_ATTRIBUTE,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  PEOPLE_UNITS,
  type ExtendAttributeRow,
  type ExtendDataRow,
  type ExtendSetRow,
  type ExtendSubtypeRow,
} from '../../src/repo/tables.js';

const TENANT = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const BASE = cfUuid();
const OTHER_BASE = cfUuid();
const FILE_ID = cfUuid();
const WRITE: WriteContext = { actorUserId: 'ACTOR', requestId: 'REQ-1' };
// The in-memory repository ignores the transaction.
const TX = {} as TenantTx;
const SQL_SERVER_DATETIME_RANGE = 'The conversion of a datetime2 data type to a datetime data type resulted in an out-of-range value.';

/** A `tclassextendattributes` row of site tenant-a, set SET-A; unset columns NULL. */
function attributeRow(attributeid: number, name: string, extra: Partial<ExtendAttributeRow> = {}): ExtendAttributeRow {
  return {
    tenant_id: TENANT,
    attributeid,
    extendsetid: 'SET-A',
    siteid: SITE,
    name,
    label: null,
    hint: null,
    type: 'TextBox',
    orderno: null,
    isactive: 1,
    required: null,
    validation: null,
    regex: null,
    message: null,
    defaultvalue: null,
    optionlist: null,
    optionlabellist: null,
    adminonly: null,
    ...extra,
  };
}

/** A `tclassextenddatauseractivity` row whose stringvalue repeats its attributevalue. */
function dataRow(dataid: number, baseid: string, attributeid: number, attributevalue: string | null, extra: Partial<ExtendDataRow> = {}): ExtendDataRow {
  return {
    tenant_id: TENANT,
    dataid,
    baseid,
    attributeid,
    siteid: SITE,
    attributevalue,
    remoteid: '',
    datetimevalue: null,
    numericvalue: null,
    stringvalue: attributevalue,
    ...extra,
  };
}

function subtypeRow(subtypeid: string, type: string, subtype: string, siteid: string = SITE): ExtendSubtypeRow {
  return {
    tenant_id: TENANT,
    subtypeid,
    siteid,
    basetable: 'tusers',
    basekeyfield: 'userID',
    datatable: 'tclassextenddatauseractivity',
    type,
    subtype,
    isactive: 1,
    notes: null,
    lastupdate: null,
    datecreated: null,
    lastupdateby: null,
    hassummary: null,
    hasbody: null,
    description: null,
    availablesubtypes: null,
    iconclass: null,
    hasassocfile: null,
    hasconfigurator: null,
    adminonly: null,
  };
}

function setRow(extendsetid: string, subtypeid: string, orderno: number | null): ExtendSetRow {
  return { tenant_id: TENANT, extendsetid, subtypeid, categoryid: null, siteid: SITE, name: extendsetid, orderno, isactive: 1, container: 'Default' };
}

/** An attribute in the validate and save query shape. */
function attribute(attributeId: number, name: string, extra: Partial<ExtendedAttribute> = {}): ExtendedAttribute {
  return { attributeId, name, validation: '', message: '', type: 'TextBox', extendSetId: 'SET-A', siteId: SITE, ...extra };
}

function saveContext(config: Partial<ExtendConfig> = {}, locale?: string): ExtendSaveContext {
  return { siteId: SITE, config: { ...EXTEND_CONFIG_DEFAULTS, ...config }, write: WRITE, locale };
}

/** The repository's id and site equality: case-insensitive, trailing spaces ignored. */
function idEq(a: string | null, b: string): boolean {
  return a !== null && a.replace(/ +$/, '').toLowerCase() === b.replace(/ +$/, '').toLowerCase();
}

/** An ascending comparator over `keys`, NULLs first. */
function byKeys<T>(...keys: Array<(row: T) => string | number | null>): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const x = key(a);
      const y = key(b);
      if (x === y) continue;
      if (x === null) return -1;
      if (y === null) return 1;
      return x < y ? -1 : 1;
    }
    return 0;
  };
}

interface Definitions {
  subtypes?: ExtendSubtypeRow[];
  sets?: ExtendSetRow[];
  attributes?: ExtendAttributeRow[];
  data?: ExtendDataRow[];
}

interface MemoryRepository {
  repo: PeopleRepository;
  data: ExtendDataRow[];
  writes: Array<{ method: 'replaceExtendData' | 'deleteExtendDataForBase'; baseId: string; ctx: WriteContext | undefined }>;
  attributeFilters: ExtendAttributeFilter[];
  /** The read methods called, in order. */
  reads: ExtendMethods[];
}

type ExtendMethods =
  | 'listExtendData'
  | 'listExtendDataOf'
  | 'replaceExtendData'
  | 'deleteExtendDataForBase'
  | 'listExtendSubtypes'
  | 'listExtendSets'
  | 'listExtendAttributes';

/** The extended-data methods of PeopleRepository over arrays, with the filters and orderings their SQL applies; records each attribute filter. */
function memoryRepository(definitions: Definitions = {}): MemoryRepository {
  const { subtypes = [], sets = [], attributes = [] } = definitions;
  const store: Omit<MemoryRepository, 'repo'> = { data: [...(definitions.data ?? [])], writes: [], attributeFilters: [], reads: [] };
  let nextDataId = Math.max(0, ...store.data.map((row) => row.dataid)) + 1;
  const remove = (match: (row: ExtendDataRow) => boolean): number => {
    const before = store.data.length;
    store.data = store.data.filter((row) => !match(row));
    return before - store.data.length;
  };
  const stored = (baseIds: readonly string[]): ExtendDataRow[] =>
    store.data.filter((row) => baseIds.some((id) => idEq(row.baseid, id))).sort(byKeys<ExtendDataRow>((r) => r.baseid, (r) => r.attributeid, (r) => r.dataid));
  const methods: Pick<PeopleRepository, ExtendMethods> = {
    async listExtendData(_tx, baseIds) {
      store.reads.push('listExtendData');
      return stored(baseIds);
    },
    async listExtendDataOf(_tx, baseIds) {
      store.reads.push('listExtendDataOf');
      return new Map([...new Set(baseIds)].map((id) => [id, stored([id])]));
    },
    async replaceExtendData(_tx, baseId, entries, ctx) {
      store.writes.push({ method: 'replaceExtendData', baseId, ctx });
      const inserted: ExtendDataRow[] = [];
      for (const { attributeId, row } of entries) {
        remove((stored) => idEq(stored.baseid, baseId) && stored.attributeid === attributeId);
        if (row === null) continue;
        const stored: ExtendDataRow = { tenant_id: TENANT, dataid: nextDataId++, baseid: baseId, attributeid: attributeId, ...row };
        store.data.push(stored);
        inserted.push(stored);
      }
      return inserted;
    },
    async deleteExtendDataForBase(_tx, baseId, ctx) {
      store.writes.push({ method: 'deleteExtendDataForBase', baseId, ctx });
      return remove((row) => idEq(row.baseid, baseId));
    },
    async listExtendSubtypes(_tx, filter) {
      store.reads.push('listExtendSubtypes');
      const types = filter.types?.map((type) => type.replace(/ +$/, '').toLowerCase());
      return subtypes
        .filter((row) => idEq(row.siteid, filter.siteId) && (types === undefined || types.includes((row.type ?? '').replace(/ +$/, '').toLowerCase())))
        .sort(byKeys<ExtendSubtypeRow>((r) => r.type?.toLowerCase() ?? null, (r) => r.subtype?.toLowerCase() ?? null, (r) => r.subtypeid));
    },
    async listExtendSets(_tx, subtypeIds) {
      store.reads.push('listExtendSets');
      return sets.filter((row) => subtypeIds.some((id) => idEq(row.subtypeid, id))).sort(byKeys<ExtendSetRow>((r) => r.orderno, (r) => r.extendsetid));
    },
    async listExtendAttributes(_tx, filter) {
      store.reads.push('listExtendAttributes');
      store.attributeFilters.push(filter);
      return attributes
        .filter(
          (row) =>
            (filter.setIds === undefined || filter.setIds.some((id) => idEq(row.extendsetid, id))) &&
            (filter.attributeIds === undefined || filter.attributeIds.includes(row.attributeid)) &&
            (filter.siteId === undefined || idEq(row.siteid, filter.siteId)),
        )
        .sort(byKeys<ExtendAttributeRow>((r) => r.orderno, (r) => r.name?.toLowerCase() ?? null, (r) => r.attributeid));
    },
  };
  return Object.assign(store, { repo: methods as PeopleRepository });
}

/** The error `fn` throws or rejects with. */
async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('configBean and resource bundle settings', () => {
  it('defaults strictExtendedData and saveEmptyExtendedValues on, stricthtml off [legacy: core/mura/configBean.cfc:155,221; core/mura/extend/extendManager.cfc:374-375]', () => {
    expect(EXTEND_CONFIG_DEFAULTS).toStrictEqual({ strictExtendedData: true, saveEmptyExtendedValues: true, stricthtml: false, stricthtmlexclude: '' });
    expect(Object.isFrozen(EXTEND_CONFIG_DEFAULTS)).toBe(true);
  });

  it('holds the English params.error* texts [legacy: core/mura/resourceBundle/resources/en.properties:829-831]', () => {
    expect(EXTEND_MESSAGES).toStrictEqual({
      errordate: '{1} must be a valid date.',
      erroremail: '{1} must be a valid email.',
      errornumeric: '{1} must be numeric.',
    });
  });
});

describe('toExtendedAttribute', () => {
  it.each<[string, ExtendAttributeRow, ExtendedAttribute]>([
    [
      'NULL columns as empty text',
      attributeRow(7, 'x', { name: null, validation: null, message: null, type: null, extendsetid: null, siteid: null }),
      { attributeId: 7, name: '', validation: '', message: '', type: '', extendSetId: '', siteId: '' },
    ],
    [
      'the selected columns as stored',
      attributeRow(8, 'Shoe', { validation: 'Numeric', message: 'Enter a size', type: 'SelectBox' }),
      { attributeId: 8, name: 'Shoe', validation: 'Numeric', message: 'Enter a size', type: 'SelectBox', extendSetId: 'SET-A', siteId: SITE },
    ],
  ])('reads %s', (_label, row, expected) => {
    expect(toExtendedAttribute(row)).toStrictEqual(expected);
  });
});

describe('UnsupportedBranchError', () => {
  it('is the legacy 503 of the extended-file branch', () => {
    const error = new UnsupportedBranchError(4, 'uploads a file');
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ name: 'UnsupportedBranchError', branch: 'extended-file', reason: 'extended-file', surface: 'auto', attributeId: 4 });
    expect(error.message).toBe('Extended attribute 4 uploads a file');
  });
});

describe('castColumnFor [legacy: core/mura/extend/extendManager.cfc:1147-1190]', () => {
  it.each<[string, boolean, CastColumn]>([
    ['Numeric', true, 'numericvalue'],
    ['numeric', true, 'numericvalue'],
    ['Date', true, 'datetimevalue'],
    ['DateTime', true, 'datetimevalue'],
    ['timestamp', true, 'datetimevalue'],
    ['TIMESTAMP', true, 'datetimevalue'],
    ['Email', true, 'stringvalue'],
    ['', true, 'stringvalue'],
    ['Numeric', false, 'stringvalue'],
    ['Date', false, 'stringvalue'],
  ])('validation %j with strictExtendedData %s casts to %s', (validation, strictExtendedData, expected) => {
    expect(castColumnFor({ validation }, { strictExtendedData })).toBe(expected);
  });
});

describe('extendedDataRequested', () => {
  // User saves test len(extendSetID) [legacy: core/mura/user/userManager.cfc:490-492,645-647];
  // address saves only structKeyExists [legacy: core/mura/user/userManager.cfc:888-891,929-932].
  it.each<[string, Record<string, unknown>, boolean, boolean]>([
    ['no extendSetID', {}, false, false],
    ['an empty extendSetID', { extendSetID: '' }, false, true],
    ['a set id', { extendSetID: 'SET-A' }, true, true],
    ['a set id under another key casing', { EXTENDSETID: 'SET-A' }, true, true],
    ['a NULL extendSetID', { extendSetID: null }, false, false],
  ])('%s: user save %s, address save %s', (_label, params, user, address) => {
    const input = normaliseParams(params);
    expect(extendedDataRequested(input, { requireNonEmptySetIds: true })).toBe(user);
    expect(extendedDataRequested(input, { requireNonEmptySetIds: false })).toBe(address);
  });
});

describe('loadSubmittedAttributes', () => {
  const definitions = {
    attributes: [
      attributeRow(30, 'C', { extendsetid: 'SET-A'.padEnd(35) }),
      attributeRow(10, 'A', { siteid: 'tenant-b' }),
      attributeRow(20, 'B', { type: null }),
      attributeRow(40, 'D', { extendsetid: 'SET-B' }),
      attributeRow(50, 'E', { type: 'File', siteid: 'TENANT-A' }),
      attributeRow(60, 'F', { extendsetid: 'SET-C' }),
    ],
  };

  it.each<[string, string, boolean, number[], ExtendAttributeFilter[]]>([
    [
      'every site for validation, set ids matched as SQL Server does, NULL types left out [legacy: core/mura/extend/extendManager.cfc:381-387]',
      'SET-A,set-b',
      false,
      [10, 30, 40, 50],
      [{ setIds: ['SET-A', 'set-b'] }],
    ],
    [
      'only the save site, compared case-insensitively, for a save [legacy: core/mura/extend/extendManager.cfc:480-487,563-570]',
      'SET-A,set-b',
      true,
      [30, 40, 50],
      [{ setIds: ['SET-A', 'set-b'], siteId: SITE }],
    ],
    ['nothing for an empty set list', '', false, [], []],
  ])('reads %s, filtered by the repository', async (_label, setIds, forSave, expected, filters) => {
    const memory = memoryRepository(definitions);
    const rows = await loadSubmittedAttributes(memory.repo, TX, setIds, SITE, { forSave });
    expect(rows.map((row) => row.attributeId)).toStrictEqual(expected);
    expect(memory.attributeFilters).toStrictEqual(filters);
  });

  it('returns each attribute in the query shape', async () => {
    const [row] = await loadSubmittedAttributes(memoryRepository(definitions).repo, TX, 'SET-A', SITE, { forSave: false });
    expect(row).toStrictEqual({ attributeId: 10, name: 'A', validation: '', message: '', type: 'TextBox', extendSetId: 'SET-A', siteId: 'tenant-b' });
  });
});

describe('validateExtendedData [legacy: core/mura/extend/extendManager.cfc:362-437]', () => {
  const ATTRIBUTES = [
    attribute(1, 'Birthday', { validation: 'Date' }),
    attribute(2, 'Seen', { validation: 'DateTime' }),
    attribute(3, 'Shoe', { validation: 'Numeric' }),
    attribute(4, 'Contact', { validation: 'Email' }),
    attribute(5, 'Bio'),
    attribute(6, 'Notes', { type: 'HTMLEditor' }),
    attribute(7, 'Portrait', { type: 'File', validation: 'Numeric' }),
    attribute(8, 'Region', { validation: 'Numeric', extendSetId: 'SET-B' }),
  ];
  const STRICT = { stricthtml: true, stricthtmlexclude: '' };

  // The French texts of the site bundle [legacy: core/mura/resourceBundle/resources/fr.properties:681-683].
  const FR_TEXTS: Partial<Record<PeopleMessageKey, string>> = {
    'params.errordate': '{1} doit être une date valide.',
    'params.erroremail': '{1} doit être un email valide.',
    'params.errornumeric': '{1} doit être un chiffre.',
  };
  const french: PeopleMessages = (siteId, key) => FR_TEXTS[key] ?? enPeopleMessages(siteId, key);

  function validate(
    params: Record<string, unknown>,
    config: Pick<ExtendConfig, 'stricthtml' | 'stricthtmlexclude'> = EXTEND_CONFIG_DEFAULTS,
    locale?: string,
    rb?: PeopleMessages,
  ) {
    return validateExtendedData(ATTRIBUTES, normaliseParams({ extendSetID: 'SET-A', ...params }), config, locale, rb);
  }

  it.each<[string, Record<string, unknown>]>([
    ['an LS date', { birthday: '06/30/2026' }],
    ['isDate text that is no LS date', { seen: "{ts '2026-06-30 10:15:00'}" }],
    ['a date value', { ext1: new Date(2026, 5, 30) }],
    ['Java-trimmed numeric text', { shoe: ' 12 ' }],
    ['exponent numeric text', { ext3: '1e3' }],
    ['a number', { shoe: 7 }],
    ['a valid email', { contact: 'pat@example.com' }],
    ['empty values', { ext1: '', birthday: '', shoe: '', contact: '' }],
    ['no key of the attribute', { other: 'not a date' }],
    ['a File attribute', { portrait: 'abc' }],
    ['an attribute of a set not posted', { region: 'abc' }],
    ['tags while stricthtml is off', { bio: '<b>hi</b>' }],
    ['a valid ext<attributeID> beside an invalid <name>', { ext3: '12', shoe: 'abc' }],
  ])('accepts %s', (_label, params) => {
    expect(validate(params)).toStrictEqual({});
  });

  it.each<[string, Record<string, unknown>, Record<string, string>]>([
    ['a Date that is no date', { birthday: 'not a date' }, { Birthday: 'BIRTHDAY must be a valid date.' }],
    ['a DateTime on a day the calendar lacks', { ext2: '2026-02-30' }, { Seen: 'SEEN must be a valid date.' }],
    ['a Numeric with a thousands separator', { shoe: '1,000' }, { Shoe: 'SHOE must be numeric.' }],
    ['an Email without a top-level domain', { contact: 'pat@example' }, { Contact: 'CONTACT must be a valid email.' }],
    ['the <name> value when ext<attributeID> is empty', { ext3: '', shoe: 'abc' }, { Shoe: 'SHOE must be numeric.' }],
    ['an invalid ext<attributeID> beside a valid <name>', { ext3: 'abc', shoe: '12' }, { Shoe: 'SHOE must be numeric.' }],
    [
      'every failing attribute',
      { birthday: 'not a date', seen: 'never', ext3: 'abc', contact: 'nobody' },
      { Birthday: 'BIRTHDAY must be a valid date.', Seen: 'SEEN must be a valid date.', Shoe: 'SHOE must be numeric.', Contact: 'CONTACT must be a valid email.' },
    ],
  ])('reports %s', (_label, params, expected) => {
    expect(validate(params)).toStrictEqual(expected);
  });

  it.each<[string, boolean]>([
    ['pat@example.com', true],
    [' pat@example.com\t', true],
    ["o'neil+news~x@mail.example.org", true],
    ['first-last@example.co', true],
    ['PAT@EXAMPLE.MUSEUM', true],
    ['a@b.abcdefg', true],
    ['pat@example.abcdefgh', false],
    ['pat..lee@example.com', false],
    ['.pat@example.com', false],
    ['pat lee@example.com', false],
    ['pat@example.c0m', false],
    ['pat@@example.com', false],
  ])('email %j is valid: %s', (value, valid) => {
    expect(validate({ contact: value })).toStrictEqual(valid ? {} : { Contact: 'CONTACT must be a valid email.' });
  });

  it('reports the attribute message instead of the bundle text', () => {
    const attributes = [attribute(3, 'Shoe', { validation: 'Numeric', message: 'Enter a size' })];
    expect(validateExtendedData(attributes, normaliseParams({ extendSetID: 'SET-A', shoe: 'abc' }), EXTEND_CONFIG_DEFAULTS)).toStrictEqual({ Shoe: 'Enter a size' });
  });

  // messageFormat splits its argument with listToArray and prepends '' [legacy: core/mura/resourceBundle/resourceBundle.cfc:164-192].
  it.each<[string, string]>([
    ['from,to', 'FROM must be numeric.'],
    [',', '{1} must be numeric.'],
  ])('formats name %j as %j', (name, expected) => {
    const attributes = [attribute(9, name, { validation: 'Numeric' })];
    expect(validateExtendedData(attributes, normaliseParams({ extendSetID: 'SET-A', ext9: 'abc' }), EXTEND_CONFIG_DEFAULTS)).toStrictEqual({ [name]: expected });
  });

  it('keeps one error key per name in any casing, as a CFML struct does', () => {
    const attributes = [attribute(11, 'Phone', { validation: 'Numeric' }), attribute(12, 'PHONE', { validation: 'Numeric', message: 'second' })];
    const errors = validateExtendedData(attributes, normaliseParams({ extendSetID: 'SET-A', ext11: 'a', ext12: 'b' }), EXTEND_CONFIG_DEFAULTS);
    expect(errors).toStrictEqual({ Phone: 'second' });
  });

  it.each<[string, Pick<ExtendConfig, 'stricthtml' | 'stricthtmlexclude'>, Record<string, unknown>, Record<string, string>]>([
    ['a tag in a plain attribute', STRICT, { bio: '<b>hi</b>' }, { Bioencoding: "The field 'Bio' contains invalid characters." }],
    ['a closing tag alone', STRICT, { ext5: 'a</p>' }, { Bioencoding: "The field 'Bio' contains invalid characters." }],
    ['an HTMLEditor attribute', STRICT, { notes: '<p>x</p>' }, {}],
    ['a name in stricthtmlexclude', { stricthtml: true, stricthtmlexclude: 'Other,Bio' }, { bio: '<b>' }, {}],
    ['a name in stricthtmlexclude in another casing', { stricthtml: true, stricthtmlexclude: 'bio' }, { bio: '<b>' }, { Bioencoding: "The field 'Bio' contains invalid characters." }],
    ['a validated attribute', STRICT, { shoe: '<1>' }, { Shoe: 'SHOE must be numeric.' }],
    ['text without a closed tag', STRICT, { bio: '1 < 2' }, {}],
  ])('stricthtml: %s', (_label, config, params, expected) => {
    expect(validate(params, config)).toStrictEqual(expected);
  });

  it.each<[string | undefined, Record<string, string>]>([
    [undefined, { Birthday: 'BIRTHDAY must be a valid date.' }],
    ['German (Standard)', {}],
  ])('reads LS dates in locale %s', (locale, expected) => {
    expect(validate({ birthday: '30. Juni 2026' }, EXTEND_CONFIG_DEFAULTS, locale)).toStrictEqual(expected);
  });

  it('refuses a complex value as ACF does', () => {
    expect(() => validate({ bio: ['a'] })).toThrow('Complex object types cannot be converted to simple values.');
  });

  it.each<[string, Record<string, unknown>, Record<string, string>]>([
    ['a Date that is no date', { birthday: 'not a date' }, { Birthday: 'BIRTHDAY doit être une date valide.' }],
    ['a Numeric with a thousands separator', { shoe: '1,000' }, { Shoe: 'SHOE doit être un chiffre.' }],
    ['an Email without a top-level domain', { contact: 'pat@example' }, { Contact: 'CONTACT doit être un email valide.' }],
  ])('reports %s in the French site bundle [legacy: core/mura/extend/extendManager.cfc:372-373,409,417,425]', (_label, params, expected) => {
    expect(validate({ siteID: 'site-fr', ...params }, EXTEND_CONFIG_DEFAULTS, undefined, french)).toStrictEqual(expected);
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ['the override of the posted site', { siteID: 'tenant-b' }, 'tenant-b', 'Pointure SHOE invalide'],
    ['the default text of another site', { siteID: 'tenant-c' }, 'tenant-c', 'SHOE must be numeric.'],
    ['a blank site id for an input without one', {}, '', 'SHOE must be numeric.'],
  ])('formats %s', (_label, params, siteId, expected) => {
    const sites: string[] = [];
    const rb: PeopleMessages = (site, key) => {
      sites.push(site);
      return site === 'tenant-b' && key === 'params.errornumeric' ? 'Pointure {1} invalide' : enPeopleMessages(site, key);
    };
    expect(validate({ ...params, shoe: 'abc' }, EXTEND_CONFIG_DEFAULTS, undefined, rb)).toStrictEqual({ Shoe: expected });
    expect(sites).toStrictEqual([siteId]);
  });

  it.each<[string, ExtendedAttribute, Pick<ExtendConfig, 'stricthtml' | 'stricthtmlexclude'>, Record<string, unknown>, Record<string, string>]>([
    ['the attribute message', attribute(3, 'Shoe', { validation: 'Numeric', message: 'Enter a size' }), EXTEND_CONFIG_DEFAULTS, { shoe: 'abc' }, { Shoe: 'Enter a size' }],
    ['the stricthtml text', attribute(5, 'Bio'), STRICT, { bio: '<b>hi</b>' }, { Bioencoding: "The field 'Bio' contains invalid characters." }],
  ])('keeps %s unlocalized in the French site bundle', (_label, attr, config, params, expected) => {
    expect(validateExtendedData([attr], normaliseParams({ extendSetID: 'SET-A', siteID: 'site-fr', ...params }), config, undefined, french)).toStrictEqual(expected);
  });
});

describe('assertNoFileAttributeWrites [legacy: core/mura/extend/extendManager.cfc:562-647]', () => {
  const ATTRIBUTES = [attribute(4, 'Photo', { type: 'File' }), attribute(1, 'Nickname')];
  const STORED_FILE = [dataRow(1, BASE, 4, FILE_ID)];
  const STORED_EMPTY = [dataRow(1, BASE, 4, null)];

  it.each<[string, Record<string, unknown>, ExtendDataRow[]]>([
    ['nothing posted for the File attribute', { nickname: 'x.jpg' }, STORED_FILE],
    ['a file id with nothing stored', { ext4: FILE_ID }, []],
    ['a lower-case file id', { photo: FILE_ID.toLowerCase() }, []],
    ['a delete key with nothing stored', { extDelete4: '' }, []],
    ['a delete key beside a stored empty value', { extDeletePhoto: '' }, STORED_EMPTY],
    ['an upload with a delete key, which saves nothing', { photo: 'portrait.jpg', extDelete4: '' }, []],
    ['a File attribute of a set not posted', { extendSetID: 'SET-B', ext4: 'portrait.jpg' }, STORED_FILE],
  ])('passes %s', (_label, params, stored) => {
    expect(() => assertNoFileAttributeWrites(ATTRIBUTES, normaliseParams({ extendSetID: 'SET-A', ...params }), stored)).not.toThrow();
  });

  it.each<[string, Record<string, unknown>, ExtendDataRow[], string]>([
    ['a file id replacing a stored file', { ext4: cfUuid() }, STORED_FILE, 'replaces a stored file, which fileManager.deleteIfNotUsed removes from tfiles'],
    ['extDelete<attributeID> with a stored file', { extDelete4: '' }, STORED_FILE, 'replaces a stored file, which fileManager.deleteIfNotUsed removes from tfiles'],
    ['extDelete<name> with a stored file', { extDeletePhoto: '' }, STORED_FILE, 'replaces a stored file, which fileManager.deleteIfNotUsed removes from tfiles'],
    ['an upload', { photo: 'portrait.jpg' }, [], 'uploads a file through fileManager.process and fileManager.create'],
    ['ext<attributeID> beside a delete key', { ext4: 'portrait.jpg', extDeletePhoto: '' }, [], 'uploads a file through fileManager.process and fileManager.create'],
    ['a file id beside a stored empty value', { ext4: FILE_ID }, STORED_EMPTY, 'adds a file id beside stored rows legacy keeps'],
  ])('refuses %s', async (_label, params, stored, detail) => {
    const error = await caught(() => assertNoFileAttributeWrites(ATTRIBUTES, normaliseParams({ extendSetID: 'SET-A', ...params }), stored));
    expect(error).toBeInstanceOf(UnsupportedBranchError);
    expect(error).toMatchObject({ attributeId: 4, message: `Extended attribute 4 ${detail}` });
  });

  it('treats a missing stored list as no stored rows', () => {
    expect(() => assertNoFileAttributeWrites(ATTRIBUTES, normaliseParams({ extendSetID: 'SET-A', ext4: FILE_ID }))).not.toThrow();
  });
});

describe('saveExtendedData [legacy: core/mura/extend/extendManager.cfc:439-650]', () => {
  const ATTRIBUTES = [
    attributeRow(1, 'Nickname'),
    attributeRow(2, 'Birthday', { validation: 'Date' }),
    attributeRow(3, 'Shoe', { validation: 'Numeric' }),
    attributeRow(4, 'Photo', { type: 'File' }),
    attributeRow(5, 'Region', { siteid: 'tenant-b' }),
  ];

  function save(params: Record<string, unknown>, ctx: ExtendSaveContext = saveContext(), data: ExtendDataRow[] = []) {
    const memory = memoryRepository({ attributes: ATTRIBUTES, data });
    return { memory, saved: saveExtendedData(memory.repo, TX, BASE, normaliseParams({ extendSetID: 'SET-A', ...params }), ctx) };
  }

  it.each<[string, Record<string, unknown>]>([
    ['without extendSetID', {}],
    ['with an empty extendSetID', { extendSetID: '' }],
  ])('saves nothing %s', async (_label, params) => {
    const memory = memoryRepository({ attributes: ATTRIBUTES });
    expect(await saveExtendedData(memory.repo, TX, BASE, normaliseParams({ ext1: 'Pat', ...params }), saveContext())).toStrictEqual([]);
    expect(memory.writes).toStrictEqual([]);
  });

  it('replaces each posted attribute of the save site and keeps the others', async () => {
    const stored = [dataRow(1, BASE, 1, 'old'), dataRow(2, BASE, 3, '9', { numericvalue: 9 }), dataRow(3, OTHER_BASE, 1, 'other')];
    const { memory, saved } = save({ extendSetID: 'set-a', ext1: 'Pat', region: 'North', remoteID: 'R'.repeat(40) }, saveContext(), stored);
    const row = { tenant_id: TENANT, dataid: 4, baseid: BASE, attributeid: 1, siteid: SITE, attributevalue: 'Pat', stringvalue: 'Pat', datetimevalue: null, numericvalue: null };
    expect(await saved).toStrictEqual([{ ...row, remoteid: 'R'.repeat(35) }]);
    expect(memory.data.map((r) => [r.baseid, r.attributeid, r.attributevalue])).toStrictEqual([
      [BASE, 3, '9'],
      [OTHER_BASE, 1, 'other'],
      [BASE, 1, 'Pat'],
    ]);
    expect(memory.writes).toStrictEqual([{ method: 'replaceExtendData', baseId: BASE, ctx: WRITE }]);
  });

  it.each<[string, Record<string, unknown>, Partial<ExtendDataRow>]>([
    ['text in attributevalue and stringvalue', { ext1: 'Pat' }, { attributeid: 1, attributevalue: 'Pat', stringvalue: 'Pat', datetimevalue: null, numericvalue: null }],
    ['stringvalue cut at 250 characters', { ext1: 'x'.repeat(300) }, { attributeid: 1, attributevalue: 'x'.repeat(300), stringvalue: 'x'.repeat(250) }],
    [
      'an LS date parsed',
      { ext2: '06/30/2026' },
      { attributeid: 2, attributevalue: "{ts '2026-06-30 00:00:00'}", stringvalue: "{ts '2026-06-30 00:00:00'}", datetimevalue: new Date(2026, 5, 30), numericvalue: null },
    ],
    [
      'isDate text parsed by parseDateTime',
      { birthday: "{ts '2026-06-30 10:15:00'}" },
      { attributeid: 2, attributevalue: "{ts '2026-06-30 10:15:00'}", datetimevalue: new Date(2026, 5, 30, 10, 15) },
    ],
    [
      'a date value rounded to the SQL Server datetime tick',
      { ext2: new Date(2026, 5, 30, 10, 15, 0, 1) },
      { attributeid: 2, attributevalue: "{ts '2026-06-30 10:15:00'}", datetimevalue: new Date(2026, 5, 30, 10, 15, 0, 0) },
    ],
    ['a Numeric value in numericvalue', { ext3: '2.5' }, { attributeid: 3, attributevalue: '2.5', stringvalue: '2.5', datetimevalue: null, numericvalue: 3 }],
    ['a non-numeric Numeric value emptied', { ext3: 'abc' }, { attributeid: 3, attributevalue: null, stringvalue: '', datetimevalue: null, numericvalue: null }],
    ['an empty value as NULL value columns', { ext1: '' }, { attributeid: 1, attributevalue: null, stringvalue: '', datetimevalue: null, numericvalue: null }],
    ['ext<attributeID> before <name>', { ext1: 'ById', nickname: 'ByName' }, { attributeid: 1, attributevalue: 'ById' }],
    ['<name> when ext<attributeID> is empty', { ext1: '', nickname: 'ByName' }, { attributeid: 1, attributevalue: 'ByName' }],
    ['a number as CFML text', { ext1: 1.5 }, { attributeid: 1, attributevalue: '1.5', stringvalue: '1.5' }],
  ])('stores %s', async (_label, params, expected) => {
    const saved = await save(params).saved;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ baseid: BASE, siteid: SITE, remoteid: '', ...expected });
  });

  // cf_sql_numeric without a scale binds the decimal value rounded half up to an integer [legacy: core/mura/extend/extendManager.cfc:548].
  it.each<[string | number, number]>([
    ['-2.5', -3],
    ['1.45', 1],
    ['2.4999999999999999999', 2],
    ['.5', 1],
    ['5e-1', 1],
    ['5e-2', 0],
    ['1.5e1', 15],
    ['1e3', 1000],
    [' 7 ', 7],
    ['-0.4', 0],
    [7.5, 8],
    [-2.5, -3],
    [-0.4, 0],
  ])('binds Numeric %j as %d', async (value, expected) => {
    const [row] = await save({ ext3: value }).saved;
    expect(row?.numericvalue).toBe(expected);
  });

  it.each<[string, Record<string, unknown>, number]>([
    ['an empty value', { ext1: '' }, 1],
    ['an emptied Numeric value', { ext3: 'abc' }, 3],
  ])('with saveEmptyExtendedValues off deletes %s without inserting [legacy: core/mura/extend/extendManager.cfc:522-528]', async (_label, params, attributeId) => {
    const stored = [dataRow(1, BASE, 1, 'old'), dataRow(2, BASE, 3, '9')];
    const { memory, saved } = save(params, saveContext({ saveEmptyExtendedValues: false }), stored);
    expect(await saved).toStrictEqual([]);
    expect(memory.data.map((r) => r.attributeid)).toStrictEqual([1, 3].filter((id) => id !== attributeId));
    expect(memory.writes).toHaveLength(1);
  });

  it('parses a Date in the request locale', async () => {
    const [row] = await save({ ext2: '30. Juni 2026' }, saveContext({}, 'German (Standard)')).saved;
    expect(row?.datetimevalue).toStrictEqual(new Date(2026, 5, 30));
  });

  it.each<[string, string]>([
    ['not a date', 'not a date is an invalid date or time string.'],
    ['30. Juni 2026', '30. Juni 2026 is an invalid date or time string.'],
    ['06/30/99999', SQL_SERVER_DATETIME_RANGE],
  ])('refuses Date %j as the cf_sql_timestamp binding and datetime column do, writing nothing', async (value, message) => {
    const stored = [dataRow(1, BASE, 2, '06/30/2026')];
    const { memory, saved } = save({ ext1: 'Pat', ext2: value }, saveContext(), stored);
    await expect(saved).rejects.toThrow(message);
    expect(memory.data).toStrictEqual(stored);
    expect(memory.writes).toStrictEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['by ext<attributeID>', { ext4: FILE_ID }],
    ['by <name>', { photo: FILE_ID }],
    ['by ext<attributeID> beside a delete key', { ext4: FILE_ID, extDeletePhoto: '' }],
  ])('saves a posted file id %s after the other attributes [legacy: core/mura/extend/extendManager.cfc:628-642]', async (_label, params) => {
    const saved = await save({ ext1: 'Pat', remoteID: 'R-1', ...params }).saved;
    expect(saved.map((row) => row.attributeid)).toStrictEqual([1, 4]);
    expect(saved[1]).toMatchObject({ siteid: SITE, attributevalue: FILE_ID, stringvalue: FILE_ID, remoteid: 'R-1', datetimevalue: null, numericvalue: null });
  });

  it('saves nothing for <name> beside a delete key with no stored file', async () => {
    const { memory, saved } = save({ photo: FILE_ID, extDelete4: '' });
    expect(await saved).toStrictEqual([]);
    expect(memory.writes).toStrictEqual([]);
  });

  it('refuses a File branch that reaches fileManager before any write', async () => {
    const stored = [dataRow(1, BASE, 4, FILE_ID)];
    const { memory, saved } = save({ ext1: 'Pat', extDelete4: '' }, saveContext(), stored);
    await expect(saved).rejects.toBeInstanceOf(UnsupportedBranchError);
    expect(memory.data).toStrictEqual(stored);
    expect(memory.writes).toStrictEqual([]);
  });
});

describe('deleteExtendedData [legacy: core/mura/extend/extendManager.cfc:1060-1090; core/mura/user/userDAO.cfc:389-393]', () => {
  const NICKNAME = attributeRow(1, 'Nickname');

  it.each<[string, ExtendDataRow[], number]>([
    ['every stored value of the base, a File attribute without a value included', [dataRow(1, BASE, 1, 'Pat'), dataRow(2, BASE, 4, null), dataRow(3, OTHER_BASE, 1, 'Lee')], 2],
    ['nothing for a base without values', [dataRow(3, OTHER_BASE, 1, 'Lee')], 0],
  ])('deletes %s', async (_label, data, deleted) => {
    const memory = memoryRepository({ attributes: [NICKNAME, attributeRow(4, 'Photo', { type: 'File' })], data });
    expect(await deleteExtendedData(memory.repo, TX, BASE, { write: WRITE })).toBe(deleted);
    expect(memory.data.map((row) => row.dataid)).toStrictEqual([3]);
    expect(memory.writes).toStrictEqual([{ method: 'deleteExtendDataForBase', baseId: BASE, ctx: WRITE }]);
  });

  it.each(['File', 'file', 'FILE '])('refuses, deleting nothing, while a %j attribute holds a file id', async (type) => {
    const stored = [dataRow(1, BASE, 1, 'Pat'), dataRow(2, BASE, 4, FILE_ID)];
    const memory = memoryRepository({ attributes: [NICKNAME, attributeRow(4, 'Photo', { type })], data: stored });
    const error = await caught(() => deleteExtendedData(memory.repo, TX, BASE, { write: WRITE }));
    expect(error).toBeInstanceOf(UnsupportedBranchError);
    expect(error).toMatchObject({ attributeId: 4, message: 'Extended attribute 4 holds a stored file, which fileManager.deleteIfNotUsed removes from tfiles' });
    expect(memory.data).toStrictEqual(stored);
    expect(memory.writes).toStrictEqual([]);
  });
});

describe('extendSetData [legacy: core/mura/extend/extendData.cfc:218-371,406-440]', () => {
  const SUBTYPES = [
    subtypeRow('ST-USER-DEFAULT', 'User', 'Default'),
    subtypeRow('ST-USER-GOLD', 'User', 'Gold'),
    subtypeRow('ST-USER-SILVER', 'User', 'Silver'),
    subtypeRow('ST-USER-LOWERSUB', 'User', 'default'),
    subtypeRow('ST-BASE', 'Base', 'Default'),
    subtypeRow('ST-LOWERTYPE', 'user', 'Default'),
    subtypeRow('ST-OTHER-SITE', 'User', 'Default', 'tenant-b'),
  ];
  const SETS = [
    setRow('SET-GOLD-2', 'ST-USER-GOLD', 2),
    setRow('SET-GOLD-1', 'ST-USER-GOLD', 1),
    setRow('SET-DEFAULT', 'ST-USER-DEFAULT', null),
    setRow('SET-SILVER', 'ST-USER-SILVER', 1),
    setRow('SET-LOWERSUB', 'ST-USER-LOWERSUB', 1),
    setRow('SET-BASE', 'ST-BASE', 1),
    setRow('SET-LOWERTYPE', 'ST-LOWERTYPE', 1),
    setRow('SET-OTHER', 'ST-OTHER-SITE', 1),
  ];
  const ATTRIBUTES = [
    attributeRow(1, 'Nickname', { extendsetid: 'SET-DEFAULT', orderno: 2, defaultvalue: 'none' }),
    attributeRow(2, 'Birthday', { extendsetid: 'SET-DEFAULT', orderno: 1, validation: 'Date' }),
    attributeRow(3, 'Tier', { extendsetid: 'SET-GOLD-2', orderno: 1, defaultvalue: 'gold' }),
    attributeRow(4, 'Since', { extendsetid: 'SET-GOLD-1', orderno: 1, validation: 'DateTime' }),
    attributeRow(5, 'Shade', { extendsetid: 'SET-SILVER', defaultvalue: 'silver' }),
    attributeRow(6, 'Kind', { extendsetid: 'SET-BASE', defaultvalue: 'base' }),
    attributeRow(7, 'Lower', { extendsetid: 'SET-LOWERTYPE', defaultvalue: 'lower type' }),
    attributeRow(8, 'Elsewhere', { extendsetid: 'SET-OTHER', siteid: 'tenant-b', defaultvalue: 'other site' }),
    attributeRow(9, 'LowerSub', { extendsetid: 'SET-LOWERSUB', defaultvalue: 'lower subtype' }),
  ];
  const STORED = [dataRow(1, BASE, 1, 'Pat'), dataRow(2, BASE, 8, 'stored elsewhere'), dataRow(3, BASE, 99, 'orphan'), dataRow(4, OTHER_BASE, 1, 'Lee')];

  function read(scope?: ExtendDataScope, data: ExtendDataRow[] = STORED, attributes: ExtendAttributeRow[] = ATTRIBUTES, config?: Pick<ExtendConfig, 'saveEmptyExtendedValues'>) {
    const { repo } = memoryRepository({ subtypes: SUBTYPES, sets: SETS, attributes, data });
    return extendSetData(repo, TX, BASE, scope, config);
  }

  it('joins the stored values to their attributes, every site without a scope', async () => {
    const result = await read();
    expect(result.entries).toStrictEqual([
      ['Nickname', 'Pat'],
      ['Elsewhere', 'stored elsewhere'],
    ]);
    expect(result.data).toEqual({ Nickname: 'Pat', Elsewhere: 'stored elsewhere' });
    expect(result.extendSetId).toBe('SET-DEFAULT,SET-OTHER');
  });

  it('joins sets to subtypes ignoring id case, and unions only subtypes of the exact scope site as the query of queries does', async () => {
    const { repo } = memoryRepository({
      subtypes: [subtypeRow('ST-CASE', 'User', 'Default'), subtypeRow('ST-SITE-CASE', 'User', 'Default', SITE.toUpperCase())],
      sets: [setRow('SET-CASE', 'st-case', 1), setRow('SET-SITE-CASE', 'ST-SITE-CASE', 1)],
      attributes: [
        attributeRow(1, 'Spelled', { extendsetid: 'SET-CASE', defaultvalue: 'joined' }),
        attributeRow(2, 'Cased', { extendsetid: 'SET-SITE-CASE', defaultvalue: 'other site spelling' }),
      ],
    });
    const result = await extendSetData(repo, TX, BASE, { siteId: SITE, type: 'User', subtype: 'Default' });
    expect(result.entries).toStrictEqual([['Spelled', 'joined']]);
  });

  it('keeps only attributes of the scope site, compared case-insensitively, and unions nothing without a type', async () => {
    const result = await read({ siteId: 'TENANT-A', type: '', subtype: 'Gold' });
    expect(result.entries).toStrictEqual([['Nickname', 'Pat']]);
    expect(result.extendSetId).toBe('SET-DEFAULT');
  });

  it.each<[string, ExtendDataScope, Array<[string, string]>, string]>([
    [
      'the scope subtype and Default, by type, subtype, set and attribute order',
      { siteId: SITE, type: 'User', subtype: 'Gold' },
      [['Nickname', 'Pat'], ['Birthday', ''], ['Since', ''], ['Tier', 'gold']],
      'SET-DEFAULT,SET-DEFAULT,SET-GOLD-1,SET-GOLD-2',
    ],
    [
      'only the Default subtype for subtype Default in any casing',
      { siteId: SITE, type: 'User', subtype: 'default' },
      [['Nickname', 'Pat'], ['Birthday', '']],
      'SET-DEFAULT,SET-DEFAULT',
    ],
    [
      'the Base subtype for a type outside the user, address and site types',
      { siteId: SITE, type: 'Page', subtype: 'Default' },
      [['Nickname', 'Pat'], ['Kind', 'base']],
      'SET-DEFAULT,SET-BASE',
    ],
    [
      'no subtype for type USER: no Base for a user type, and the type compared case-sensitively',
      { siteId: SITE, type: 'USER', subtype: 'Default' },
      [['Nickname', 'Pat']],
      'SET-DEFAULT',
    ],
  ])('unions the defaults of %s', async (_label, scope, entries, extendSetId) => {
    const result = await read(scope);
    expect(result.entries).toStrictEqual(entries);
    expect(result.extendSetId).toBe(extendSetId);
  });

  it.each<[string, ExtendDataScope | undefined, ExtendDataRow[], ExtendAttributeFilter[]]>([
    ['the stored attribute ids of every site without a scope', undefined, STORED, [{ attributeIds: [1, 8, 99] }]],
    [
      'the stored attribute ids of the scope site, then the attributes of the scope sets',
      { siteId: SITE, type: 'User', subtype: 'Gold' },
      STORED,
      [{ attributeIds: [1, 8, 99], siteId: SITE }, { setIds: ['SET-DEFAULT', 'SET-GOLD-1', 'SET-GOLD-2'] }],
    ],
    ['no attributes without stored rows or scope sets', { siteId: SITE, type: 'USER', subtype: 'Default' }, [], []],
  ])('fetches %s', async (_label, scope, data, filters) => {
    const memory = memoryRepository({ subtypes: SUBTYPES, sets: SETS, attributes: ATTRIBUTES, data });
    await extendSetData(memory.repo, TX, BASE, scope);
    expect(memory.attributeFilters).toStrictEqual(filters);
  });

  it('leaves out NULL values with saveEmptyExtendedValues off, so their defaults union in', async () => {
    const stored = [dataRow(1, BASE, 1, null)];
    const scope = { siteId: SITE, type: 'User', subtype: 'Default' };
    expect((await read(scope, stored)).entries).toStrictEqual([['Nickname', ''], ['Birthday', '']]);
    expect((await read(scope, stored, ATTRIBUTES, { saveEmptyExtendedValues: false })).entries).toStrictEqual([['Birthday', ''], ['Nickname', 'none']]);
  });

  it.each<[string, number, Partial<ExtendDataRow>, string | Date]>([
    ['a Date datetimevalue before its text', 2, { attributevalue: 'garbage', datetimevalue: new Date(2026, 5, 30, 10, 15) }, new Date(2026, 5, 30, 10, 15)],
    ['Date text parsed without a datetimevalue', 2, { attributevalue: '06/30/2026' }, new Date(2026, 5, 30)],
    ['a DateTime datetimevalue without text', 4, { attributevalue: null, datetimevalue: new Date(2026, 0, 2) }, new Date(2026, 0, 2)],
    ['Date text that does not parse', 2, { attributevalue: 'someday' }, 'someday'],
    ['an empty Date value', 2, { attributevalue: null }, ''],
    ['date text of a plain attribute', 1, { attributevalue: '06/30/2026' }, '06/30/2026'],
    ['a NULL plain value', 1, { attributevalue: null }, ''],
  ])('reads %s', async (_label, attributeId, values, expected) => {
    const result = await read(undefined, [dataRow(1, BASE, attributeId, null, values)]);
    expect(result.entries).toStrictEqual([[ATTRIBUTES[attributeId - 1]?.name, expected]]);
  });

  it('keys the data case-insensitively with the first spelling and the last value', async () => {
    const attributes = [attributeRow(20, 'Color'), attributeRow(21, 'COLOR'), attributeRow(22, '__proto__')];
    const result = await read(undefined, [dataRow(1, BASE, 20, 'red'), dataRow(2, BASE, 21, 'blue'), dataRow(3, BASE, 22, 'x')], attributes);
    expect(Object.entries(result.data)).toStrictEqual([['Color', 'blue'], ['__proto__', 'x']]);
    expect(result.entries).toStrictEqual([['Color', 'red'], ['COLOR', 'blue'], ['__proto__', 'x']]);
  });

  // contentRenderer.setDynamicContent evaluates Mura tags in a default [legacy: core/mura/extend/extendData.cfc:430-434].
  it.each(['[m]esapiEncode("html", "x")[/m]', '[mura]now()[/mura]', '[sava]now()[/sava]'])('answers the legacy 503 for default %j', async (defaultvalue) => {
    const attributes = [...ATTRIBUTES.filter((row) => row.attributeid !== 2), attributeRow(2, 'Birthday', { extendsetid: 'SET-DEFAULT', defaultvalue })];
    const error = await caught(() => read({ siteId: SITE, type: 'User', subtype: 'Default' }, STORED, attributes));
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ reason: 'extend-dynamic-default', surface: 'auto' });
  });

  it('returns no values for a base without stored rows', async () => {
    expect(await read(undefined, [])).toEqual({ data: {}, entries: [], extendSetId: '' });
  });

  it('reads many bases as it reads each, with one stored-value read, attributes once per site and definitions once per scope', async () => {
    const definitions = { subtypes: SUBTYPES, sets: SETS, attributes: ATTRIBUTES, data: STORED };
    const gold: ExtendDataScope = { siteId: SITE, type: 'User', subtype: 'Gold' };
    const bases: ExtendDataBase[] = [
      { baseId: BASE, scope: gold },
      { baseId: OTHER_BASE, scope: { ...gold } },
      { baseId: BASE.toLowerCase(), scope: { siteId: 'TENANT-A', type: 'User', subtype: 'Default' } },
      { baseId: BASE },
      { baseId: cfUuid(), scope: { siteId: SITE, type: 'Page', subtype: 'Default' } },
    ];
    const each: Awaited<ReturnType<typeof extendSetData>>[] = [];
    for (const { baseId, scope } of bases) each.push(await extendSetData(memoryRepository(definitions).repo, TX, baseId, scope));
    const memory = memoryRepository(definitions);
    expect(await extendSetsData(memory.repo, TX, bases)).toStrictEqual(each);
    expect(memory.reads.filter((method) => method === 'listExtendDataOf' || method === 'listExtendData')).toStrictEqual(['listExtendDataOf']);
    expect(memory.reads.filter((method) => method === 'listExtendSubtypes')).toHaveLength(3);
    expect(memory.attributeFilters).toStrictEqual([
      { attributeIds: [1, 8, 99], siteId: SITE },
      { attributeIds: [1, 8, 99], siteId: 'TENANT-A' },
      { attributeIds: [1, 8, 99] },
      { setIds: ['SET-DEFAULT', 'SET-GOLD-1', 'SET-GOLD-2'] },
      { setIds: ['SET-BASE'] },
    ]);
    expect(await extendSetsData(memory.repo, TX, [])).toStrictEqual([]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('extended data through the people repository on PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'extended-data-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'extended-data-test', state: 'open' });
    repo = createPeopleRepository({ clock: fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0)), schema: handle.schema });
    await inTenant(async (tx) => {
      await repo.insert(tx, EXTEND_SUBTYPE.table, { subtypeid: 'ST-USER', siteid: SITE, basetable: 'tusers', type: 'User', subtype: 'Default' });
      await repo.insert(tx, EXTEND_SET.table, { extendsetid: 'SET-A', subtypeid: 'ST-USER', siteid: SITE, orderno: 1 });
      const attributes = [
        [1, 'Nickname', null, null],
        [2, 'Birthday', 'Date', null],
        [3, 'Shoe', 'Numeric', null],
        [4, 'Team', null, 'Blue'],
      ] as const;
      for (const [attributeid, name, validation, defaultvalue] of attributes) {
        await repo.insert(tx, EXTEND_ATTRIBUTE.table, { attributeid, extendsetid: 'SET-A', siteid: SITE, name, type: 'TextBox', validation, orderno: attributeid, defaultvalue });
      }
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(TENANT, fn);
  }

  it('validates, saves, reads back and deletes a person\'s values over CHAR(35) set ids', async () => {
    const userId = cfUuid();
    const input = normaliseParams({ extendSetID: 'set-a', ext1: 'Pat', birthday: '06/30/2026', shoe: '9.5' });

    const attributes = await inTenant((tx) => loadSubmittedAttributes(repo, tx, 'set-a', SITE, { forSave: false }));
    expect(validateExtendedData(attributes, input, EXTEND_CONFIG_DEFAULTS)).toStrictEqual({});

    const saved = await inTenant((tx) => saveExtendedData(repo, tx, userId, input, saveContext()));
    expect(saved.map((row) => [row.attributeid, row.siteid, row.attributevalue, row.datetimevalue, row.numericvalue])).toStrictEqual([
      [1, SITE, 'Pat', null, null],
      [2, SITE, "{ts '2026-06-30 00:00:00'}", new Date(2026, 5, 30), null],
      [3, SITE, '9.5', null, 10],
    ]);

    const read = await inTenant((tx) => extendSetData(repo, tx, userId, { siteId: SITE, type: 'User', subtype: 'Default' }));
    expect(read.entries).toStrictEqual([['Nickname', 'Pat'], ['Birthday', new Date(2026, 5, 30)], ['Shoe', '9.5'], ['Team', 'Blue']]);

    expect(await inTenant((tx) => deleteExtendedData(repo, tx, userId, { write: WRITE }))).toBe(3);
    expect(await inTenant((tx) => repo.listExtendData(tx, [userId]))).toStrictEqual([]);
  });
});
