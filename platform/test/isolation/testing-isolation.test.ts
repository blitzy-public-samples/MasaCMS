import { inspect, isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '../../src/legacy-compat/ids.js';
import { rlsSql, tenantRegistrySql, type TenantTx } from '../../src/tenancy/index.js';
import type { TenantFixture } from '../../src/testing/fixtures.js';
import { defineIsolationSuite, type IsolationSuiteOptions, type SuiteApi } from '../../src/testing/isolation.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';

const available = await pgAvailable();
const SOURCE = 'tiso';
const TABLES = [
  'note',
  'leaked_note',
  'leaked_mapped_note',
  'bare_note',
  'mapped_note',
  'open_note',
  'revoked_note',
  'partial_note',
  'misnamed_note',
] as const;
/** Cases defineIsolationSuite registers for one table: 3 read, 6 write, 1 pooled-reuse, catalog and guard. */
const CASES_PER_TABLE = 12;

/** A business table whose id is a NOT NULL domain and whose payload is NOT NULL, neither with a default. */
function tableSql(table: string): string {
  return `CREATE TABLE ${SOURCE}.${table} (tenant_id uuid NOT NULL, id ${SOURCE}.cf_id PRIMARY KEY, body text NOT NULL)`;
}

/** The tenant policy of `table`, with WITH CHECK (true) on open_note so any tenant's row passes the write check. */
function policySql(table: string): string {
  const sql = rlsSql(SOURCE, table);
  return table === 'open_note' ? sql.replace(/WITH CHECK \(.*\);$/, 'WITH CHECK (true);') : sql;
}

type Note = { id: string; body: string };

let handle: ThrowawaySchema | undefined;
/** DTOs without tenant fields of the rows writeAs stored, per table. */
const written = new Map<string, Note[]>();
/** Tenant id of each id writeAs stored. */
const ownerOfId = new Map<string, string>();

/** A fresh complete row of `table` for `tenant`. */
function completeRow(table: string, tenant: TenantFixture): Note {
  return { id: cfUuid(), body: `${table} of ${tenant.key}` };
}

/** Inserts a complete row of `table` for `tenant` and records its DTO and owner. */
async function writeComplete(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const row = completeRow(table, tenant);
  await tx.query(`INSERT INTO ${tx.schema}.${table} (tenant_id, id, body) VALUES ($1, $2, $3)`, [tenant.tenantId, row.id, row.body]);
  written.set(table, [...(written.get(table) ?? []), row]);
  ownerOfId.set(row.id, tenant.tenantId);
}

/** The rows of `table` visible in `tx`, with their tenant ids. */
async function readWithTenant(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT tenant_id::text AS tenant_id, id, body FROM ${tx.schema}.${table}`)).rows;
}

/** The rows of `table` visible in `tx`, as DTOs without tenant fields. */
async function readBare(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT id, body FROM ${tx.schema}.${table}`)).rows;
}

/** Every tenant's DTOs of `table` from the write cache, ignoring the transaction's tenant. */
function readLeaked(_tx: TenantTx, table: string): Promise<unknown[]> {
  return Promise.resolve([...(written.get(table) ?? [])]);
}

/** The tenant writeAs stored a DTO's id under. */
function tenantFromId(_table: string, row: unknown): string | undefined {
  return ownerOfId.get((row as Note).id);
}

/** Suite options over `table` with complete writes and rows, tenant-carrying reads and `overrides`. */
function optionsFor(table: string, overrides: Partial<IsolationSuiteOptions> = {}): IsolationSuiteOptions {
  return { db: () => handle, tables: [table], writeAs: writeComplete, readAs: readWithTenant, rowFor: completeRow, ...overrides };
}

type Kind = 'read' | 'write' | 'pool' | 'other';

/** The case family a registered case name belongs to. */
function kindOf(name: string): Kind {
  if (name.includes('sees only its own rows')) return 'read';
  if (name.includes('cannot insert, move into')) return 'write';
  if (name.includes('pooled connection reused')) return 'pool';
  return 'other';
}

/** Throws a message naming `label`, `actual` and `expected` unless `pass`. */
function check(pass: boolean, label: string | undefined, actual: unknown, relation: string, expected: unknown): void {
  if (!pass) {
    const show = (value: unknown): string => inspect(value, { breakLength: Infinity });
    throw new Error(`${label ?? 'value'}: expected ${show(actual)} ${relation} ${show(expected)}`);
  }
}

interface Recorded {
  api: SuiteApi;
  hooks: (() => Promise<void>)[];
  cases: { name: string; fn: () => Promise<void> }[];
}

