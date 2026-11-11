// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance table definitions against the target DDL, the fixture DDL, the ownership file and the platform repository contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, canonicalTypeForSqlServer, createRepository } from '@opt2/platform/migration-kit';
import { BUCKETS, InvalidObjectKeyError, objectKey } from '@opt2/platform/storage';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  ATTACHMENT_BUCKET,
  ATTACHMENT_CONTENT_FIELD,
  FINANCE_ATTACHMENT,
  OWNED_TABLES,
  OWNER,
  PROGRAM_BINDING,
  SCHEMA,
  UNITS,
  attachmentObjectKey,
} from '../../src/repo/tables.js';

interface DdlColumn {
  name: string;
  type: string;
}

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const TARGET_DDL = read('../../db/migrations/0001_finance.sql');
const FIXTURE_DDL = read('../../../../legacy-fixtures/sql/finance/110_tables.program.sql');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as { units: { unit: string; owner: string }[] };

/** Columns the target adds to every folded fixture table. */
const TARGET_ONLY = ['tenant_id', 'object_key', 'legacy_program_id', 'row_version'];

/** Trimmed, non-empty body lines of the first `CREATE TABLE` block that `head` opens and `tail` closes. */
function tableBody(ddl: string, head: string, tail: string): string[] {
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`no table ${head}`);
  const from = start + head.length;
  return ddl.slice(from, ddl.indexOf(tail, from)).split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Columns and primary key of `finance.<table>` in `0001_finance.sql`. */
function targetTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(TARGET_DDL, `CREATE TABLE finance.${table} (`, '\n);').map((line) => line.replace(/,$/, ''));
  const definitions = body.filter((line) => !/^(?:PRIMARY KEY|UNIQUE|CHECK)\b/.test(line));
  const columns = definitions.flatMap((line) => {
    const m = /^([a-z_0-9]+) (.+?)(?: (?:NOT NULL|NULL|DEFAULT|PRIMARY KEY|UNIQUE)\b.*)?$/.exec(line);
    return m === null ? [] : [{ name: m[1] as string, type: m[2] as string }];
  });
  const inline = definitions.find((line) => / PRIMARY KEY\b/.test(line))?.split(' ')[0];
  const declared = /^PRIMARY KEY \(([^)]+)\)/.exec(body.find((line) => line.startsWith('PRIMARY KEY')) ?? '');
  const primaryKey = inline !== undefined ? [inline] : (declared?.[1] ?? '').split(',').map((column) => column.trim());
  return { columns, primaryKey };
}

/** Columns of `[Program_N].[finance_<table>]` in `110_tables.program.sql`, names lower-cased, types with their arguments. */
function fixtureTable(table: string): DdlColumn[] {
  return tableBody(FIXTURE_DDL, `CREATE TABLE [$(PROGRAM_SCHEMA)].[finance_${table}] (`, ') ON [PRIMARY]').flatMap((line) => {
    const m = /^\[(\w+)\] \[(\w+)\](?: \(([^)]*)\))?/.exec(line);
    return m === null ? [] : [{ name: (m[1] as string).toLowerCase(), type: m[3] === undefined ? (m[2] as string) : `${m[2]}(${m[3]})` }];
  });
}

const canonical = ({ name, type, scale }: { name: string; type: string; scale?: number | undefined }) => ({ name, type, scale });

describe.each([...OWNED_TABLES, PROGRAM_BINDING].map((definition) => [definition.table, definition] as const))('finance.%s', (table, definition) => {
  it('lists the target DDL columns in catalog order with their canonical tags', () => {
    expect(definition.columns.map(canonical)).toEqual(
      targetTable(table).columns.map((column) => canonical({ name: column.name, ...canonicalTypeForPostgres(column.type) })),
    );
  });

  it('keys on the target primary key without tenant_id', () => {
    expect(targetTable(table).primaryKey).toEqual(['tenant_id', ...(definition.key ?? [])]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(definition) && Object.isFrozen(definition.columns) && Object.isFrozen(definition.key)).toBe(true);
    expect(definition.columns.every((column) => Object.isFrozen(column))).toBe(true);
  });
});

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('finance.%s unit', (table, definition) => {
  it('carries exactly the fixture columns besides the target-only ones, never the attachment bytes', () => {
    const fixture = fixtureTable(table).filter((column) => column.name !== ATTACHMENT_CONTENT_FIELD);
    expect(definition.columns.filter((column) => !TARGET_ONLY.includes(column.name)).map(canonical)).toEqual(
      fixture.map((column) => canonical({ name: column.name, ...canonicalTypeForSqlServer(column.type) })),
    );
  });

  it('is gated by its own finance unit', () => {
    expect(definition.unit).toBe(`finance.${table}`);
  });
});

describe('finance tables', () => {
  it('declares one table per ownership-file unit in UNITS order, which the platform repository accepts', () => {
    const owned = OWNERSHIP.units.filter((unit) => unit.owner === 'finance').map((unit) => unit.unit);
    expect([...UNITS].sort()).toEqual(owned.sort());
    expect(OWNED_TABLES.map((definition) => definition.unit)).toEqual([...UNITS]);
    expect(createRepository({ owner: OWNER, schema: SCHEMA, tables: OWNED_TABLES }).units()).toEqual([...UNITS]);
    expect(Object.isFrozen(OWNED_TABLES) && Object.isFrozen(UNITS)).toBe(true);
  });

  it('keeps program_binding out of the gated repository', () => {
    expect('unit' in PROGRAM_BINDING).toBe(false);
    expect(() => createRepository({ owner: OWNER, schema: SCHEMA, tables: [PROGRAM_BINDING] })).toThrow(/key/);
  });

  it('stores attachment bytes in a platform bucket, not in a column', () => {
    expect(BUCKETS).toContain(ATTACHMENT_BUCKET);
    expect(FINANCE_ATTACHMENT.columns.map((column) => column.name)).not.toContain(ATTACHMENT_CONTENT_FIELD);
  });
});

describe('attachmentObjectKey', () => {
  const tenantId = '0b0e9c1c-6a3b-5d8e-9f10-112233445566';
  const id = cfUuid();

  it.each([
    ['Invoice.PDF', 'pdf'],
    ['archive.tar.gz', 'gz'],
    ['README', 'bin'],
    ['trailing.', 'bin'],
    ['odd.p-df', 'bin'],
    ['accent.pdé', 'bin'],
    ['', 'bin'],
  ])('keys %j with extension %s', (fileName, ext) => {
    expect(attachmentObjectKey(tenantId, id, fileName)).toBe(objectKey({ tenantId, id, ext }));
  });

  it('returns the same key for the same inputs', () => {
    expect(attachmentObjectKey(tenantId, id, 'a.pdf')).toBe(attachmentObjectKey(tenantId, id, 'a.pdf'));
  });

  it('rejects an attachment id that is not a CF UUID', () => {
    expect(() => attachmentObjectKey(tenantId, 'ID', 'a.pdf')).toThrow(InvalidObjectKeyError);
  });
});
