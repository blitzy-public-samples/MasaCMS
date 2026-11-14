import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeRow, encodeKey, encodeRow, legacyRowHash } from '../../src/migration-kit/canonical.js';
import type { CanonicalColumn } from '../../src/migration-kit/canonical.js';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  LEGACY_PROGRAM_ID_COLUMN,
  MappingError,
  assertBatchTenant,
  defineMapping,
  diffCoverage,
  mappingCoverage,
  parseProgramTable,
  programTableName,
  resolveTenant,
} from '../../src/migration-kit/mapping.js';
import type { MappingSpec } from '../../src/migration-kit/mapping.js';
import { tenantIdForSite } from '../../src/tenancy/index.js';

const base: MappingSpec = {
  legacyTable: 'tusers',
  targetTable: 'people.person',
  columns: [
    { legacy: 'UserID', target: 'user_id', type: 's' },
    { legacy: 'Fname', target: 'fname', type: 's' },
    { legacy: 'SiteID', target: 'site_id', type: 's' },
  ],
  key: ['UserID'],
};

const allTags: MappingSpec = {
  legacyTable: 'synthetic.sample',
  targetTable: 'stub.sample',
  columns: [
    { legacy: 'id', target: 'id', type: 's' },
    { legacy: 'n', target: 'n', type: 'i' },
    { legacy: 'f', target: 'f', type: 'f' },
    { legacy: 'amount', target: 'amount', type: 'd', scale: 4 },
    { legacy: 'at', target: 'at', type: 't' },
    { legacy: 'bytes', target: 'bytes', type: 'b' },
    { legacy: 'siteID', target: 'site_id', type: 's' },
  ],
  key: ['id'],
};

