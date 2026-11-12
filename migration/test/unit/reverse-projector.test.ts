// Unit tests for the reverse projector cycle and loop over fakes of the legacy database, owners, bridge, gateway and migration pool.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CURSOR_START,
  encodeRow,
  type CanonicalColumn,
  type ChangesResponse,
  type OperationStatus,
  type ProjectedChangeRow,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { CatalogColumn, TableCatalog } from '../../src/extract/index.js';
import { Opt2SyncUnavailableError, STARTUP_COUNT_SQL } from '../../src/legacy/index.js';
import { loadUnitCatalog } from '../../src/owners/index.js';
import { OperationTracker } from '../../src/reverse/operations.js';
import {
  PROJECTOR_LOCK_KEY,
  createProjectorLoop,
  liveTenantSites,
  runProjectorCycle,
  type CycleDeps,
  type ProjectorContext,
  type ProjectorHooks,
  type StartupGuardRunner,
} from '../../src/reverse/projector.js';

const catalogs = vi.hoisted((): Record<string, TableCatalog> => ({}));

vi.mock('../../src/extract/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/extract/index.js')>();
  return {
    ...original,
    readTableCatalog: vi.fn(async (_pool: unknown, ref: { qualified: string }) => {
      const found = catalogs[ref.qualified];
      if (found === undefined) throw new Error(`no catalog for ${ref.qualified}`);
      return found;
    }),
  };
});

const SITE = 'tenant-a';
const TENANT = tenantIdForSite(SITE);
const OP = 'a0000000-0000-4000-8000-00000000000a';
const USER = 'A1B2C3D4-0000-0000-0000000000000001';

function column(name: string, sqlType: string, type: CanonicalColumn['type'] = 's'): CatalogColumn {
  return { name, type, sqlType, nullable: true, maxLength: null, precision: null, numericScale: null, ordinal: 1 };
}

function table(name: string, columns: CatalogColumn[], primaryKey: string[], identity: string[] = []): TableCatalog {
  const hasPrimaryKey = primaryKey.length > 0;
  return { database: 'muradb', schema: 'dbo', table: name, qualified: name, columns, primaryKey, identityColumns: identity, hasPrimaryKey };
}

Object.assign(catalogs, {
  tusers: table(
    'tusers',
    [column('UserID', 'char'), column('SiteID', 'nvarchar'), column('Fname', 'nvarchar'), column('UserName', 'nvarchar'), column('Type', 'int', 'i')],
    ['UserID'],
  ),
  tcontent: table(
    'tcontent',
    [column('tcontent_ID', 'int', 'i'), column('SiteID', 'nvarchar'), column('ContentID', 'char'), column('Title', 'nvarchar')],
    ['tcontent_ID'],
    ['tcontent_ID'],
  ),
  tsettings: table('tsettings', [column('SiteID', 'nvarchar'), column('Site', 'nvarchar')], ['SiteID']),
  tmailinglistmembers: table('tmailinglistmembers', [column('MLID', 'char'), column('Email', 'nvarchar'), column('SiteID', 'nvarchar')], []),
});

/** Each unit's legacy table and the columns its owner encodes images over, as its export declares them. */
const UNITS: Record<string, { legacyTable: string; columns: CanonicalColumn[] }> = {
  'people.person': { legacyTable: 'tusers', columns: [{ name: 'UserID', type: 's' }, { name: 'SiteID', type: 's' }, { name: 'Fname', type: 's' }] },
  'identity.user_account': {
    legacyTable: 'tusers',
    columns: [{ name: 'UserID', type: 's' }, { name: 'UserName', type: 's' }, { name: 'Type', type: 'i' }, { name: 'SiteID', type: 's' }],
  },
  'content.content': {
    legacyTable: 'tcontent',
    columns: [{ name: 'tcontent_ID', type: 'i' }, { name: 'SiteID', type: 's' }, { name: 'ContentID', type: 's' }, { name: 'Title', type: 's' }],
  },
  'programs_sites.site': { legacyTable: 'tsettings', columns: [{ name: 'SiteID', type: 's' }, { name: 'Site', type: 's' }] },
  'communications.mailing_list_member': {
    legacyTable: 'tmailinglistmembers',
    columns: [{ name: 'MLID', type: 's' }, { name: 'Email', type: 's' }, { name: 'SiteID', type: 's' }],
  },
};

