import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSourceTree } from '../../src/inventory/closure.js';
import type { SourceTree } from '../../src/inventory/closure.js';
import {
  BOOTSTRAP_DDL,
  LIVE_CHECK_SQL,
  foreignKeyCheck,
  liveCheck,
  staticCheck,
  storedProcedureCheck,
  stripSqlComments,
} from '../../src/inventory/stored-procedures.js';
import type { CheckResult, StaticMatch } from '../../src/inventory/stored-procedures.js';
import { assertReadOnlySql } from '../../src/lib/mssql.js';
import type { ReadOnlyMssql } from '../../src/lib/mssql.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/cfml/', import.meta.url));
const CLEAN_UPDATE = 'core/mura/dbUpdates/9.9.cfm';
const REFUTING_UPDATE = 'core/mura/dbUpdates/9.10.cfm';
const VARIANT_UPDATE = 'core/mura/dbUpdates/9.11.cfm';
const APPLICATION_CFC = 'core/mura/dbUpdates/Application.cfc';
const NOW = new Date('2026-06-30T12:00:00.000Z');
const clock = (): Date => NOW;

const APPLICATION_SOURCE = ['component {', '\tthis.name = "CREATE PROCEDURE ignored";', '}', ''].join('\n');

const VARIANT_DDL_LINES = [
  '-- CREATE PROCEDURE in_line_comment',
  '/* CREATE FUNCTION in_block /* CREATE TRIGGER nested */ still comment */',
  `SELECT 'it''s -- quoted', [col--name], "id--q" FROM t; CREATE PROC usp_after_literals AS SELECT 1`,
  'CREATE PROCEDURE muradb.dbo.usp_three AS SELECT 1',
  'CREATE TABLE tchild (parentID char(35) REFERENCES tparent (parentID))',
  'ALTER TABLE tchild ADD FOREIGN KEY (otherID) REFERENCES tother (otherID)',
  '-- CREATE TRIGGER tail_comment REFERENCES tcomment',
];

const VARIANT_UPDATE_LINES = [
  '<!--- CREATE PROCEDURE in_tag_comment <!--- nested ---> CREATE TRIGGER still_comment --->',
  '<cfquery>',
  'create function dbo.fn_lower() RETURNS int AS BEGIN RETURN 1 END',
  'CREATE TRIGGER [dbo].[tr_fixture]]x] ON tfixture AFTER INSERT AS SELECT 1',
  'Create Proc usp_short AS SELECT 1',
  'CREATE OR ALTER PROCEDURE "synthetic"."usp_or""alter" AS SELECT 1',
  'CREATE FUNCTION',
  '</cfquery>',
  '<cfscript>',
  '\t// CREATE FUNCTION in_line_comment',
  '\t/* CREATE TRIGGER in_block_comment */',
  '\tcreateProcedureCount = 0;',
  '</cfscript>',
  '',
];

type Slot = 'procedures' | 'triggers' | 'databaseTriggers' | 'functions' | 'fixtureSchemas';
type CatalogRows = Partial<Record<Slot, readonly unknown[]>>;

/** Slot of each statement, in `LIVE_CHECK_SQL` order. */
const SLOTS: readonly Slot[] = ['procedures', 'triggers', 'databaseTriggers', 'functions', 'fixtureSchemas'];

const LIVE_PROCEDURE = { schemaName: 'dbo', name: 'usp_live', objectType: 'P ' };

interface RecordedQuery {
  sql: string;
  params: Record<string, unknown> | undefined;
}

/** Fake read-only client that applies the real guard, records each statement and answers per catalog slot. */
function fakeDb(rows: CatalogRows = {}): { db: ReadOnlyMssql; calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  const db: ReadOnlyMssql = {
    async readOnlyQuery<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
      assertReadOnlySql(sql);
      calls.push({ sql, params });
      const slot = SLOTS[LIVE_CHECK_SQL.indexOf(sql)];
      if (slot === undefined) throw new Error(`unexpected catalog query: ${sql}`);
      return [...(rows[slot] ?? [])] as T[];
    },
    close: async () => undefined,
  };
  return { db, calls };
}

async function placeText(root: string, rel: string, text: string): Promise<void> {
  const target = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

async function placeFixture(root: string, rel: string, fixture: string): Promise<void> {
  const target = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(FIXTURES, fixture), target);
}