/** A SuiteApi that runs describe bodies at once, collects hooks and cases, and throws on the first failed expectation. */
function recordingApi(): Recorded {
  const recorded: Recorded = {
    hooks: [],
    cases: [],
    api: {
      describe: (_name, fn) => {
        fn();
      },
      it: (name, fn) => {
        recorded.cases.push({ name, fn });
      },
      beforeAll: (fn) => {
        recorded.hooks.push(fn);
      },
      expect: (actual, label) => ({
        toBe: (expected) => {
          check(Object.is(actual, expected), label, actual, 'to be', expected);
        },
        toEqual: (expected) => {
          check(isDeepStrictEqual(actual, expected), label, actual, 'to equal', expected);
        },
        toBeGreaterThanOrEqual: (expected) => {
          check(typeof actual === 'number' && actual >= expected, label, actual, 'to be at least', expected);
        },
      }),
    },
  };
  return recorded;
}

interface Scenario {
  label: string;
  table: (typeof TABLES)[number];
  overrides?: Partial<IsolationSuiteOptions>;
  afterSeed?: (db: ThrowawaySchema) => Promise<void>;
  failures: Partial<Record<Kind, number>>;
  /** Pattern every failure message matches. */
  message?: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'a readAs leaking the DTOs of every tenant without tenant fields fails every read case',
    table: 'leaked_note',
    overrides: { readAs: readLeaked },
    failures: { read: 3 },
    message: /owners other than tenant .* in leaked_note: expected \[ 'no tenant', 'no tenant', 'no tenant' \]/,
  },
  {
    label: 'a readAs leaking the DTOs of every tenant fails every read case when tenantOf names their owners',
    table: 'leaked_mapped_note',
    overrides: { readAs: readLeaked, tenantOf: tenantFromId },
    failures: { read: 3 },
    message: /owners other than tenant .* in leaked_mapped_note: expected \[ '[0-9a-f-]{36}', '[0-9a-f-]{36}' \]/,
  },
  {
    label: 'own-tenant DTOs without tenant fields fail every read case when no tenantOf names their owner',
    table: 'bare_note',
    overrides: { readAs: readBare },
    failures: { read: 3 },
    message: /expected \[ 'no tenant' \]/,
  },
  {
    label: 'own-tenant DTOs without tenant fields pass every case when tenantOf names their owner',
    table: 'mapped_note',
    overrides: { readAs: readBare, tenantOf: tenantFromId },
    failures: {},
  },
  {
    label: 'a WITH CHECK (true) policy fails every cross-tenant write case and the pooled-reuse case',
    table: 'open_note',
    failures: { write: 6, pool: 1 },
    message: /INSERT of the same row .*'no error'/,
  },
  {
    label: 'an app role without INSERT fails every write and pooled-reuse case on the complete-row control',
    table: 'revoked_note',
    afterSeed: async (db) => {
      await db.adminPool.query(`REVOKE INSERT ON ${db.schema}.revoked_note FROM ${db.roles.app}`);
    },
    failures: { write: 6, pool: 1 },
    message: /INSERT of a complete .*: expected '42501' to be 'no error'/,
  },
  {
    label: 'a rowFor omitting the NOT NULL payload fails every write and pooled-reuse case on the complete-row control',
    table: 'partial_note',
    overrides: { rowFor: () => ({ id: cfUuid() }) },
    failures: { write: 6, pool: 1 },
    message: /INSERT of a complete .*: expected '23502' to be 'no error'/,
  },
  {
    label: 'a rowFor returning a non-snake column fails every write and pooled-reuse case with a TypeError naming it',
    table: 'misnamed_note',
    overrides: { rowFor: () => ({ id: cfUuid(), 'Body") --': 'x' }) },
    failures: { write: 6, pool: 1 },
    message: /^defineIsolationSuite: rowFor\("misnamed_note"\) returned non-snake columns \["Body\\"\) --"\]$/,
  },
];

describe.skipIf(!available)('defineIsolationSuite', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'testing-isolation',
      schemaName: SOURCE,
      extraSql: [
        `CREATE DOMAIN ${SOURCE}.cf_id AS char(35) NOT NULL`,
        tenantRegistrySql(SOURCE),
        ...TABLES.flatMap((table) => [tableSql(table), policySql(table)]),
      ],
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  defineIsolationSuite({ describe, it, expect, beforeAll }, optionsFor('note', { name: 'NOT NULL domain id and payload' }));

  it.each(SCENARIOS)('$label', async ({ table, overrides, afterSeed, failures, message }) => {
    const recorded = recordingApi();
    defineIsolationSuite(recorded.api, optionsFor(table, overrides));
    for (const hook of recorded.hooks) await hook();
    if (afterSeed !== undefined && handle !== undefined) await afterSeed(handle);
    const failed: { name: string; message: string }[] = [];
    for (const { name, fn } of recorded.cases) {
      try {
        await fn();
      } catch (err) {
        failed.push({ name, message: err instanceof Error ? err.message : String(err) });
      }
    }
    const counts: Partial<Record<Kind, number>> = {};
    for (const { name } of failed) counts[kindOf(name)] = (counts[kindOf(name)] ?? 0) + 1;
    expect(recorded.cases).toHaveLength(CASES_PER_TABLE);
    expect(counts).toEqual(failures);
    expect(failed.filter((failure) => message !== undefined && !message.test(failure.message))).toEqual([]);
  });
});