const FILE_OBJECT_COLUMNS: CanonicalColumn[] = [
  { name: 'tenant_id', type: 's' },
  { name: 'file_id', type: 's' },
  { name: 'variant', type: 's' },
  { name: 'ext', type: 's' },
  { name: 'object_key', type: 's' },
  { name: 'size', type: 'i' },
  { name: 'sha256', type: 's' },
  { name: 'content_type', type: 's' },
  { name: 'orphan', type: 'i' },
  { name: 'created_at', type: 't' },
];

// A version making every group target-authoritative, beside the committed groups file.
const committedConfig = loadConfig();
const cutoverDir = mkdtempSync(path.join(os.tmpdir(), 'reverse-projector-cutover-'));
mkdirSync(path.join(cutoverDir, 'versions'));
const groupsFile = path.join(cutoverDir, 'groups.json');
copyFileSync(committedConfig.paths.groupsFile, groupsFile);
const groupIds = (JSON.parse(readFileSync(groupsFile, 'utf8')) as { groups: { id: string }[] }).groups.map((group) => group.id);
writeFileSync(
  path.join(cutoverDir, 'versions', 'v9001.json'),
  JSON.stringify({ tableVersion: 'v9001', groupAuthority: Object.fromEntries(groupIds.map((id) => [id, 'target'])), entries: [] }),
);
const config = { ...committedConfig, paths: { ...committedConfig.paths, cutoverDir, groupsFile } };
const unitCatalog = loadUnitCatalog(config.paths.tableOwnership);
afterAll(() => rmSync(cutoverDir, { recursive: true, force: true }));

interface Statement {
  tx: number | null;
  sql: string;
  params: Record<string, unknown>;
}

interface CheckpointRecord {
  owner: string;
  tenant_id: string;
  cursor_xid: string;
  cursor_seq: string;
  applied_horizon: string;
  batch_id: string | null;
  rows_applied: number;
  updated_at: Date | null;
}

interface LegacyOptions {
  sites?: string[];
  ready?: boolean;
  /** Start-up predicate counts answered in order, then 0. */
  startupCounts?: number[];
  /** Writes matching this affect no row. */
  zeroRows?: RegExp;
  /** Writes matching this fail. */
  failOn?: RegExp;
}

/** Legacy database answering exactly the projector's statements; checkpoint upserts stage per transaction until commit. */
function fakeLegacy(options: LegacyOptions = {}) {
  const committed = new Map<string, CheckpointRecord>();
  const statements: Statement[] = [];
  const log: [string, number][] = [];
  const startupCounts = [...(options.startupCounts ?? [])];
  let nextTx = 1;
  const reply = (recordset: unknown[], rowsAffected: number[] = []) => ({ recordset, recordsets: [recordset], rowsAffected, output: {} });

  const upsert = (params: Record<string, unknown>, staged: Map<string, CheckpointRecord>) => {
    const key = `${String(params.owner)}|${String(params.tenantId)}`;
    const previous = staged.get(key) ?? committed.get(key);
    const horizon = String(params.appliedHorizon);
    const record: CheckpointRecord = {
      owner: String(params.owner),
      tenant_id: String(params.tenantId),
      cursor_xid: String(params.cursorXid),
      cursor_seq: String(params.cursorSeq),
      applied_horizon: previous !== undefined && BigInt(previous.applied_horizon) > BigInt(horizon) ? previous.applied_horizon : horizon,
      batch_id: String(params.batchId),
      rows_applied: Number(params.rowsApplied),
      updated_at: null,
    };
    staged.set(key, record);
    return reply([record]);
  };

  const handle = (text: string, params: Record<string, unknown>, staged: Map<string, CheckpointRecord> | null) => {
    if (text.includes('sys.tables')) return reply([{ n: options.ready === false ? 0 : 1 }]);
    if (text.startsWith('SELECT DISTINCT SiteID')) return reply((options.sites ?? [SITE]).map((SiteID) => ({ SiteID })));
    if (text === STARTUP_COUNT_SQL) return reply([{ n: startupCounts.shift() ?? 0 }]);
    if (text.startsWith('SELECT owner, tenant_id')) {
      const owners = Object.entries(params)
        .filter(([name]) => /^o\d+$/.test(name))
        .map(([, value]) => value);
      return reply([...committed.values()].filter((row) => owners.includes(row.owner)));
    }
    if (staged === null) throw new Error(`write outside a transaction: ${text}`);
    if (text.startsWith('UPDATE opt2_sync.projector_checkpoint')) return upsert(params, staged);
    if (options.failOn?.test(text) === true) throw new Error('legacy write failed');
    if (options.zeroRows?.test(text) === true) return reply([], [0]);
    if (/^(UPDATE|INSERT|DELETE)/.test(text)) return reply([], [1]);
    throw new Error(`unexpected legacy SQL: ${text}`);
  };

  const request = (tx: { id: number; staged: Map<string, CheckpointRecord> } | null) => {
    const params: Record<string, unknown> = {};
    const req = {
      input(name: string, ...rest: unknown[]) {
        params[name] = rest.length === 2 ? rest[1] : rest[0];
        return req;
      },
      async query(text: string) {
        statements.push({ tx: tx?.id ?? null, sql: text, params });
        return handle(text, params, tx?.staged ?? null);
      },
    };
    return req;
  };

  const pool = { request: () => request(null) };
  const legacy = {
    live: async () => pool,
    database: async () => pool,
    async transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const state = { id: nextTx++, staged: new Map<string, CheckpointRecord>() };
      try {
        const result = await fn({ request: () => request(state) } as never);
        for (const [key, value] of state.staged) committed.set(key, value);
        log.push(['commit', state.id]);
        return result;
      } catch (error) {
        log.push(['rollback', state.id]);
        throw error;
      }
    },
    close: async () => undefined,
  };
  const isCommitted = (id: number | null) => log.some(([kind, tx]) => kind === 'commit' && tx === id);
  return {
    legacy,
    committed,
    statements,
    log,
    checkpoint: (owner: string) => committed.get(`${owner}|${TENANT}`),
    /** Statements of committed transactions matching `pattern`. */
    applied: (pattern: RegExp) => statements.filter((statement) => isCommitted(statement.tx) && pattern.test(statement.sql)),
  };
}