async function buildCleanTree(root: string): Promise<void> {
  await placeFixture(root, BOOTSTRAP_DDL, 'mssql-excerpt.sql');
  await placeFixture(root, CLEAN_UPDATE, 'dbupdate-excerpt.cfm');
  await placeText(root, APPLICATION_CFC, APPLICATION_SOURCE);
}

let tmpRoot: string;
const trees = {} as Record<'clean' | 'refuting' | 'variants', SourceTree>;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-sp-'));
  const clean = path.join(tmpRoot, 'clean');
  const refuting = path.join(tmpRoot, 'refuting');
  const variants = path.join(tmpRoot, 'variants');
  await buildCleanTree(clean);
  await buildCleanTree(refuting);
  await placeFixture(refuting, REFUTING_UPDATE, 'dbupdate-with-proc.cfm');
  await placeText(variants, BOOTSTRAP_DDL, VARIANT_DDL_LINES.join('\n'));
  await placeText(variants, VARIANT_UPDATE, VARIANT_UPDATE_LINES.join('\n'));
  await placeText(variants, 'core/mura/dbUpdates/archive/old.cfm', '<cfquery>CREATE PROCEDURE usp_nested_dir</cfquery>\n');
  await placeText(variants, 'core/mura/dbUpdates/notes.txt', 'CREATE PROCEDURE usp_not_cfm\n');
  trees.clean = openSourceTree(clean);
  trees.refuting = openSourceTree(refuting);
  trees.variants = openSourceTree(variants);
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('stripSqlComments', () => {
  it('blanks line and nested block comments while keeping every offset and newline', () => {
    const block = '/* c /* d */ e */';
    const sql = `a -- x\nb ${block} f`;
    const stripped = stripSqlComments(sql);
    expect(stripped).toBe(`a ${' '.repeat(4)}\nb ${' '.repeat(block.length)} f`);
    expect(stripped).toHaveLength(sql.length);
  });

  it('keeps comment markers inside literals and quoted identifiers', () => {
    const code = `SELECT 'a''--b', [c]]--d], "e""--f" `;
    expect(stripSqlComments(`${code}-- gone`)).toBe(`${code}${' '.repeat(7)}`);
  });

  it.each([
    { label: 'an unterminated block comment', sql: 'x /* open', expected: `x ${' '.repeat(7)}` },
    { label: 'an unterminated literal', sql: "x 'open -- not a comment", expected: "x 'open -- not a comment" },
    { label: 'a line comment at the end of the text', sql: 'x -- tail', expected: `x ${' '.repeat(7)}` },
  ])('handles $label', ({ sql, expected }) => {
    expect(stripSqlComments(sql)).toBe(expected);
  });
});

describe('staticCheck', () => {
  it('finds no routine or trigger in the clean tree and skips Application.cfc', () => {
    const result = staticCheck(trees.clean, { expectedDbUpdates: 1 });
    expect(result).toEqual({ files: [BOOTSTRAP_DDL, CLEAN_UPDATE], scanned: 2, matches: [], count: 0 });
    expect(result.files).not.toContain(APPLICATION_CFC);
  });

  it('refutes the assumption when a dbUpdate creates a procedure', () => {
    const result = staticCheck(trees.refuting, { expectedDbUpdates: 2 });
    expect(result.files).toEqual([BOOTSTRAP_DDL, REFUTING_UPDATE, CLEAN_UPDATE]);
    expect(result.count).toBe(1);
    expect(result.matches).toEqual<StaticMatch[]>([
      {
        path: REFUTING_UPDATE,
        line: 3,
        kind: 'procedure',
        schema: 'dbo',
        name: 'usp_fixture_refuted',
        text: 'CREATE PROCEDURE dbo.usp_fixture_refuted AS SELECT 1',
      },
    ]);
  });

  it('matches every statement form case-insensitively outside comments, with parsed object names', () => {
    const result = staticCheck(trees.variants, { expectedDbUpdates: null });
    const line = (lines: readonly string[], n: number): string => (lines[n - 1] ?? '').trim();
    expect(result.files).toEqual([BOOTSTRAP_DDL, VARIANT_UPDATE]);
    expect(result.matches).toEqual<StaticMatch[]>([
      { path: BOOTSTRAP_DDL, line: 3, kind: 'procedure', schema: null, name: 'usp_after_literals', text: line(VARIANT_DDL_LINES, 3) },
      { path: BOOTSTRAP_DDL, line: 4, kind: 'procedure', schema: 'dbo', name: 'usp_three', text: line(VARIANT_DDL_LINES, 4) },
      { path: VARIANT_UPDATE, line: 3, kind: 'function', schema: 'dbo', name: 'fn_lower', text: line(VARIANT_UPDATE_LINES, 3) },
      { path: VARIANT_UPDATE, line: 4, kind: 'trigger', schema: 'dbo', name: 'tr_fixture]x', text: line(VARIANT_UPDATE_LINES, 4) },
      { path: VARIANT_UPDATE, line: 5, kind: 'procedure', schema: null, name: 'usp_short', text: line(VARIANT_UPDATE_LINES, 5) },
      { path: VARIANT_UPDATE, line: 6, kind: 'procedure', schema: 'synthetic', name: 'usp_or"alter', text: line(VARIANT_UPDATE_LINES, 6) },
      { path: VARIANT_UPDATE, line: 7, kind: 'function', schema: null, name: null, text: 'CREATE FUNCTION' },
    ]);
    expect(result.count).toBe(7);
  });

  it('throws when the schema-update count differs from the pinned 37', () => {
    expect(() => staticCheck(trees.clean)).toThrow('expected 37 core/mura/dbUpdates/*.cfm files, found 1');
    expect(() => staticCheck(trees.refuting, { expectedDbUpdates: 1 })).toThrow(
      'expected 1 core/mura/dbUpdates/*.cfm files, found 2',
    );
  });
});