describe('defineMapping validation', () => {
  const cases: Array<[string, Partial<MappingSpec>, RegExp]> = [
    ['duplicate legacy column (case-insensitive)', { columns: [...base.columns, { legacy: 'userid', target: 'x', type: 's' }] }, /mapped twice/],
    ['duplicate target column', { columns: [...base.columns, { legacy: 'Lname', target: 'fname', type: 's' }] }, /mapped twice/],
    ['reserved tenant_id', { columns: [...base.columns, { legacy: 'X', target: 'tenant_id', type: 's' }] }, /managed by the platform/],
    ['unknown type', { columns: [{ legacy: 'UserID', target: 'user_id', type: 'z' as 's' }] }, /invalid canonical type/],
    ['decimal without scale', { columns: [...base.columns, { legacy: 'amt', target: 'amt', type: 'd' }] }, /invalid canonical type or scale/],
    ['key not mapped', { key: ['Nope'] }, /not a mapped legacy column/],
    ['empty key', { key: [] }, /key lists no columns/],
    ['duplicate key', { key: ['UserID', 'userid'] }, /twice/],
    ['no columns', { columns: [] }, /maps no columns/],
    ['unqualified target', { targetTable: 'person' }, /schema-qualified/],
    ['unqualified unit', { unit: 'person' }, /schema-qualified/],
    ['keyless fold', { key: null, fold: 'Program', legacyTable: 'timesheet' }, /cannot be folded/],
    ['fold qualified table', { fold: 'Program', legacyTable: 'Program_1.timesheet' }, /without the Program_<id> schema/],
    [
      'fold declares legacy_program_id',
      { fold: 'Program', legacyTable: 'timesheet', columns: [...base.columns, { legacy: 'p', target: 'legacy_program_id', type: 'i' }] },
      /managed by the platform/,
    ],
    ['keyless declares legacy_row_hash', { key: null, columns: [...base.columns, { legacy: 'h', target: 'legacy_row_hash', type: 's' }] }, /managed/],
    ['split without values', { split: { by: 'Type', value: [] } }, /no values/],
    ['keyless split with unmapped discriminator', { key: null, split: { by: 'Type', value: 2, column: 'Type' } }, /discriminator column/],
    [
      'non-text site tenant column',
      { columns: [...base.columns, { legacy: 'n', target: 'n', type: 'i' }], tenant: { kind: 'site', column: 'N' } },
      /must be text/,
    ],
    ['parent tenant without columns', { tenant: { kind: 'parent', parentLegacyTable: 'tusers', columns: {} } }, /lists no key columns/],
  ];
  it.each(cases)('rejects %s', (_name, patch, message) => {
    expect(() => defineMapping({ ...base, ...patch })).toThrow(MappingError);
    expect(() => defineMapping({ ...base, ...patch })).toThrow(message);
  });

  it('wraps the canonical cause and names the table', () => {
    let thrown: unknown;
    try {
      defineMapping({ ...base, columns: [{ legacy: 'a', target: 'a', type: 'd' }], key: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MappingError);
    expect((thrown as MappingError).table).toBe('tusers');
    expect((thrown as MappingError).message).toMatch(/^tusers: /);
    expect((thrown as MappingError).cause).toBeDefined();
  });

  it('exposes frozen, declared-order columns and resolves key spelling', () => {
    const mapping = defineMapping({ ...base, key: ['userid'] });
    expect(Object.isFrozen(mapping)).toBe(true);
    expect(Object.isFrozen(mapping.legacyColumns)).toBe(true);
    expect(mapping.key).toEqual(['UserID']);
    expect(mapping.unit).toBe('people.person');
    expect(mapping.keyless).toBe(false);
    expect(mapping.legacyColumns.map((c) => c.name)).toEqual(['UserID', 'Fname', 'SiteID']);
    expect(mapping.targetColumns.map((c) => c.name)).toEqual(['user_id', 'fname', 'site_id']);
    expect(mapping.tenant).toEqual({ kind: 'site', column: 'SiteID' });
    expect(defineMapping({ ...base, unit: 'people.roster' }).unit).toBe('people.roster');
    expect(defineMapping({ ...base, columns: base.columns.slice(0, 2) }).tenant).toBeUndefined();
  });
});

describe('split rules', () => {
  const tusers = defineMapping({
    ...base,
    targetTable: 'identity.user_account',
    columns: [...base.columns, { legacy: 'Type', target: 'type', type: 'i' }],
    split: { by: 'Type', value: 2, column: 'type' },
  });

  it('accepts by row column, Type=2 only', () => {
    expect(tusers.split?.column).toBe('Type');
    expect(tusers.acceptsRow({ Type: '2' })).toBe(true);
    expect(tusers.acceptsRow({ type: '1' })).toBe(false);
    expect(tusers.acceptsRow({ Type: null }, 2)).toBe(false);
    expect(tusers.acceptsRow({}, 2)).toBe(true);
    expect(tusers.acceptsRow({})).toBe(false);
  });

  it('accepts by supplied discriminator for baseTable and objectClass', () => {
    const ext = defineMapping({ ...base, legacyTable: 'tclassextenddata', split: { by: 'baseTable', value: ['tcontent', 'tsettings'] } });
    expect(ext.acceptsRow({}, 'TContent')).toBe(true);
    expect(ext.acceptsRow({}, 'tsettings   ')).toBe(true);
    expect(ext.acceptsRow({}, 'tusers')).toBe(false);
    expect(ext.acceptsRow({}, null)).toBe(false);
    const trash = defineMapping({ ...base, legacyTable: 'ttrash', split: { by: 'objectClass', value: 'contentBean', column: 'objectClass' } });
    expect(trash.acceptsRow({ objectClass: 'contentBean' })).toBe(true);
    expect(trash.acceptsRow({ objectClass: Buffer.from('contentBean') })).toBe(true);
    expect(trash.acceptsRow({ objectClass: 'userBean' })).toBe(false);
    expect(defineMapping(base).acceptsRow({})).toBe(true);
    expect(Object.isFrozen(ext.split?.value)).toBe(true);
  });

  it('decodeLegacy keeps a discriminator-only column and owned columns', () => {
    const trash = defineMapping({ ...base, legacyTable: 'ttrash', split: { by: 'objectClass', value: 'contentBean', column: 'objectClass' } });
    const request: CanonicalColumn[] = [
      { name: 'userid', type: 's' },
      { name: 'Fname', type: 's' },
      { name: 'objectclass', type: 's' },
      { name: 'Other', type: 'i' },
      { name: 'SiteID', type: 's' },
    ];
    const encoding = encodeRow(request, { userid: 'U1', Fname: null, objectclass: 'contentBean', Other: '5', SiteID: 'default' });
    expect(trash.decodeLegacy(request, encoding)).toEqual({ UserID: 'U1', Fname: null, SiteID: 'default', objectClass: 'contentBean' });
    expect(() => trash.decodeLegacy(request.slice(0, 2), encodeRow(request.slice(0, 2), { userid: 'U', Fname: 'F' }))).toThrow(/lack owned column SiteID/);
    const wrongType: CanonicalColumn[] = [{ name: 'UserID', type: 'i' }, { name: 'Fname', type: 's' }, { name: 'SiteID', type: 's' }];
    expect(() => trash.decodeLegacy(wrongType, encodeRow(wrongType, { UserID: 1, Fname: 'a', SiteID: 'b' }))).toThrow(/mapped as s but encoded as i/);
    expect(() => trash.decodeLegacy(request, 'garbage')).toThrow(MappingError);
  });
});

describe('row conversion', () => {
  const mapping = defineMapping(allTags);
  const legacyValues = {
    id: 'A1',
    n: '9007199254740993',
    f: '1.5',
    amount: '12.3400',
    at: '2026-06-30T10:11:12.003',
    bytes: Buffer.from('abc'),
    siteID: 'tenant-a',
    ignored: 'x',
  };

  it('converts every tag to a pg parameter and back', () => {
    const target = mapping.toTarget(legacyValues);
    expect(target).toEqual({
      id: 'A1',
      n: '9007199254740993',
      f: 1.5,
      amount: '12.3400',
      at: '2026-06-30 10:11:12.003',
      bytes: Buffer.from('abc'),
      site_id: 'tenant-a',
    });
    const legacy = mapping.toLegacy(target);
    expect(Object.keys(legacy)).toEqual(['id', 'n', 'f', 'amount', 'at', 'bytes', 'siteID']);
    const expected = encodeRow(mapping.legacyColumns, legacyValues);
    expect(mapping.encodeLegacy(target)).toBe(expected);
    expect(decodeRow(mapping.legacyColumns, mapping.encodeLegacy(target))).toEqual(decodeRow(mapping.legacyColumns, expected));
    expect(mapping.encodeLegacyKey(target)).toBe(encodeKey(mapping.legacyColumns, ['id'], legacyValues));
  });

  it('normalizes pg-shaped and non-canonical inputs, keeps nulls', () => {
    const target = mapping.toTarget({ ...legacyValues, n: '007', amount: '1.23456', at: '2026-06-30 10:11', bytes: null, f: null });
    expect(target).toMatchObject({ n: '7', amount: '1.2346', at: '2026-06-30 10:11:00.000', bytes: null, f: null });
    const pgRow = { id: 'A1', n: 5, f: 2, amount: '1.0000', at: new Date(2026, 5, 30, 10, 11, 12, 3), bytes: Buffer.from([1]), site_id: 'x' };
    expect(mapping.encodeLegacy(pgRow)).toBe(encodeRow(mapping.legacyColumns, { ...pgRow, siteID: 'x' }));
  });

  it('rejects missing and malformed values', () => {
    const { n: _n, ...withoutN } = legacyValues;
    expect(() => mapping.toTarget(withoutN)).toThrow(/no value for column n/);
    expect(() => mapping.toTarget({ ...legacyValues, n: 'abc' })).toThrow(MappingError);
    expect(() => mapping.toTarget({ ...legacyValues, id: Buffer.from('x') })).toThrow(/expects text/);
    expect(() => mapping.toLegacy({ id: 'A1' })).toThrow(/target row has no column n/);
  });

  it('matches legacy column names case-insensitively', () => {
    const { siteID: _siteID, ...rest } = legacyValues;
    expect(mapping.toTarget({ ...rest, SITEID: 'b' })).toMatchObject({ site_id: 'b' });
  });

  it('maps a key encoding to the target key values toTarget gives, in key order', () => {
    const composite = defineMapping({ ...allTags, key: ['siteID', 'at', 'n'] });
    const target = composite.toTarget(legacyValues);
    const keyed = composite.targetKey(composite.encodeLegacyKey(target));
    expect(keyed).toEqual({ site_id: target.site_id, at: target.at, n: target.n });
    expect(Object.keys(keyed)).toEqual(['site_id', 'at', 'n']);
    expect(composite.targetKey('NNN')).toEqual({ site_id: null, at: null, n: null });
  });

  it.each<[string, string[] | null, string]>([
    ['a keyless mapping', null, 's2:A1'],
    ['an encoding of another type', ['n'], 's1:7'],
    ['an encoding with trailing bytes', ['id'], 's2:A1N'],
    ['a value text not in canonical form', ['n'], 'i3:007'],
  ])('targetKey rejects %s', (_label, key, encoding) => {
    expect(() => defineMapping({ ...allTags, key }).targetKey(encoding)).toThrow(MappingError);
  });

  it('keyless mappings encode the whole row as key and hash it like legacy', () => {
    const keyless = defineMapping({ ...base, legacyTable: 'tsystemobjects', targetTable: 'programs_sites.system_object', key: null });
    expect(keyless.keyless).toBe(true);
    const row = { user_id: 'u', fname: 'f', site_id: 's' };
    const legacy = { UserID: 'u', Fname: 'f', SiteID: 's' };
    expect(keyless.encodeLegacyKey(row)).toBe(encodeRow(keyless.legacyColumns, legacy));
    expect(legacyRowHash(keyless.targetColumns, row)).toBe(legacyRowHash(keyless.legacyColumns, legacy));
  });
});

describe('Program fold', () => {
  const folded = defineMapping({ ...base, legacyTable: 'timesheet', targetTable: 'timesheets.timesheet', fold: 'Program' });

  it('adds legacy_program_id and defaults to the program tenant', () => {
    expect(folded.fold).toBe('Program');
    expect(folded.targetColumns.at(-1)).toEqual({ name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' });
    expect(folded.legacyColumns).toHaveLength(3);
    expect(folded.tenant).toEqual({ kind: 'program' });
    expect(folded.toTarget({ UserID: 'u', Fname: null, SiteID: 's' }, { legacyProgramId: 2 })).toEqual({
      user_id: 'u', fname: null, site_id: 's', legacy_program_id: '2',
    });
    expect(() => folded.toTarget({ UserID: 'u', Fname: null, SiteID: 's' })).toThrow(/legacyProgramId/);
    expect(() => folded.toTarget({ UserID: 'u', Fname: null, SiteID: 's' }, { legacyProgramId: 1.5 })).toThrow(/legacyProgramId/);
    expect(defineMapping(base).toTarget({ UserID: 'u', Fname: 'f', SiteID: 's' }, { legacyProgramId: 1 })).not.toHaveProperty(LEGACY_PROGRAM_ID_COLUMN);
  });

  it('names and parses Program tables', () => {
    expect(programTableName(1, 'timesheet')).toBe('Program_1.timesheet');
    expect(parseProgramTable('Program_1.timesheet')).toEqual({ programId: 1, table: 'timesheet' });
    expect(parseProgramTable('[Program_2].[timesheet_day]')).toEqual({ programId: 2, table: 'timesheet_day' });
    expect(parseProgramTable('[program_12].blackout')).toEqual({ programId: 12, table: 'blackout' });
    for (const name of ['dbo.tusers', 'tusers', 'Program_01.x', 'Program_1', '[Program_1.x', 'Program_1.a.b', 'Program_x.y']) {
      expect(parseProgramTable(name)).toBeNull();
    }
    expect(() => programTableName(-1, 'x')).toThrow(MappingError);
    expect(() => programTableName(1, 'a.b')).toThrow(MappingError);
  });
});

describe('tenant rule', () => {
  const lookups = {
    umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID,
    parentSiteId: (table: string, key: Record<string, unknown>) => (table === 'tusers' && key.UserID === 'U1' ? 'tenant-a' : null),
    programSiteId: (id: number) => (id === 1 ? 'tenant-a' : undefined),
  };
  const umbrella = { tenantId: tenantIdForSite('umbrella'), siteId: 'umbrella', orphan: true };

  it.each([
    ['site', { kind: 'site', column: 'siteID' } as const, { SiteID: 'tenant-a' }, {}],
    ['padded char site', { kind: 'site', column: 'siteID' } as const, { siteID: 'tenant-a                 ' }, {}],
    ['parent', { kind: 'parent', parentLegacyTable: 'tusers', columns: { userID: 'UserID' } } as const, { USERID: 'U1' }, {}],
    ['program', { kind: 'program' } as const, {}, { legacyProgramId: 1 }],
  ])('resolves %s', (_name, source, row, opts) => {
    expect(resolveTenant(source, row, lookups, opts)).toEqual({ tenantId: tenantIdForSite('tenant-a'), siteId: 'tenant-a', orphan: false });
  });

  it('resolves umbrella and orphans', () => {
    expect(resolveTenant({ kind: 'umbrella' }, {}, lookups)).toEqual({ ...umbrella, orphan: false });
    expect(resolveTenant({ kind: 'site', column: 'siteID' }, { siteID: '' }, lookups)).toEqual(umbrella);
    expect(resolveTenant({ kind: 'site', column: 'siteID' }, {}, lookups)).toEqual(umbrella);
    const parent = { kind: 'parent', parentLegacyTable: 'tusers', columns: { userID: 'UserID' } } as const;
    expect(resolveTenant(parent, { userID: 'U2' }, lookups)).toEqual(umbrella);
    expect(resolveTenant(parent, { userID: null }, lookups)).toEqual(umbrella);
    expect(resolveTenant(parent, { userID: 'U1' }, { umbrellaSiteId: 'umbrella' })).toEqual(umbrella);
    expect(resolveTenant({ kind: 'program' }, {}, lookups)).toEqual(umbrella);
    expect(resolveTenant({ kind: 'program' }, {}, lookups, { legacyProgramId: 2 })).toEqual(umbrella);
    expect(() => resolveTenant({ kind: 'umbrella' }, {}, { umbrellaSiteId: '' })).toThrow(TypeError);
  });

  it('asserts the batch tenant for site sources', () => {
    const mapping = defineMapping(base);
    const tenantA = tenantIdForSite('tenant-a');
    expect(() => assertBatchTenant(mapping, { SiteID: 'TENANT-A ' }, tenantA.toUpperCase())).not.toThrow();
    expect(() => assertBatchTenant(mapping, { SiteID: null }, tenantA)).not.toThrow();
    expect(() => assertBatchTenant(mapping, { SiteID: 'tenant-b' }, tenantA)).toThrow(MappingError);
    expect(() => assertBatchTenant(defineMapping({ ...base, tenant: { kind: 'umbrella' } }), { SiteID: 'tenant-b' }, tenantA)).not.toThrow();
    expect(() => assertBatchTenant(mapping, { SiteID: 'tenant-b' }, tenantA, { legacyProgramId: 2, programSiteId: () => 'tenant-a' })).toThrow(MappingError);
    expect(() => assertBatchTenant(mapping, { SiteID: 'tenant-a' }, tenantA, { programSiteId: () => null })).not.toThrow();
  });

  describe('program sources', () => {
    const folded = defineMapping({ ...base, legacyTable: 'timesheet', targetTable: 'timesheets.timesheet', fold: 'Program' });
    const tenantA = tenantIdForSite('tenant-a');

    it.each([
      ['the batch tenant of its program site', { legacyProgramId: 1, programSiteId: lookups.programSiteId }, tenantA],
      ['an upper-cased batch tenant of a padded program site', { legacyProgramId: 1, programSiteId: () => 'TENANT-A  ' }, tenantA.toUpperCase()],
    ])('accepts a row under %s whatever its site column holds', (_label, program, tenantId) => {
      expect(folded.tenant).toEqual({ kind: 'program' });
      expect(() => assertBatchTenant(folded, { SiteID: 'tenant-b' }, tenantId, program)).not.toThrow();
    });

    it.each([
      ['the tenant of another site', { legacyProgramId: 1, programSiteId: lookups.programSiteId }, tenantIdForSite('tenant-b')],
      ['a program the lookup maps to no site', { legacyProgramId: 2, programSiteId: lookups.programSiteId }, tenantA],
      ['a program the lookup maps to an empty site', { legacyProgramId: 1, programSiteId: () => '  ' }, tenantA],
      ['no program-site lookup', { legacyProgramId: 1 }, tenantA],
      ['no program id', { programSiteId: lookups.programSiteId }, tenantA],
    ])('rejects a row under %s', (_label, program, tenantId) => {
      expect(() => assertBatchTenant(folded, { SiteID: 'tenant-a' }, tenantId, program)).toThrow(MappingError);
    });

    it('rejects a program-sourced row without program context and names no row value', () => {
      expect(() => assertBatchTenant(folded, { UserID: 'opt2-secret-row', SiteID: 'tenant-a' }, tenantA)).toThrow(
        new MappingError('timesheet', 'a program-sourced batch needs its Program_<id>'),
      );
      expect(() => assertBatchTenant(folded, { UserID: 'opt2-secret-row' }, tenantIdForSite('tenant-b'), { legacyProgramId: 1, programSiteId: lookups.programSiteId })).toThrow(
        new MappingError('timesheet', 'Program_1 belongs to a tenant other than the batch tenant'),
      );
    });
  });
});

describe('coverage', () => {
  const person = defineMapping({ ...base, split: { by: 'Type', value: 2 } });
  const account = defineMapping({
    ...base,
    targetTable: 'identity.user_account',
    columns: [base.columns[0]!, { legacy: 'UserName', target: 'user_name', type: 's' }],
    split: { by: 'Type', value: 2 },
  });
  const group = defineMapping({ ...base, targetTable: 'identity.group_account', split: { by: 'Type', value: [1, 3] } });
  const addresses = defineMapping({ ...base, legacyTable: 'tuseraddresses', targetTable: 'people.address' });

  it('lists owned columns per legacy table and split value', () => {
    expect(mappingCoverage([person, account, group, addresses])).toEqual({
      'tusers{Type=2}': ['Fname', 'SiteID', 'UserID', 'UserName'],
      'tusers{Type=1,3}': ['Fname', 'SiteID', 'UserID'],
      tuseraddresses: ['Fname', 'SiteID', 'UserID'],
    });
  });

  it('diffs case-insensitively with missing and extra columns', () => {
    const actual = mappingCoverage([person, addresses]);
    const sameColumns = { 'tusers{type=2}': ['userid', 'FNAME', 'SiteID'], tuseraddresses: ['UserID', 'Fname', 'SiteID'] };
    expect(diffCoverage(sameColumns, actual)).toEqual({ missing: {}, extra: {} });
    expect(diffCoverage({ 'tusers{Type=2}': ['UserID', 'Lname'], tusersmemb: ['UserID'] }, actual)).toEqual({
      missing: { 'tusers{Type=2}': ['Lname'], tusersmemb: ['UserID'] },
      extra: { 'tusers{Type=2}': ['Fname', 'SiteID'], tuseraddresses: ['Fname', 'SiteID', 'UserID'] },
    });
  });
});