/** Migration pool answering the advisory lock and the `projector_cursor` mirror upsert. */
function fakeDb(leader = true) {
  const mirror = new Map<string, { cursor: string; horizon: string }>();
  const db = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('the projector never acts for a tenant on the migration pool')),
    async withMetadata<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const tx = {
        schema: 'migration',
        kind: 'metadata',
        onCommit: () => undefined,
        async query(text: string, values: unknown[] = []) {
          if (text.startsWith('SELECT pg_try_advisory_xact_lock($1::bigint)')) {
            expect(values).toEqual([PROJECTOR_LOCK_KEY.toString()]);
            return { rows: [{ ok: leader }] };
          }
          if (text.startsWith('INSERT INTO "migration"."projector_cursor"')) {
            mirror.set(`${String(values[0])}|${String(values[1])}`, { cursor: String(values[2]), horizon: String(values[3]) });
            return { rows: [] };
          }
          throw new Error(`unexpected PostgreSQL SQL: ${text}`);
        },
      };
      return fn(tx as never);
    },
    end: async () => undefined,
  };
  return { db, mirror };
}

function page(rows: ProjectedChangeRow[], horizon: string, after: string, operations: Record<string, OperationStatus> = {}, complete = true): ChangesResponse {
  const last = rows.at(-1);
  return { rows, cursor: last === undefined ? after : `${last.xid}:${last.seq}`, horizon, complete, operations };
}

/** A page, or one per read of the same cursor numbered from 1. */
type PageSource = ChangesResponse | ((read: number) => ChangesResponse);

interface OwnersOptions {
  /** Pages by `<owner>|<after>`; other reads answer an empty complete page at `defaultHorizon`. */
  pages?: Record<string, PageSource>;
  defaultHorizon?: string;
  /** Legacy images each unit exports. */
  exportRows?: Record<string, Record<string, unknown>[]>;
  /** Owner whose position read fails. */
  failPosition?: string;
}

function fakeOwners({ pages = {}, defaultHorizon = '200', exportRows = {}, failPosition }: OwnersOptions = {}) {
  const reads = new Map<string, number>();
  const changes: { owner: string; after: string }[] = [];
  const positions: string[] = [];
  const watermarks: { owner: string; legacyTable: string; direction: string }[] = [];
  const exportPage = (params: { unit: string; tenantId: string }) => {
    const unit = UNITS[params.unit];
    const rows = (exportRows[params.unit] ?? []).map((values) => ({ key: 'k', row: encodeRow(unit?.columns ?? [], values), hash: 'h' }));
    return {
      unit: params.unit,
      tenantId: params.tenantId,
      tables: unit === undefined ? [] : [{ unit: params.unit, legacyTable: unit.legacyTable, targetTable: params.unit, keyless: false, columns: unit.columns, rows }],
      next: null,
    };
  };
  const owners = {
    async changes(owner: string, params: { tenantId: string; after: string }) {
      const key = `${owner}|${params.after}`;
      const read = (reads.get(key) ?? 0) + 1;
      reads.set(key, read);
      changes.push({ owner, after: params.after });
      const source = pages[key];
      if (source === undefined) return page([], defaultHorizon, params.after);
      return typeof source === 'function' ? source(read) : source;
    },
    export: async (_owner: string, params: { unit: string; tenantId: string }) => exportPage(params),
    async *exportPages(_owner: string, params: { unit: string; tenantId: string }) {
      yield exportPage(params);
    },
    async position(owner: string) {
      positions.push(owner);
      if (owner === failPosition) throw new Error(`${owner} position unavailable`);
      return { owner, position: '150', outbox: null, inbox: null };
    },
    getObject: async () => Buffer.from('hello'),
    async putWatermark(owner: string, record: { legacyTable: string; direction: string }) {
      watermarks.push({ owner, legacyTable: record.legacyTable, direction: record.direction });
      return record;
    },
  };
  return { owners, changes, positions, watermarks };
}