describe('foreignKeyCheck', () => {
  it('reports no foreign keys in the clean tree', () => {
    expect(foreignKeyCheck(trees.clean, { expectedDbUpdates: 1 })).toEqual({ static: 0, matches: [] });
  });

  it('lists FOREIGN KEY and REFERENCES clauses outside comments', () => {
    expect(foreignKeyCheck(trees.variants, { expectedDbUpdates: 1 })).toEqual({
      static: 3,
      matches: [
        { path: BOOTSTRAP_DDL, line: 5, clause: 'REFERENCES', text: VARIANT_DDL_LINES[4] },
        { path: BOOTSTRAP_DDL, line: 6, clause: 'FOREIGN KEY', text: VARIANT_DDL_LINES[5] },
        { path: BOOTSTRAP_DDL, line: 6, clause: 'REFERENCES', text: VARIANT_DDL_LINES[5] },
      ],
    });
  });
});

describe('liveCheck', () => {
  it('sends only read-only statements that leave out the fixture schemas', async () => {
    const { db, calls } = fakeDb();
    await liveCheck(db, { clock });
    expect(calls.map((c) => c.sql)).toEqual([...LIVE_CHECK_SQL]);
    for (const { sql, params } of calls) {
      expect(() => assertReadOnlySql(sql)).not.toThrow();
      expect(params).toBeUndefined();
    }
    const [procedures, triggers, databaseTriggers, functions, probe] = calls.map((c) => c.sql);
    for (const sql of [procedures, triggers, functions]) {
      expect(sql).toContain("s.name <> 'synthetic'");
      expect(sql).toContain("s.name NOT LIKE 'Program[_]%'");
    }
    expect(procedures).toContain('FROM sys.procedures');
    expect(triggers).toContain('t.parent_class = 1');
    expect(databaseTriggers).toContain('t.parent_class = 0');
    expect(functions).toContain("o.type IN ('FN', 'IF', 'TF')");
    expect(probe).toContain("s.name = 'synthetic' OR s.name LIKE 'Program[_]%'");
  });

  it('reports zero objects outside the fixture schemas', async () => {
    const { db } = fakeDb();
    expect(await liveCheck(db, { clock })).toEqual({
      procedures: 0,
      triggers: 0,
      databaseTriggers: 0,
      functions: 0,
      total: 0,
      excludedSchemas: ['synthetic', 'Program_*'],
      takenBeforeFixtures: true,
      checkedAt: NOW.toISOString(),
      objects: [],
    });
  });

  it('counts one live procedure', async () => {
    const result = await liveCheck(fakeDb({ procedures: [LIVE_PROCEDURE] }).db, { clock });
    expect(result.procedures).toBe(1);
    expect(result.total).toBe(1);
    expect(result.objects).toEqual([{ schema: 'dbo', name: 'usp_live', kind: 'procedure', objectType: 'P' }]);
  });

  it('counts every category and names each object', async () => {
    const { db } = fakeDb({
      procedures: [LIVE_PROCEDURE],
      triggers: [{ schemaName: 'dbo', name: 'tr_live', objectType: 'TR' }],
      databaseTriggers: [{ schemaName: null, name: 'ddl_live', objectType: 'TR' }],
      functions: [
        { schemaName: 'dbo', name: 'fn_scalar', objectType: 'FN' },
        { schemaName: 'opt2_sync', name: 'fn_table', objectType: 'TF' },
      ],
    });
    const result = await liveCheck(db, { clock });
    expect(result).toMatchObject({ procedures: 1, triggers: 1, databaseTriggers: 1, functions: 2, total: 5 });
    expect(result.objects).toEqual([
      { schema: 'dbo', name: 'usp_live', kind: 'procedure', objectType: 'P' },
      { schema: 'dbo', name: 'tr_live', kind: 'trigger', objectType: 'TR' },
      { schema: null, name: 'ddl_live', kind: 'database-trigger', objectType: 'TR' },
      { schema: 'dbo', name: 'fn_scalar', kind: 'function', objectType: 'FN' },
      { schema: 'opt2_sync', name: 'fn_table', kind: 'function', objectType: 'TF' },
    ]);
  });

  it.each([
    { label: 'the caller reports fixtures loaded', rows: {}, fixturesLoaded: true },
    { label: 'a fixture schema already exists', rows: { fixtureSchemas: [{ name: 'Program_1' }] }, fixturesLoaded: false },
  ])('marks the count as not taken before fixtures when $label', async ({ rows, fixturesLoaded }) => {
    const result = await liveCheck(fakeDb(rows).db, { clock, fixturesLoaded });
    expect(result.takenBeforeFixtures).toBe(false);
  });

  it('stamps checkedAt from the system clock by default', async () => {
    const before = Date.now();
    const { checkedAt } = await liveCheck(fakeDb().db);
    expect(new Date(checkedAt).toISOString()).toBe(checkedAt);
    expect(Date.parse(checkedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe('storedProcedureCheck', () => {
  it('leaves the live part pending when no database is given', async () => {
    const check = await storedProcedureCheck(trees.clean, { expectedDbUpdates: 1 });
    expect(check).toEqual({
      static: { files: [BOOTSTRAP_DDL, CLEAN_UPDATE], scanned: 2, matches: [], count: 0 },
      foreignKeys: { static: 0, matches: [] },
      live: null,
      liveStatus: 'pending-run',
      expected: 0,
      result: 'pending-run',
      findings: [],
    });
  });

  it.each<{ label: string; tree: 'clean' | 'refuting'; live: CatalogRows | null; result: CheckResult }>([
    { label: 'confirms a clean tree with zero live objects', tree: 'clean', live: {}, result: 'confirmed' },
    { label: 'refutes a clean tree with one live procedure', tree: 'clean', live: { procedures: [LIVE_PROCEDURE] }, result: 'refuted' },
    { label: 'refutes the refuting tree without a live check', tree: 'refuting', live: null, result: 'refuted' },
    { label: 'refutes the refuting tree with zero live objects', tree: 'refuting', live: {}, result: 'refuted' },
  ])('$label', async ({ tree, live, result }) => {
    const db = live === null ? undefined : fakeDb(live).db;
    const check = await storedProcedureCheck(trees[tree], { expectedDbUpdates: null, clock, db });
    expect(check.result).toBe(result);
    expect(check.liveStatus).toBe(live === null ? 'pending-run' : 'live');
    expect(check.live === null).toBe(live === null);
    expect(check.expected).toBe(0);
  });

  it('names static findings before live findings', async () => {
    const { db } = fakeDb({ procedures: [LIVE_PROCEDURE] });
    const check = await storedProcedureCheck(trees.refuting, { expectedDbUpdates: 2, clock, db });
    expect(check.findings).toEqual([
      { name: 'usp_fixture_refuted', schema: 'dbo', kind: 'procedure', origin: 'static', source: { path: REFUTING_UPDATE, line: 3 } },
      { name: 'usp_live', schema: 'dbo', kind: 'procedure', origin: 'live', source: null },
    ]);
  });

  it('passes fixturesLoaded and the clock to the live check', async () => {
    const check = await storedProcedureCheck(trees.clean, { expectedDbUpdates: 1, fixturesLoaded: true, clock, db: fakeDb().db });
    expect(check.live?.takenBeforeFixtures).toBe(false);
    expect(check.live?.checkedAt).toBe(NOW.toISOString());
    expect(check.result).toBe('confirmed');
  });

  it('rejects a tree whose schema-update count differs from the pinned 37', async () => {
    await expect(storedProcedureCheck(trees.clean)).rejects.toThrow('expected 37 core/mura/dbUpdates/*.cfm files, found 1');
  });
});
