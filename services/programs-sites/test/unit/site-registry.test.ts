/** Site registry inputs: the site.changed payload built from site rows and the tsettings and tdirectories mappings. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  encodeRow,
  encodeValue,
  resolveTenant,
  type CanonicalColumn,
  type CanonicalValue,
  type Mapping,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { isTenantId, tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import { contentPoolIds, siteChangedPayload, siteDomains } from '../../src/domain/pools.js';
import { siteChangedValidator } from '../../src/events/consumers.js';
import { SITE_COLUMNS, applySet, newSiteBean, type SiteBean, type SiteData, type SiteRow } from '../../src/legacy/site-fields.js';
import { tdirectoriesMapping } from '../../src/migration/mappings/tdirectories.js';
import { tsettingsMapping } from '../../src/migration/mappings/tsettings.js';
import { DIRECTORY, SITE, type ProgramsSitesTableDefinition } from '../../src/repo/tables.js';

const PAYLOAD_KEYS = Object.keys({
  siteId: true,
  publicUserPoolId: true,
  privateUserPoolId: true,
  categoryPoolId: true,
  filePoolId: true,
  displayPoolId: true,
  contentPoolIds: true,
  domains: true,
} satisfies Record<keyof SiteChangedPayload, true>);

const POOL_COLUMNS = ['publicuserpoolid', 'privateuserpoolid', 'categorypoolid', 'filepoolid', 'displaypoolid', 'contentpoolid'];
const PLATFORM_COLUMNS = new Set(['tenant_id', 'row_version']);

function siteRow(overrides: SiteRow = {}): SiteRow {
  return { siteid: 'tenant-a', domain: 'a.example.test', ...overrides };
}

function poolColumns(value: string | null): SiteRow {
  return Object.fromEntries(POOL_COLUMNS.map((column) => [column, value]));
}

function siteBean(data: SiteData): SiteBean {
  return applySet(newSiteBean(), { siteID: 'tenant-a', ...data });
}

describe('siteChangedPayload', () => {
  it('carries the stored pools, content pool list and domains of a pooled site', () => {
    const payload = siteChangedPayload(
      siteRow({
        publicuserpoolid: 'umbrella',
        privateuserpoolid: 'tenant-a',
        categorypoolid: 'umbrella',
        filepoolid: 'umbrella',
        displaypoolid: 'umbrella',
        contentpoolid: 'tenant-a,umbrella',
        domainalias: 'www.a.example.test',
      }),
    );

    expect(payload).toStrictEqual({
      siteId: 'tenant-a',
      publicUserPoolId: 'umbrella',
      privateUserPoolId: 'tenant-a',
      categoryPoolId: 'umbrella',
      filePoolId: 'umbrella',
      displayPoolId: 'umbrella',
      contentPoolIds: ['tenant-a', 'umbrella'],
      domains: ['a.example.test', 'www.a.example.test'],
    });
  });

  it.each<{ name: string; pools: SiteRow }>([
    { name: 'NULL', pools: poolColumns(null) },
    { name: 'absent', pools: {} },
    { name: 'empty', pools: poolColumns('') },
    { name: 'blank', pools: poolColumns('   ') },
  ])("defaults every $name pool to the site's own id", ({ pools }) => {
    const payload = siteChangedPayload(siteRow(pools));

    expect(payload).toMatchObject({
      siteId: 'tenant-a',
      publicUserPoolId: 'tenant-a',
      privateUserPoolId: 'tenant-a',
      categoryPoolId: 'tenant-a',
      filePoolId: 'tenant-a',
      displayPoolId: 'tenant-a',
      contentPoolIds: ['tenant-a'],
    });
  });

  it('has exactly the eight registry fields, passes the published contract and holds no tenant UUID', () => {
    const payload = siteChangedPayload(siteRow({ publicuserpoolid: 'umbrella', isremote: 1, resourcedomain: 'cdn.example.test' }));

    expect(Object.keys(payload).sort()).toEqual([...PAYLOAD_KEYS].sort());
    expect(siteChangedValidator.validatePayload(payload)).toStrictEqual({ ok: true, value: payload });
    const values = Object.values(payload).flat();
    expect(values.filter((value) => isTenantId(value))).toEqual([]);
    expect(values).not.toContain(tenantIdForSite('tenant-a'));
  });
});

describe('contentPoolIds', () => {
  it.each<{ name: string; stored: string; expected: string[] }>([
    { name: 'a padded list with empty entries', stored: ' tenant-a, ,umbrella ,, default ', expected: ['tenant-a', 'umbrella', 'default'] },
    { name: 'a list', stored: 'umbrella,tenant-a', expected: ['umbrella', 'tenant-a'] },
    { name: 'a single site', stored: 'umbrella', expected: ['umbrella'] },
    { name: 'an empty value', stored: '', expected: ['tenant-a'] },
    { name: 'a lone comma', stored: ',', expected: ['tenant-a'] },
    { name: 'only blanks and commas', stored: ' , ,, ', expected: ['tenant-a'] },
  ])('reads $name as the site ids $expected in stored order', ({ stored, expected }) => {
    expect(contentPoolIds(siteBean({ contentPoolID: stored }))).toEqual(expected);
  });
});

describe('siteDomains', () => {
  it.each<{ name: string; data: SiteData; expected: string[] }>([
    { name: 'the domain alone', data: { domain: 'a.example.test' }, expected: ['a.example.test'] },
    {
      name: 'the resource domain of a remote site after the domain',
      data: { domain: 'a.example.test', isRemote: 1, resourceDomain: 'cdn.example.test' },
      expected: ['a.example.test', 'cdn.example.test'],
    },
    {
      name: 'the resource domain of a site with any non-zero isRemote',
      data: { domain: 'a.example.test', isRemote: '2', resourceDomain: 'cdn.example.test' },
      expected: ['a.example.test', 'cdn.example.test'],
    },
    {
      name: 'no resource domain of a site that is not remote',
      data: { domain: 'a.example.test', isRemote: 0, resourceDomain: 'cdn.example.test' },
      expected: ['a.example.test'],
    },
    {
      name: 'no empty resource domain of a remote site',
      data: { domain: 'a.example.test', isRemote: 1, resourceDomain: '' },
      expected: ['a.example.test'],
    },
    {
      name: 'domain, resource domain, then each alias line split on CR, LF and CRLF without blank lines',
      data: {
        domain: 'a.example.test',
        isRemote: 1,
        resourceDomain: 'cdn.example.test',
        domainAlias: 'www.a.example.test\r\nold.a.example.test\n\nalt.a.example.test\rlast.a.example.test',
      },
      expected: ['a.example.test', 'cdn.example.test', 'www.a.example.test', 'old.a.example.test', 'alt.a.example.test', 'last.a.example.test'],
    },
    {
      name: 'alias lines untrimmed inside the stored value',
      data: { domain: 'a.example.test', domainAlias: 'www.a.example.test\r\n  spaced.a.example.test  \r\nlast.a.example.test' },
      expected: ['a.example.test', 'www.a.example.test', '  spaced.a.example.test  ', 'last.a.example.test'],
    },
    {
      name: 'each domain once, case-insensitively, in its first casing',
      data: {
        domain: 'A.Example.Test',
        isRemote: 1,
        resourceDomain: 'a.example.test',
        domainAlias: 'WWW.a.example.test\r\nwww.A.example.test\r\nA.EXAMPLE.TEST',
      },
      expected: ['A.Example.Test', 'WWW.a.example.test'],
    },
    { name: 'nothing for a site without domain or aliases', data: { domain: '', domainAlias: '' }, expected: [] },
    { name: 'the aliases of a site without a domain', data: { domainAlias: 'www.a.example.test' }, expected: ['www.a.example.test'] },
  ])('lists $name', ({ data, expected }) => {
    expect(siteDomains(siteBean(data))).toEqual(expected);
  });
});

interface MappingCase {
  mapping: Mapping;
  table: ProgramsSitesTableDefinition;
  legacyTable: string;
  legacyColumns: readonly string[];
  columnCount: number;
  key: string[];
  keyValue: string;
  siteColumn: string;
}

const MAPPING_CASES: readonly MappingCase[] = [
  {
    mapping: tsettingsMapping,
    table: SITE,
    legacyTable: 'tsettings',
    legacyColumns: SITE_COLUMNS.map((column) => column.legacyName),
    columnCount: 103,
    key: ['SiteID'],
    keyValue: 'tenant-a',
    siteColumn: 'SiteID',
  },
  {
    mapping: tdirectoriesMapping,
    table: DIRECTORY,
    legacyTable: 'tdirectories',
    legacyColumns: ['dirID', 'siteID', 'subdir', 'editfilename'],
    columnCount: 4,
    key: ['dirID'],
    keyValue: 'DIR00000-0000-0000-0000000000000001',
    siteColumn: 'siteID',
  },
];

const SAMPLE_DATETIME = '2024-02-29T23:59:59.997';
const SAMPLE_LOCAL_DATE = new Date(2024, 1, 29, 23, 59, 59, 997);

// Every fourth column NULL; text with delimiters, control characters and non-ASCII; a leap-day datetime at its last tick.
function sampleValue(column: CanonicalColumn, index: number): CanonicalValue {
  if (index % 4 === 3) return null;
  switch (column.type) {
    case 's':
      return `${column.name}:${String(index)},ü\r\n`;
    case 'i':
      return String(index - 50);
    case 't':
      return SAMPLE_DATETIME;
    default:
      throw new Error(`no sample for canonical type ${column.type}`);
  }
}

function legacyRow({ mapping, key, keyValue, siteColumn }: MappingCase): Record<string, CanonicalValue> {
  const row = Object.fromEntries(mapping.legacyColumns.map((column, index) => [column.name, sampleValue(column, index)]));
  return { ...row, [siteColumn]: 'tenant-a', [key[0] as string]: keyValue };
}

// The values pg returns for the same row: integers as numbers and datetimes as local Dates.
function pgRow(mapping: Mapping, target: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    mapping.targetColumns.map(({ name, type }) => {
      const value = target[name];
      if (typeof value !== 'string' || type === 's') return [name, value];
      return [name, type === 'i' ? Number(value) : SAMPLE_LOCAL_DATE];
    }),
  );
}

function tenantSource(mapping: Mapping): TenantSource {
  if (mapping.tenant === undefined) throw new Error(`${mapping.legacyTable} declares no tenant source`);
  return mapping.tenant;
}

describe.each(MAPPING_CASES.map((mappingCase) => [mappingCase.legacyTable, mappingCase] as const))('%s mapping', (_name, mappingCase) => {
  const { mapping, table } = mappingCase;

  it('maps the legacy table to the schema-qualified target table and unit of its repository definition', () => {
    expect(mapping.legacyTable).toBe(mappingCase.legacyTable);
    expect(mapping.targetTable).toBe(table.unit);
    expect(mapping.unit).toBe(table.unit);
    expect(mapping.targetTable).toBe(`programs_sites.${table.table}`);
  });

  it('is keyed by its legacy primary key and is not a keyless multiset', () => {
    expect(mapping.key).toEqual(mappingCase.key);
    expect(mapping.keyless).toBe(false);
    expect(mapping.split).toBeUndefined();
    expect(mapping.fold).toBeUndefined();
  });

  it('maps every legacy column in catalog spelling to its lower-cased target column and canonical type', () => {
    expect(mapping.columns).toHaveLength(mappingCase.columnCount);
    expect(mapping.legacyColumns.map((column) => column.name)).toEqual(mappingCase.legacyColumns);
    expect(mapping.columns.map((column) => column.target)).toEqual(mappingCase.legacyColumns.map((name) => name.toLowerCase()));
    expect(mapping.targetColumns).toEqual(table.columns.filter((column) => !PLATFORM_COLUMNS.has(column.name)));
  });

  it('leaves the target-only tenant_id and row_version out of the legacy side', () => {
    const legacyNames = mapping.legacyColumns.map((column) => column.name.toLowerCase());
    expect(table.columns.map((column) => column.name)).toContain('tenant_id');
    expect(legacyNames).not.toContain('tenant_id');
    expect(legacyNames).not.toContain('row_version');
  });

  it("resolves each row to the tenant of the row's own site", () => {
    expect(mapping.tenant).toStrictEqual({ kind: 'site', column: mappingCase.siteColumn });
    expect(resolveTenant(tenantSource(mapping), legacyRow(mappingCase), { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID })).toStrictEqual({
      tenantId: tenantIdForSite('tenant-a'),
      siteId: 'tenant-a',
      orphan: false,
    });
  });

  it.each<{ name: string; targetRow: (target: Record<string, unknown>) => Record<string, unknown> }>([
    { name: 'the target parameters', targetRow: (target) => target },
    { name: 'the values pg returns', targetRow: (target) => pgRow(mapping, target) },
  ])('re-encodes $name byte for byte as the legacy row', ({ targetRow }) => {
    const encoding = encodeRow(mapping.legacyColumns, legacyRow(mappingCase));
    const decoded = mapping.decodeLegacy(mapping.legacyColumns, encoding);
    const target = mapping.toTarget(decoded);

    expect(Object.keys(target)).toEqual(mapping.targetColumns.map((column) => column.name));
    const row = targetRow(target);
    expect(Object.keys(mapping.toLegacy(row))).toEqual(mappingCase.legacyColumns);
    expect(mapping.encodeLegacy(row)).toBe(encoding);
    expect(mapping.encodeLegacyKey(row)).toBe(encodeValue('s', mappingCase.keyValue));
  });
});

describe('mapping construction against a drifted table definition', () => {
  afterEach(() => {
    vi.doUnmock('../../src/repo/tables.js');
    vi.resetModules();
  });

  it.each<{ legacyTable: string; definition: 'SITE' | 'DIRECTORY'; dropped: string; load: () => Promise<unknown> }>([
    { legacyTable: 'tsettings', definition: 'SITE', dropped: 'domainAlias', load: () => import('../../src/migration/mappings/tsettings.js') },
    {
      legacyTable: 'tdirectories',
      definition: 'DIRECTORY',
      dropped: 'editfilename',
      load: () => import('../../src/migration/mappings/tdirectories.js'),
    },
  ])('refuses to build $legacyTable when its target lacks the column for $dropped', async ({ legacyTable, definition, dropped, load }) => {
    vi.resetModules();
    vi.doMock('../../src/repo/tables.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/repo/tables.js')>();
      const columns = actual[definition].columns.filter((column) => column.name !== dropped.toLowerCase());
      return { ...actual, [definition]: { ...actual[definition], columns } };
    });

    const failure: unknown = await load().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ name: 'MappingError', table: legacyTable });
    expect((failure as Error).message).toContain(dropped);
  });
});