function fakeBridge() {
  const calls: [string, string][] = [];
  const bridge = {
    async siteRefresh(siteId: string) {
      calls.push(['siteRefresh', siteId]);
      return { refreshed: true, siteExists: true, serverTime: '2026-06-30T12:00:00' };
    },
    async purgeCache(siteId: string) {
      calls.push(['purgeCache', siteId]);
      return { ok: true };
    },
    async filesPut(siteId: string, name: string, bytes: Uint8Array, sha256: string) {
      calls.push(['filesPut', `${siteId}/${name} ${String(bytes.byteLength)} ${sha256}`]);
      return { written: true };
    },
  };
  return { bridge, calls };
}

interface Fakes {
  db?: ReturnType<typeof fakeDb>;
  legacy?: ReturnType<typeof fakeLegacy>;
  owners?: ReturnType<typeof fakeOwners>;
  /** Active version the gateway reports; null before `v0001`. */
  tableVersion?: string | null;
}

function harness(fakes: Fakes = {}) {
  const db = fakes.db ?? fakeDb();
  const legacy = fakes.legacy ?? fakeLegacy();
  const owners = fakes.owners ?? fakeOwners();
  const bridge = fakeBridge();
  const noop = () => undefined;
  const logger = { level: 'info', fatal: noop, error: vi.fn(), warn: noop, info: noop, debug: noop, trace: noop, child: noop, isLevelEnabled: () => true, flush: noop };
  const gateway = { status: vi.fn(async () => ({ tableVersion: fakes.tableVersion === undefined ? 'v9001' : fakes.tableVersion, epoch: 1 })) };
  const ctx = {
    config,
    clock: { now: () => new Date(2026, 5, 30, 12, 0, 0) },
    logger,
    db: db.db,
    legacy: legacy.legacy,
    bridge: bridge.bridge,
    catalog: unitCatalog,
    owners: owners.owners,
    gateway,
  } as unknown as ProjectorContext;
  return { ctx, db, legacy, owners, bridge, gateway, logger };
}

const refuseGuard: StartupGuardRunner = { run: () => Promise.reject(new Error('the start-up guard must not run')) };

function cycleDeps(hooks: ProjectorHooks = {}, startupGuard: StartupGuardRunner = refuseGuard): CycleDeps {
  return { hooks, startupGuard, tracker: new OperationTracker() };
}

