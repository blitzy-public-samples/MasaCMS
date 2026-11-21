import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { liveEntitySchema } from '../../src/inventory/entities.js';
import {
  LIVE_SNAPSHOT_GENERATED_BY,
  LIVE_SNAPSHOT_JSON,
  captureLiveSnapshot,
  readLiveSnapshot,
  writeLiveSnapshot,
} from '../../src/inventory/live-snapshot.js';
import type { LiveSnapshot, LiveSources } from '../../src/inventory/live-snapshot.js';
import { LIVE_CHECK_SQL } from '../../src/inventory/stored-procedures.js';
import { assertReadOnlySql } from '../../src/lib/mssql.js';
import type { ReadOnlyMssql } from '../../src/lib/mssql.js';
import { assertOutsideRepo } from '../../src/lib/paths.js';
import { readPin } from '../../src/lib/pin.js';
import { stableStringify } from '../../src/lib/report.js';

const ORIGIN = 'http://legacy.invalid:25180';
// Test value assembled at run time, not a secret.
const KEY = ['opt2', 'harness', 'snapshot', 'test'].join('-');
const HOST_FILE = '/srv/masa-webroot/core/modules/v1/filebrowser/model/beans/filebrowser.cfc';

// The probe as run.cfm answers it: fields the inventory reads plus host-specific ones it does not.
const PROBE = {
  generatedAt: '2026-11-13T20:00:00.000Z',
  bundleableBeans: ['content'],
  versionedBeans: [],
  entities: [
    {
      name: 'filebrowser',
      displayName: null,
      table: 'm_filebrowser',
      componentPath: 'muraWRM.core.modules.v1.filebrowser.model.beans.filebrowser',
      componentFile: HOST_FILE,
      isSingleton: false,
      dynamic: null,
      versioned: null,
      bundleable: false,
      historical: null,
      datasource: 'muradb_c51',
      inBundleableBeans: false,
      inVersionedBeans: false,
      properties: [{ name: 'filebrowserid', fieldtype: 'id' }],
      registrationComplete: true,
      origin: 'other',
    },
  ],
};

const column = (table: string, name: string, ordinal: number, length: number | null = 35): Record<string, unknown> => ({
  TABLE_SCHEMA: 'dbo',
  TABLE_NAME: table,
  COLUMN_NAME: name,
  DATA_TYPE: 'NVARCHAR',
  CHARACTER_MAXIMUM_LENGTH: length,
  IS_NULLABLE: 'YES',
  ORDINAL_POSITION: ordinal,
});

const CATALOG = {
  tables: [
    { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'tsettings' },
    { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'm_filebrowser' },
  ],
  columns: [column('tsettings', 'notes', 2, -1), column('tsettings', 'SiteID', 1), column('m_filebrowser', 'filebrowserid', 1)],
  keys: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'm_filebrowser', COLUMN_NAME: 'filebrowserid', ORDINAL_POSITION: 1 }],
};

/** Read-only fake answering the catalog queries and, from `procedures`, the stored-procedure check. */
function fakeDb(procedures: readonly unknown[] = []): { db: ReadOnlyMssql; calls: string[] } {
  const calls: string[] = [];
  const db: ReadOnlyMssql = {
    readOnlyQuery<T>(sql: string): Promise<T[]> {
      assertReadOnlySql(sql);
      calls.push(sql);
      if (sql === LIVE_CHECK_SQL[0]) return Promise.resolve([...procedures] as T[]);
      if (LIVE_CHECK_SQL.includes(sql)) return Promise.resolve([]);
      if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) return Promise.resolve(CATALOG.keys as T[]);
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return Promise.resolve(CATALOG.columns as T[]);
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) return Promise.resolve(CATALOG.tables as T[]);
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
    close: () => Promise.resolve(),
  };
  return { db, calls };
}

