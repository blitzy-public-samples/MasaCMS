// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Communications table definitions against the target DDL, the fixture DDL, table ownership and the platform repository contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, canonicalTypeForSqlServer, createRepository } from '@opt2/platform/migration-kit';
import { isQueueName } from '@opt2/platform/tasks';
import {
  MESSAGE_SOURCES,
  MESSAGE_STATES,
  OWNED_TABLES,
  SCHEDULED_TASK,
  SCHEDULED_TASK_KINDS,
  SCHEDULED_TASK_ORIGINS,
  SCHEDULED_TASK_QUEUES,
  SCHEDULED_TASK_STATUSES,
  TARGET_ONLY_COLUMNS,
  UNITS,
} from '../../src/repo/tables.js';

interface DdlColumn {
  name: string;
  type: string;
  check?: string[];
}

interface OwnershipTarget {
  unit: string;
  owner: string;
  table: string;
  keyColumns: string[];
  ownedColumns: string[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: { table: string; targets?: OwnershipTarget[] }[];
}

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const TARGET_DDL = read('../../db/migrations/0002_communications.sql');
const FIXTURE_DDL = read('../../../../legacy-fixtures/sql/communications/100_tables.sql');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as Ownership;
const EVENT = JSON.parse(read('../../contracts/events/communications.message.delivery-status-changed.v1.json')) as {
  properties: Record<string, { enum?: string[] }>;
};
const KEYLESS_KEY = ['tenant_id', 'legacy_row_hash', 'occurrence'];
const MANAGED = new Set(KEYLESS_KEY);

/** Body lines of the first `CREATE TABLE` block that `head` opens and `tail` closes. */
function tableBody(ddl: string, head: string, tail: string): string[] {
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`no table ${head}`);
  const from = start + head.length;
  return ddl.slice(from, ddl.indexOf(tail, from)).split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Columns (with any `IN (...)` check) and primary key of `communications.<table>` in `0002_communications.sql`. */
function targetTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(TARGET_DDL, `CREATE TABLE communications.${table} (`, '\n);');
  const columns = body.flatMap((line) => {
    const m = /^([a-z_]+) (.+?) (?:NOT NULL|NULL)\b(.*)$/.exec(line);
    if (m === null) return [];
    const check = /CHECK \(\w+ IN \(([^)]*)\)\)/.exec(m[3] as string)?.[1];
    const column: DdlColumn = { name: m[1] as string, type: m[2] as string };
    if (check !== undefined) column.check = check.split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
    return [column];
  });
  const primaryKey = /^PRIMARY KEY \(([^)]+)\)/.exec(body.find((line) => line.startsWith('PRIMARY KEY')) ?? '');
  return { columns, primaryKey: (primaryKey?.[1] ?? '').split(',').map((column) => column.trim()) };
}

/** Columns of `[synthetic].[<table>]` in `100_tables.sql`, names lower-cased. */
function fixtureTable(table: string): DdlColumn[] {
  return tableBody(FIXTURE_DDL, `CREATE TABLE [synthetic].[${table}] (`, '\n) ON').flatMap((line) => {
    const m = /^\[(\w+)\] \[(\w+)\]/.exec(line);
    return m === null ? [] : [{ name: (m[1] as string).toLowerCase(), type: m[2] as string }];
  });
}

const checkOf = (table: string, column: string): string[] | undefined =>
  targetTable(table).columns.find((candidate) => candidate.name === column)?.check;

const masaTargets = OWNERSHIP.tables
  .filter((entry) => !entry.table.startsWith('synthetic.'))
  .flatMap((entry) => (entry.targets ?? []).filter((target) => target.owner === 'communications'));

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('communications.%s', (table, definition) => {
  it('lists the target DDL columns in catalog order with their canonical tags', () => {
    expect(definition.columns.map(({ name, type }) => ({ name, type }))).toEqual(
      targetTable(table).columns.map((column) => ({ name: column.name, type: canonicalTypeForPostgres(column.type).type })),
    );
  });

  it('keys on the target primary key without tenant_id, or is keyless', () => {
    expect(targetTable(table).primaryKey).toEqual(definition.key === null ? KEYLESS_KEY : ['tenant_id', ...definition.key]);
  });

  it('is gated by its own unit', () => {
    expect(definition.unit).toBe(`communications.${table}`);
  });
});

describe.each(['message_template', 'message', 'delivery_status'])('fixture-mapped communications.%s', (table) => {
  it('carries exactly the fixture columns besides tenant_id and its target-only columns', () => {
    const local = new Set(['tenant_id', ...(TARGET_ONLY_COLUMNS[table] ?? [])]);
    const definition = OWNED_TABLES.find((candidate) => candidate.table === table);
    expect(definition?.columns.filter((column) => !local.has(column.name)).map(({ name, type }) => ({ name, type }))).toEqual(
      fixtureTable(table).map((column) => ({ name: column.name, type: canonicalTypeForSqlServer(column.type).type })),
    );
  });
});

describe.each(masaTargets.map((target) => [target.table, target] as const))('Masa-mapped communications.%s', (table, target) => {
  it('carries exactly the owned legacy columns, lower-cased, and is keyless exactly when legacy has no key', () => {
    const definition = OWNED_TABLES.find((candidate) => candidate.table === table);
    expect(definition?.columns.filter((column) => !MANAGED.has(column.name)).map((column) => column.name)).toEqual(
      target.ownedColumns.map((column) => column.toLowerCase()),
    );
    expect(definition?.key === null).toBe(target.keyColumns.length === 0);
  });
});

describe('communications tables', () => {
  it('declares exactly the units opt2/table-ownership.json assigns, which the platform repository reports', () => {
    const owned = OWNERSHIP.units.filter((unit) => unit.owner === 'communications').map((unit) => unit.unit);
    const repository = createRepository({ owner: 'communications', schema: 'communications', tables: OWNED_TABLES });
    expect([...UNITS].sort()).toEqual(owned.sort());
    expect(repository.units()).toEqual([...UNITS]);
    expect(repository.definition('scheduled_task')).toEqual(SCHEDULED_TASK);
  });

  it.each([
    ['message', 'source', MESSAGE_SOURCES],
    ['delivery_status', 'source', MESSAGE_SOURCES],
    ['scheduled_task', 'kind', SCHEDULED_TASK_KINDS],
    ['scheduled_task', 'status', SCHEDULED_TASK_STATUSES],
  ] as const)('%s.%s equals its CHECK constraint', (table, column, values) => {
    expect(checkOf(table, column)).toEqual([...values]);
  });

  it('keeps the event vocabulary of message states and sources and starts at the fixture default', () => {
    expect([...MESSAGE_STATES]).toEqual(EVENT.properties['state']?.enum);
    expect([...MESSAGE_SOURCES]).toEqual(EVENT.properties['source']?.enum);
    expect(/DEFAULT \(N'(\w+)'\)/.exec(FIXTURE_DDL)?.[1]).toBe(MESSAGE_STATES[0]);
  });

  it('records task origins and queues the DDL leaves unconstrained', () => {
    expect(checkOf('scheduled_task', 'origin')).toBeUndefined();
    expect(SCHEDULED_TASK_ORIGINS).toEqual(['event', 'adopted']);
    expect(SCHEDULED_TASK_QUEUES.every((queue) => isQueueName(queue))).toBe(true);
  });

  it('keeps source, event_id and row_version target-only', () => {
    expect(TARGET_ONLY_COLUMNS).toEqual({ message: ['source', 'event_id', 'row_version'], delivery_status: ['source'] });
  });
});