interface Images {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** A changelog row of `table` with its legacy projection for `unit`. */
function changeRow(
  position: [xid: number, seq: number],
  table: string,
  unit: string,
  op: ProjectedChangeRow['op'],
  images: Images,
  extra: Partial<ProjectedChangeRow> & { changed?: string[] } = {},
): ProjectedChangeRow {
  const spec = UNITS[unit];
  if (spec === undefined) throw new Error(`no columns for ${unit}`);
  const { changed = [], ...fields } = extra;
  return {
    xid: String(position[0]),
    seq: String(position[1]),
    table,
    op,
    key: 'k',
    before: null,
    after: null,
    columns: changed,
    origin: 'target',
    actorUserId: null,
    actorService: null,
    at: '2026-06-30 12:00:00.000',
    requestId: null,
    operationId: null,
    legacy: [
      {
        unit,
        legacyTable: spec.legacyTable,
        key: 'k',
        before: images.before === undefined ? null : encodeRow(spec.columns, images.before),
        after: images.after === undefined ? null : encodeRow(spec.columns, images.after),
        columns: changed,
      },
    ],
    ...fields,
  };
}

const person = (fname: string, extra: Partial<ProjectedChangeRow> = {}, position: [number, number] = [100, 1]) =>
  changeRow(
    position,
    'person',
    'people.person',
    'update',
    { before: { UserID: USER, SiteID: SITE, Fname: 'Ada' }, after: { UserID: USER, SiteID: SITE, Fname: fname } },
    { changed: ['Fname'], ...extra },
  );

const account = (userName: string, extra: Partial<ProjectedChangeRow> = {}, position: [number, number] = [102, 1]) =>
  changeRow(
    position,
    'user_account',
    'identity.user_account',
    'update',
    { before: { UserID: USER, UserName: 'ada', Type: '2', SiteID: SITE }, after: { UserID: USER, UserName: userName, Type: '2', SiteID: SITE } },
    { changed: ['UserName'], ...extra },
  );

const contentUpdate = () => {
  const before = { tcontent_ID: '7', SiteID: SITE, ContentID: 'C1', Title: 'Old' };
  return changeRow([300, 1], 'content', 'content.content', 'update', { before, after: { ...before, Title: 'New' } }, { changed: ['Title'] });
};

const TUSERS_UPDATE = /^UPDATE \[dbo\]\.\[tusers\]/;

describe('runProjectorCycle gating', () => {
  it('returns leader false without touching the gateway when another instance holds the lock', async () => {
    const h = harness({ db: fakeDb(false) });
    expect(await runProjectorCycle(h.ctx, cycleDeps())).toMatchObject({ leader: false, ran: false, batches: 0, errors: [] });
    expect(h.gateway.status).not.toHaveBeenCalled();
  });

  it('runs nothing while no unit is target-authoritative', async () => {
    const h = harness({ tableVersion: null });
    expect(await runProjectorCycle(h.ctx, cycleDeps())).toMatchObject({ leader: true, ran: false, batches: 0 });
    expect(h.legacy.statements).toEqual([]);
  });

  it('refuses to project while opt2_sync is missing', async () => {
    const h = harness({ legacy: fakeLegacy({ ready: false }) });
    await expect(runProjectorCycle(h.ctx, cycleDeps())).rejects.toBeInstanceOf(Opt2SyncUnavailableError);
  });
});

describe('runProjectorCycle streams', () => {
  it('advances the checkpoint past origin-skipped rows and the applied horizon of empty pages', async () => {
    const mail = { MLID: 'M1', Email: 'a@example.com', SiteID: SITE };
    const unit = 'communications.mailing_list_member';
    const pages = {
      [`communications|${CURSOR_START}`]: page(
        [
          changeRow([500, 1], 'mailing_list_member', unit, 'insert', { after: mail }, { origin: 'backfill' }),
          changeRow([501, 2], 'mailing_list_member', unit, 'insert', { after: mail }, { origin: 'legacy-window' }),
        ],
        '502',
        CURSOR_START,
      ),
    };
    const h = harness({ owners: fakeOwners({ pages, defaultHorizon: '777' }) });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ leader: true, ran: true, rowsApplied: 0, skipped: 2, batches: config.dataOwners.length, errors: [] });
    expect(h.legacy.checkpoint('communications')).toMatchObject({ cursor_xid: '501', cursor_seq: '2', applied_horizon: '502', rows_applied: 0 });
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '0', cursor_seq: '0', applied_horizon: '777' });
    expect(h.legacy.applied(/^(INSERT|DELETE|UPDATE \[)/)).toEqual([]);
    expect(h.db.mirror.get(`communications|${TENANT}`)).toEqual({ cursor: '501:2', horizon: '502' });
  });

  it.each([
    [
      'tsettings',
      changeRow([400, 1], 'site', 'programs_sites.site', 'update', { before: { SiteID: SITE, Site: 'A' }, after: { SiteID: SITE, Site: 'A2' } }, { changed: ['Site'] }),
      'programs-sites',
      [
        ['siteRefresh', SITE],
        ['purgeCache', SITE],
      ],
    ],
    ['tcontent', contentUpdate(), 'strategies-content', [['purgeCache', SITE]]],
    ['tusers', person('Grace'), 'people', []],
  ])('after a %s batch refreshes and purges as legacy readers need, and records a reverse watermark', async (legacyTable, row, owner, bridgeCalls) => {
    const h = harness({ owners: fakeOwners({ pages: { [`${owner}|${CURSOR_START}`]: page([row], '999', CURSOR_START) } }) });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ rowsApplied: 1, errors: [] });
    expect(h.legacy.applied(new RegExp(`^UPDATE \\[dbo\\]\\.\\[${legacyTable}\\]`))).toHaveLength(1);
    expect(h.bridge.calls).toEqual(bridgeCalls);
    expect(h.owners.watermarks).toEqual([{ owner, legacyTable, direction: 'reverse' }]);
  });

  it('merges the other owners parts for the key into a split-table insert', async () => {
    const insert = changeRow([110, 1], 'person', 'people.person', 'insert', { after: { UserID: USER, SiteID: SITE, Fname: 'Grace' } });
    const legacy = fakeLegacy({ zeroRows: TUSERS_UPDATE });
    const owners = fakeOwners({
      pages: { [`people|${CURSOR_START}`]: page([insert], '111', CURSOR_START) },
      exportRows: {
        'identity.user_account': [
          { UserID: USER, UserName: 'grace', Type: '2', SiteID: SITE },
          { UserID: 'OTHER', UserName: 'other', Type: '2', SiteID: SITE },
        ],
      },
    });
    const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());
    expect(result.errors).toEqual([]);
    const [inserted, ...others] = legacy.applied(/^INSERT INTO \[dbo\]\.\[tusers\]/);
    expect(others).toEqual([]);
    expect(inserted?.sql).toMatch(/\(\[UserID\], \[SiteID\], \[Fname\], \[UserName\], \[Type\]\)/);
    expect(Object.values(inserted?.params ?? {})).toEqual(expect.arrayContaining([USER, SITE, 'Grace', 'grace', '2']));
    expect(Object.values(inserted?.params ?? {})).not.toContain('other');
  });

  it('writes a file object through the bridge before the batch transaction and purges the content site', async () => {
    const fileId = 'F1E2D3C4-0000-0000-0000000000000001';
    const sha256 = createHash('sha256').update('hello').digest('hex');
    const after = encodeRow(FILE_OBJECT_COLUMNS, {
      tenant_id: TENANT,
      file_id: fileId,
      variant: '',
      ext: 'pdf',
      object_key: `${TENANT}/${fileId}.pdf`,
      size: '5',
      sha256,
      content_type: 'application/pdf',
      orphan: '0',
      created_at: '2026-06-30 12:00:00.000',
    });
    const row: ProjectedChangeRow = { ...contentUpdate(), xid: '120', table: 'file_object', op: 'insert', after, legacy: [] };
    const h = harness({ owners: fakeOwners({ pages: { [`strategies-content|${CURSOR_START}`]: page([row], '121', CURSOR_START) } }) });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ files: { put: 1, deleted: 0 }, rowsApplied: 0, errors: [] });
    expect(h.bridge.calls).toEqual([
      ['filesPut', `${SITE}/${fileId}.pdf 5 ${sha256}`],
      ['purgeCache', SITE],
    ]);
    expect(h.legacy.checkpoint('strategies-content')).toMatchObject({ cursor_xid: '120', cursor_seq: '1' });
  });

  it('stops a stream whose owner fails and projects the others', async () => {
    const h = harness();
    const { changes } = h.owners.owners;
    h.owners.owners.changes = async (owner, params) => (owner === 'people' ? Promise.reject(new Error('people down')) : changes(owner, params));
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result.errors.map((error) => [error.owner, error.tenantId, error.cursor, error.error.message])).toEqual([['people', TENANT, CURSOR_START, 'people down']]);
    expect(result.batches).toBe(config.dataOwners.length - 1);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('rejects the cycle when a hook throws', async () => {
    const lost = new Error('process lost');
    await expect(runProjectorCycle(harness().ctx, cycleDeps({ beforeBatch: () => Promise.reject(lost) }))).rejects.toBe(lost);
  });
});