function sources(procedures: readonly unknown[] = []) {
  const { db, calls } = fakeDb(procedures);
  const fetch = vi.fn(
    async (_input: string, _init: RequestInit) =>
      new Response(JSON.stringify(PROBE), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const live: LiveSources = { origin: ORIGIN, db, fixturesLoaded: false, env: { OPT2_HARNESS_KEY: KEY }, fetch };
  return { ...live, fetch, calls };
}

const pin = readPin();
let dir: string;
let captured: LiveSnapshot;

beforeAll(async () => {
  dir = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-live-snapshot-'));
  captured = await captureLiveSnapshot(sources([{ schemaName: 'dbo', name: 'usp_live', objectType: 'P ' }]));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('captureLiveSnapshot', () => {
  it('records the probe, the catalog and the stored-procedure check, stamped with the pinned SHA', () => {
    expect(captured).toMatchObject({
      sourceSha: pin.sha,
      generatedBy: LIVE_SNAPSHOT_GENERATED_BY,
      fixturesLoaded: false,
      entities: { generatedAt: PROBE.generatedAt, bundleableBeans: ['content'], versionedBeans: [] },
      catalog: [
        { schema: 'dbo', name: 'm_filebrowser', primaryKey: ['filebrowserid'], hasPrimaryKey: true, hasSiteId: false },
        {
          schema: 'dbo',
          name: 'tsettings',
          columns: [
            { name: 'SiteID', type: 'nvarchar', length: 35, nullable: true },
            { name: 'notes', type: 'nvarchar', length: 'max', nullable: true },
          ],
          primaryKey: [],
          hasPrimaryKey: false,
          hasSiteId: true,
        },
      ],
      storedProcedures: {
        procedures: 1,
        total: 1,
        takenBeforeFixtures: true,
        objects: [{ schema: 'dbo', name: 'usp_live', kind: 'procedure', objectType: 'P' }],
      },
    });
    expect(Number.isNaN(Date.parse(captured.storedProcedures.checkedAt))).toBe(false);
  });

  it('keeps only the registration fields the inventory reads, so no host path, origin or key is recorded', () => {
    expect(captured.entities.entities).toEqual([
      {
        name: 'filebrowser',
        table: 'm_filebrowser',
        componentPath: 'muraWRM.core.modules.v1.filebrowser.model.beans.filebrowser',
        versioned: null,
        bundleable: false,
        historical: null,
        registrationComplete: true,
        origin: 'other',
      },
    ]);
    expect(Object.keys(captured.entities.entities[0] ?? {}).sort()).toEqual(Object.keys(liveEntitySchema.shape).sort());
    const text = stableStringify(captured);
    for (const hostValue of [HOST_FILE, ORIGIN, 'legacy.invalid', '25180', 'muradb_c51', KEY]) expect(text).not.toContain(hostValue);
  });

  it('queries the probe with the harness key, then the catalog, then the stored-procedure check, all read-only', async () => {
    const s = sources();
    await captureLiveSnapshot(s);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(s.fetch.mock.calls[0]?.[1].headers).get('x-opt2-harness-key')).toBe(KEY);
    expect(s.calls.slice(0, 3).map((sql) => /INFORMATION_SCHEMA\.(\w+)/.exec(sql)?.[1])).toEqual(['TABLES', 'COLUMNS', 'TABLE_CONSTRAINTS']);
    expect(s.calls.slice(3)).toEqual(LIVE_CHECK_SQL);
  });
});

describe('writeLiveSnapshot and readLiveSnapshot', () => {
  it('writes stable JSON that reads back equal and rewrites byte-identically', async () => {
    const file = await writeLiveSnapshot(captured, dir);
    expect(file).toBe(path.join(dir, LIVE_SNAPSHOT_JSON));
    const text = await readFile(file, 'utf8');
    expect(text).toBe(stableStringify(captured));
    expect(await readLiveSnapshot(file)).toEqual(captured);
    await writeLiveSnapshot((await readLiveSnapshot(file)) as LiveSnapshot, dir);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('returns null when no snapshot file exists', async () => {
    expect(await readLiveSnapshot(path.join(dir, 'absent', LIVE_SNAPSHOT_JSON))).toBeNull();
  });

  const edit = (change: (s: Record<string, unknown>) => void) => (s: LiveSnapshot): string => {
    const copy = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    change(copy);
    return JSON.stringify(copy);
  };
  const storedProcedures = (s: Record<string, unknown>): Record<string, unknown> => s.storedProcedures as Record<string, unknown>;

  it.each<{ name: string; text: (s: LiveSnapshot) => string; error: RegExp }>([
    { name: 'text that is not JSON', text: () => '{', error: /is not valid JSON/ },
    { name: 'an unknown top-level key', text: edit((s) => (s.origin = ORIGIN)), error: /does not match its schema[\s\S]*origin/ },
    { name: 'another generator', text: edit((s) => (s.generatedBy = 'hand-written')), error: /does not match its schema[\s\S]*generatedBy/ },
    { name: 'a missing stored-procedure check', text: edit((s) => delete s.storedProcedures), error: /does not match its schema[\s\S]*storedProcedures/ },
    { name: 'a negative count', text: edit((s) => (storedProcedures(s).total = -1)), error: /does not match its schema[\s\S]*total/ },
    { name: 'a checkedAt that is no timestamp', text: edit((s) => (storedProcedures(s).checkedAt = 'yesterday')), error: /does not match its schema[\s\S]*checkedAt/ },
    {
      name: 'a registration carrying a host path',
      text: edit((s) => (((s.entities as { entities: Record<string, unknown>[] }).entities[0] as Record<string, unknown>).componentFile = HOST_FILE)),
      error: /does not match its schema[\s\S]*componentFile/,
    },
    { name: 'a malformed SHA', text: edit((s) => (s.sourceSha = 'HEAD')), error: /does not match its schema[\s\S]*sourceSha/ },
  ])('rejects a snapshot with $name', async ({ name, text, error }) => {
    const file = path.join(dir, `${name.replaceAll(' ', '-')}.json`);
    await writeFile(file, text(captured), 'utf8');
    await expect(readLiveSnapshot(file)).rejects.toThrow(error);
  });

  it('rejects a snapshot taken at another pin', async () => {
    const file = path.join(dir, 'other-pin.json');
    await writeFile(file, stableStringify({ ...captured, sourceSha: '0'.repeat(40) }), 'utf8');
    await expect(readLiveSnapshot(file)).rejects.toThrow(/live snapshot sourceSha 0{40} differs from the pinned SHA/);
  });
});