describe('runProjectorCycle start-up guard', () => {
  const pages = { [`strategies-content|${CURSOR_START}`]: page([contentUpdate()], '301', CURSOR_START) };

  it('rolls a tcontent batch with matching rows back and commits it again through the guard', async () => {
    const legacy = fakeLegacy({ startupCounts: [2] });
    const h = harness({ legacy, owners: fakeOwners({ pages }) });
    const steps: string[] = [];
    const guard = {
      run: vi.fn(async (commit: () => Promise<void>) => {
        steps.push('freeze');
        await commit();
        steps.push('reload');
      }),
    };
    const result = await runProjectorCycle(h.ctx, cycleDeps({}, guard));
    expect(result.errors).toEqual([]);
    expect(steps).toEqual(['freeze', 'reload']);
    const writes = legacy.statements.filter((statement) => statement.sql.startsWith('UPDATE [dbo].[tcontent]'));
    expect(writes.map((statement) => legacy.log.find(([, tx]) => tx === statement.tx)?.[0])).toEqual(['rollback', 'commit']);
    expect(legacy.checkpoint('strategies-content')).toMatchObject({ cursor_xid: '300', cursor_seq: '1', applied_horizon: '301' });
  });

  it('commits directly when no row matches', async () => {
    const legacy = fakeLegacy({ startupCounts: [0] });
    const result = await runProjectorCycle(harness({ legacy, owners: fakeOwners({ pages }) }).ctx, cycleDeps());
    expect(result.errors).toEqual([]);
    expect(legacy.applied(/^UPDATE \[dbo\]\.\[tcontent\]/)).toHaveLength(1);
  });

  it('reports a guard failure after its commit, still mirroring and purging', async () => {
    const legacy = fakeLegacy({ startupCounts: [1] });
    const h = harness({ legacy, owners: fakeOwners({ pages }) });
    const frozen = new Error('legacy-bound entries stay frozen');
    const result = await runProjectorCycle(h.ctx, cycleDeps({}, { run: async (commit) => Promise.reject(await commit().then(() => frozen)) }));
    expect(result.errors.map((error) => [error.owner, error.error])).toEqual([['strategies-content', frozen]]);
    expect(legacy.checkpoint('strategies-content')).toMatchObject({ cursor_xid: '300' });
    expect(h.db.mirror.get(`strategies-content|${TENANT}`)).toMatchObject({ cursor: '300:1' });
    expect(h.bridge.calls).toEqual([['purgeCache', SITE]]);
  });

  it('commits nothing when the guard fails before its commit', async () => {
    const legacy = fakeLegacy({ startupCounts: [1] });
    const refused = new Error('freeze budget exceeded');
    const result = await runProjectorCycle(harness({ legacy, owners: fakeOwners({ pages }) }).ctx, cycleDeps({}, { run: () => Promise.reject(refused) }));
    expect(result.errors.map((error) => [error.owner, error.cursor, error.error])).toEqual([['strategies-content', CURSOR_START, refused]]);
    expect(legacy.checkpoint('strategies-content')).toBeUndefined();
    expect(legacy.applied(/^UPDATE \[dbo\]\.\[tcontent\]/)).toEqual([]);
  });
});

describe('runProjectorCycle roster operations', () => {
  it('holds a roster operation until done and applies people and identity rows with both checkpoints in one transaction', async () => {
    const pages = {
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
      [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP })], '103', CURSOR_START, { [OP]: 'done' }),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ held: 2, rowsApplied: 2, errors: [] });
    const updates = h.legacy.applied(TUSERS_UPDATE);
    expect(updates.map((statement) => statement.sql)).toEqual([expect.stringMatching(/SET \[Fname\] = @p0/), expect.stringMatching(/SET \[UserName\] = @p0/)]);
    const [joint] = new Set(updates.map((statement) => statement.tx));
    expect(updates.every((statement) => statement.tx === joint)).toBe(true);
    const checkpointed = h.legacy.statements.filter((statement) => statement.tx === joint && statement.sql.startsWith('UPDATE opt2_sync'));
    expect(checkpointed.map((statement) => statement.params.owner).sort()).toEqual(['identity', 'people']);
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '100', cursor_seq: '1' });
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1' });
    expect([...h.owners.positions].sort()).toEqual(['identity', 'people']);
  });

  it('applies nothing of an operation that stays open', async () => {
    const pages = {
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'open' }),
      [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP })], '103', CURSOR_START, { [OP]: 'open' }),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    expect(await runProjectorCycle(h.ctx, cycleDeps())).toMatchObject({ held: 2, rowsApplied: 0, errors: [] });
    expect(h.legacy.applied(TUSERS_UPDATE)).toEqual([]);
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '0', applied_horizon: '100' });
  });

  it('passes over a parked operation another stream reports rolled back, then resumes the stream', async () => {
    const pages = {
      [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP }, [100, 1])], '102', CURSOR_START, { [OP]: 'open' }),
      'identity|100:1': page([account('lin', {}, [105, 2])], '106', '100:1'),
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP }, [101, 1])], '102', CURSOR_START, { [OP]: 'rolled-back' }),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ held: 1, rowsApplied: 1, errors: [] });
    expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0)).toEqual(['lin']);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '105', cursor_seq: '2' });
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '101', cursor_seq: '1' });
  });

  it('re-runs a stream whose read-ahead reached a held row and then releases the operation', async () => {
    const pages: Record<string, PageSource> = {
      [`identity|${CURSOR_START}`]: (read) =>
        read === 1 ? page([], '101', CURSOR_START) : page([account('grace', { operationId: OP })], '200', CURSOR_START, { [OP]: 'done' }),
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result.errors).toEqual([]);
    const updates = h.legacy.applied(TUSERS_UPDATE);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.tx).toBe(updates[1]?.tx);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1' });
  });

  it.each<[string, OwnersOptions['failPosition'], LegacyOptions]>([
    ['a fence owner cannot report its position', 'identity', {}],
    ['the joint batch fails', undefined, { failOn: /SET \[UserName\]/ }],
  ])('keeps the operation unapplied when %s', async (_label, failPosition, legacyOptions) => {
    const pages = {
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
      [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP })], '103', CURSOR_START, { [OP]: 'done' }),
    };
    const legacy = fakeLegacy(legacyOptions);
    const result = await runProjectorCycle(harness({ legacy, owners: fakeOwners({ pages, failPosition }) }).ctx, cycleDeps());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(legacy.applied(TUSERS_UPDATE)).toEqual([]);
    expect(legacy.checkpoint('people')).toMatchObject({ cursor_xid: '0', applied_horizon: '100' });
  });
});

describe('crash between the SQL Server commit and the mirror', () => {
  it('rejects, then resumes from the SQL Server checkpoint without re-applying the batch, and the mirror catches up', async () => {
    const duplicate = { MLID: 'M1', Email: 'd@example.com', SiteID: SITE };
    const pages = {
      [`communications|${CURSOR_START}`]: page(
        [changeRow([600, 1], 'mailing_list_member', 'communications.mailing_list_member', 'delete', { before: duplicate })],
        '601',
        CURSOR_START,
      ),
    };
    const legacy = fakeLegacy();
    const db = fakeDb();
    const owners = fakeOwners({ pages, defaultHorizon: '601' });
    const crash = new Error('ProjectorCrashed');
    let crashed = false;
    const hooks: ProjectorHooks = {
      async afterLegacyCommit({ owner }) {
        if (owner !== 'communications' || crashed) return;
        crashed = true;
        throw crash;
      },
    };

    await expect(createProjectorLoop(harness({ legacy, db, owners }).ctx, { hooks, startupGuard: refuseGuard }).runOnce()).rejects.toBe(crash);
    expect(legacy.applied(/^DELETE TOP \(1\) FROM \[dbo\]\.\[tmailinglistmembers\]/)).toHaveLength(1);
    expect(legacy.checkpoint('communications')).toMatchObject({ cursor_xid: '600', cursor_seq: '1' });
    expect(db.mirror.has(`communications|${TENANT}`)).toBe(false);

    const restarted = createProjectorLoop(harness({ legacy, db, owners }).ctx, { hooks, startupGuard: refuseGuard });
    expect(await restarted.runOnce()).toMatchObject({ errors: [] });
    expect(legacy.applied(/^DELETE TOP \(1\)/)).toHaveLength(1);
    expect(owners.changes.filter((read) => read.owner === 'communications').map((read) => read.after)).toEqual([CURSOR_START, '600:1']);
    expect(db.mirror.get(`communications|${TENANT}`)).toEqual({ cursor: '600:1', horizon: '601' });
    expect(restarted.lastTenants()).toEqual([TENANT]);
  });
});

describe('createProjectorLoop', () => {
  it('joins the cycle in flight, runs at the projection cadence once started, and stops', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
      expect(loop.lastTenants()).toBeNull();
      const first = loop.runOnce();
      expect(loop.runOnce()).toBe(first);
      await first;
      expect(h.gateway.status).toHaveBeenCalledTimes(1);

      loop.start();
      loop.start();
      await vi.advanceTimersByTimeAsync(config.projection.idlePollMs * 3);
      expect(h.gateway.status).toHaveBeenCalledTimes(4);
      await loop.stop();
      await vi.advanceTimersByTimeAsync(config.projection.idlePollMs * 3);
      expect(h.gateway.status).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failed background cycle and keeps its schedule', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ legacy: fakeLegacy({ ready: false }) });
      const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
      loop.start();
      await vi.advanceTimersByTimeAsync(config.projection.idlePollMs * 2);
      await loop.stop();
      expect(h.logger.error).toHaveBeenCalledTimes(2);
      expect(h.logger.error).toHaveBeenCalledWith({ error: expect.any(Opt2SyncUnavailableError) }, 'Reverse projector cycle failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('liveTenantSites', () => {
  it('maps each live site id to its tenant, the first spelling winning, and drops blank ids', async () => {
    const { legacy } = fakeLegacy({ sites: ['b-site', 'Default  ', 'default', ''] });
    expect(await liveTenantSites(legacy as never)).toEqual(
      new Map([
        [tenantIdForSite('Default'), 'Default'],
        [tenantIdForSite('b-site'), 'b-site'],
      ]),
    );
  });
});
