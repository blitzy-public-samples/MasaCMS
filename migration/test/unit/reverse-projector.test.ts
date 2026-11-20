// Unit tests for the reverse projector cycle and loop over fakes of the legacy database, owners, bridge, gateway and migration pool.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { serializeError } from '@opt2/platform/logging';
import {
  CURSOR_START,
  encodeKey,
  encodeRow,
  type CanonicalColumn,
  type ChangesResponse,
  type OperationStatus,
  type ProjectedChangeRow,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { MemorySpanExporter, SpanKind, flushTracing, shutdownTracing, startTracing } from '@opt2/platform/tracing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { GatewayCallError } from '../../src/cutover/gateway-client.js';
import { currentAuthority } from '../../src/cutover/index.js';
import type { CatalogColumn, TableCatalog } from '../../src/extract/index.js';
import { createFaultRegistry } from '../../src/faults/registry.js';
import { BridgeError, Opt2SyncUnavailableError, STARTUP_COUNT_SQL } from '../../src/legacy/index.js';
import { OwnerCallError, loadUnitCatalog, type DataOwner } from '../../src/owners/index.js';
import type { LegacyEffect } from '../../src/reverse/apply-legacy.js';
import { ProjectionTimeoutError, createAwaiter } from '../../src/reverse/await.js';
import { createProjector } from '../../src/reverse/index.js';
import { HeldSpanChangedError, OperationTracker, ROSTER_PARTICIPANTS } from '../../src/reverse/operations.js';
import {
  PROJECTOR_LOCK_KEY,
  createProjectorLoop,
  liveTenantSites,
  runProjectorCycle,
  type CycleDeps,
  type CycleResult,
  type OperationChangePoint,
  type ProjectorContext,
  type ProjectorHooks,
  type StartupGuardRunner,
  type StreamMemory,
} from '../../src/reverse/projector.js';
import { createStartupGuardRunner, type GuardRunnerContext, type ReloadWindowResult } from '../../src/windows/reload.js';
import { createGatewayDouble } from '../helpers/gateway-double.js';

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
  pending_effects: string | null;
  ready_horizon: string | null;
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
  /** Clearing owed effects fails. */
  failClear?: boolean;
  /** A table whose rows the fake keeps; it answers the statements on that table and leaves the rest undefined. */
  table?: { query(text: string, params: Record<string, unknown>, inTransaction: boolean): { recordset: unknown[]; rowsAffected: number[] } | undefined };
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
    const pending = params.pendingEffects as string | null;
    const ready = pending === null || previous === undefined ? null : previous.pending_effects === null ? previous.applied_horizon : previous.ready_horizon;
    const horizonOnly =
      previous !== undefined && Number(params.rowsApplied) === 0 && previous.cursor_xid === String(params.cursorXid) && previous.cursor_seq === String(params.cursorSeq);
    const record: CheckpointRecord = {
      owner: String(params.owner),
      tenant_id: String(params.tenantId),
      cursor_xid: String(params.cursorXid),
      cursor_seq: String(params.cursorSeq),
      applied_horizon: previous !== undefined && BigInt(previous.applied_horizon) > BigInt(horizon) ? previous.applied_horizon : horizon,
      batch_id: horizonOnly ? previous.batch_id : String(params.batchId),
      rows_applied: horizonOnly ? previous.rows_applied : Number(params.rowsApplied),
      updated_at: null,
      pending_effects: pending,
      ready_horizon: ready,
    };
    staged.set(key, record);
    return reply([record]);
  };

  /** Clears a committed row's owed effects when the batch that stored them still owns it, as one autocommitted statement. */
  const clear = (params: Record<string, unknown>) => {
    const record = committed.get(`${String(params.owner)}|${String(params.tenantId)}`);
    if (record === undefined || record.batch_id !== params.batchId) return reply([], [0]);
    if (options.failClear === true) throw new Error('clear failed');
    committed.set(`${record.owner}|${record.tenant_id}`, { ...record, pending_effects: null, ready_horizon: null });
    return reply([], [1]);
  };

  const handle = (text: string, params: Record<string, unknown>, staged: Map<string, CheckpointRecord> | null) => {
    if (text.includes('sys.tables')) return reply([{ n: options.ready === false ? 0 : 1 }]);
    if (text.startsWith('UPDATE opt2_sync.projector_checkpoint SET pending_effects = NULL')) return clear(params);
    if (text.startsWith('SELECT DISTINCT SiteID')) return reply((options.sites ?? [SITE]).map((SiteID) => ({ SiteID })));
    if (text === STARTUP_COUNT_SQL) return reply([{ n: startupCounts.shift() ?? 0 }]);
    if (text.startsWith('SELECT owner, tenant_id')) {
      const owners = Object.entries(params)
        .filter(([name]) => /^o\d+$/.test(name))
        .map(([, value]) => value);
      return reply([...committed.values()].filter((row) => owners.includes(row.owner)));
    }
    const kept = options.table?.query(text, params, staged !== null);
    if (kept !== undefined) return reply(kept.recordset, kept.rowsAffected);
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
    /** Transactions begun so far, numbered from 1 in the order they began. */
    begun: () => nextTx - 1,
    checkpoint: (owner: string, tenantId = TENANT) => committed.get(`${owner}|${tenantId}`),
    /** Commits a checkpoint row as an earlier cycle left it. */
    seed: (record: CheckpointRecord) => committed.set(`${record.owner}|${record.tenant_id}`, record),
    /** Statements of committed transactions matching `pattern`. */
    applied: (pattern: RegExp) => statements.filter((statement) => isCommitted(statement.tx) && pattern.test(statement.sql)),
  };
}

/** Migration pool answering the advisory lock, the `projector_cursor` mirror upsert and reads of an empty `projector_quarantine`; `mirrorTx` numbers each mirror write's transaction. */
function fakeDb(leader = true, failMirror: (owner: string, tenantId: string) => boolean = () => false) {
  const mirror = new Map<string, { cursor: string; horizon: string }>();
  const mirrorTx: number[] = [];
  let transactions = 0;
  const db = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('the projector never acts for a tenant on the migration pool')),
    async withMetadata<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const id = ++transactions;
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
            if (failMirror(String(values[0]), String(values[1]))) throw new Error('mirror unavailable');
            mirror.set(`${String(values[0])}|${String(values[1])}`, { cursor: String(values[2]), horizon: String(values[3]) });
            mirrorTx.push(id);
            return { rows: [] };
          }
          // Reads of `projector_quarantine`, which holds no change in these suites.
          if (text.startsWith('SELECT ') && text.includes('FROM "migration"."projector_quarantine"')) return { rows: [] };
          throw new Error(`unexpected PostgreSQL SQL: ${text}`);
        },
      };
      return fn(tx as never);
    },
    end: async () => undefined,
  };
  return { db, mirror, mirrorTx };
}

function page(rows: ProjectedChangeRow[], horizon: string, after: string, operations: Record<string, OperationStatus> = {}, complete = true): ChangesResponse {
  const last = rows.at(-1);
  return { rows, cursor: last === undefined ? after : `${last.xid}:${last.seq}`, horizon, complete, operations };
}

/** A page, or one per read of the same cursor numbered from 1. */
type PageSource = ChangesResponse | ((read: number) => ChangesResponse);

interface OwnersOptions {
  /** Pages by `<owner>|<tenantId>|<after>`, else `<owner>|<after>`; other reads answer an empty complete page at `defaultHorizon`. */
  pages?: Record<string, PageSource>;
  defaultHorizon?: string;
  /** Legacy images each unit exports by `<unit>|<tenantId>`, else by unit. */
  exportRows?: Record<string, Record<string, unknown>[]>;
  /** Owner whose position read fails. */
  failPosition?: string;
  /** Legacy transactions begun so far, recorded with each export call. */
  transactions?: () => number;
}

interface ExportParams {
  unit: string;
  tenantId: string;
  keys?: readonly string[];
}

function fakeOwners({ pages = {}, defaultHorizon = '200', exportRows = {}, failPosition, transactions }: OwnersOptions = {}) {
  const reads = new Map<string, number>();
  const changes: { owner: string; after: string }[] = [];
  const positions: string[] = [];
  const watermarks: { owner: string; legacyTable: string; direction: string }[] = [];
  const exports: { owner: string; unit: string; keys?: readonly string[]; opened: number }[] = [];
  /** A unit's export page; with `keys`, only rows whose legacy key encoding is listed. */
  const exportPage = (params: ExportParams) => {
    const unit = UNITS[params.unit];
    const keyNames = unit === undefined ? [] : unitCatalog.keyColumnsOf(unit.legacyTable);
    const rows = (exportRows[`${params.unit}|${params.tenantId}`] ?? exportRows[params.unit] ?? [])
      .map((values) => {
        const row = encodeRow(unit?.columns ?? [], values);
        return { key: keyNames.length === 0 ? row : encodeKey(unit?.columns ?? [], keyNames, values), row, hash: 'h' };
      })
      .filter((row) => params.keys === undefined || params.keys.includes(row.key));
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
      const source = pages[`${owner}|${params.tenantId}|${params.after}`] ?? pages[key];
      if (source === undefined) return page([], defaultHorizon, params.after);
      return typeof source === 'function' ? source(read) : source;
    },
    export: async (_owner: string, params: ExportParams) => exportPage(params),
    async *exportPages(owner: string, params: ExportParams) {
      exports.push({ owner, unit: params.unit, keys: params.keys, opened: transactions?.() ?? 0 });
      yield exportPage(params);
    },
    async position(owner: string) {
      positions.push(owner);
      if (owner === failPosition) throw new Error(`${owner} position unavailable`);
      return { owner, position: '150', outbox: null, inbox: null };
    },
    getObject: async () => Readable.from([Buffer.from('hel'), Buffer.from('lo')]),
    getAttachmentObject: vi.fn((_params: { tenantId: string; attachmentId: string }) => Promise.resolve(Readable.from([Buffer.from('%PDF'), Buffer.from('-1')]))),
    getExportObject: vi.fn((_params: { tenantId: string; jobId: string }) => Promise.resolve(Readable.from([Buffer.from('job,'), Buffer.from('done\r\n')]))),
    async putWatermark(owner: string, record: { legacyTable: string; direction: string }) {
      watermarks.push({ owner, legacyTable: record.legacyTable, direction: record.direction });
      return record;
    },
  };
  return { owners, changes, positions, watermarks, exports };
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
    async filesPut(siteId: string, name: string, body: AsyncIterable<Uint8Array>, sha256: string) {
      let size = 0;
      for await (const chunk of body) size += chunk.byteLength;
      calls.push(['filesPut', `${siteId}/${name} ${String(size)} ${sha256}`]);
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
  /** `projection.streamPagesPerCycle` of the context; the committed value when unset. */
  streamPagesPerCycle?: number;
  /** `projection.batchRows` of the context; the committed value when unset. */
  batchRows?: number;
}

function harness(fakes: Fakes = {}) {
  const db = fakes.db ?? fakeDb();
  const legacy = fakes.legacy ?? fakeLegacy();
  const owners = fakes.owners ?? fakeOwners();
  const bridge = fakeBridge();
  const noop = () => undefined;
  const logger = { level: 'info', fatal: noop, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: noop, trace: noop, child: noop, isLevelEnabled: () => true, flush: noop };
  const gateway = { status: vi.fn(async () => ({ tableVersion: fakes.tableVersion === undefined ? 'v9001' : fakes.tableVersion, epoch: 1 })) };
  const streamPagesPerCycle = fakes.streamPagesPerCycle ?? config.projection.streamPagesPerCycle;
  const batchRows = fakes.batchRows ?? config.projection.batchRows;
  const ctx = {
    config: { ...config, projection: { ...config.projection, streamPagesPerCycle, batchRows } },
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
    // The communications batch, then one batch for each other owner's empty pages.
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

  it('applies the rows of one row in seq order, its commit order, keeping other rows at their positions', async () => {
    const rows = [person('Lin', {}, [100, 2]), person('Zed', { key: 'other' }, [100, 3]), person('Grace', {}, [101, 1])];
    const h = harness({ owners: fakeOwners({ pages: { [`people|${CURSOR_START}`]: page(rows, '102', CURSOR_START) } }) });
    expect(await runProjectorCycle(h.ctx, cycleDeps())).toMatchObject({ rowsApplied: 3, errors: [] });
    expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0)).toEqual(['Grace', 'Zed', 'Lin']);
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '101', cursor_seq: '1', applied_horizon: '102' });
  });

  /** The tusers targets other than people.person, in ownership-file order. */
  const otherTusersTargets = unitCatalog.unitsForLegacyTable('tusers').filter((target) => target.unit !== 'people.person');
  /** A tusers key as owners' export rows encode it. */
  const userKey = (id: string): string => encodeRow([{ name: 'UserID', type: 's' }], { UserID: id });

  it('merges the other owners parts of the key into a split-table insert, asking them for that key alone before the batch transaction', async () => {
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
      transactions: legacy.begun,
    });
    const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());
    expect(result.errors).toEqual([]);
    const [inserted, ...others] = legacy.applied(/^INSERT INTO \[dbo\]\.\[tusers\]/);
    expect(others).toEqual([]);
    expect(inserted?.sql).toMatch(/\(\[UserID\], \[SiteID\], \[Fname\], \[UserName\], \[Type\]\)/);
    expect(Object.values(inserted?.params ?? {})).toEqual(expect.arrayContaining([USER, SITE, 'Grace', 'grace', '2']));
    expect(Object.values(inserted?.params ?? {})).not.toContain('other');
    const parts = owners.exports.filter((call) => call.keys !== undefined);
    expect(parts.map((call) => ({ owner: call.owner, unit: call.unit, keys: call.keys }))).toEqual(
      otherTusersTargets.map((target) => ({ owner: target.owner, unit: target.unit, keys: [userKey(USER)] })),
    );
    // Other owners' idle batches may commit meanwhile; the insert's own transaction had not begun.
    expect(parts.every((call) => call.opened < (inserted?.tx ?? 0))).toBe(true);
    expect(owners.exports.filter((call) => call.keys === undefined).map((call) => call.unit)).toEqual(['people.person']);
  });

  it('asks the other owners for a batch of split-table inserts in chunks of 100 keys, all before the batch transaction', async () => {
    const ids = Array.from({ length: 101 }, (_, n) => `U${String(n).padStart(3, '0')}`);
    const rows = ids.map((id, n) => changeRow([110 + n, 1], 'person', 'people.person', 'insert', { after: { UserID: id, SiteID: SITE, Fname: `F${String(n)}` } }));
    const legacy = fakeLegacy({ zeroRows: TUSERS_UPDATE });
    const owners = fakeOwners({
      pages: { [`people|${CURSOR_START}`]: page(rows, '999', CURSOR_START) },
      exportRows: {
        'identity.user_account': [
          { UserID: ids[0], UserName: 'first', Type: '2', SiteID: SITE },
          { UserID: ids[100], UserName: 'last', Type: '2', SiteID: SITE },
        ],
      },
      transactions: legacy.begun,
    });
    const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());
    expect(result).toMatchObject({ rowsApplied: 101, errors: [] });
    const inserts = legacy.applied(/^INSERT INTO \[dbo\]\.\[tusers\]/);
    expect(inserts).toHaveLength(101);
    const [tx, ...otherTx] = new Set(inserts.map((statement) => statement.tx));
    expect(otherTx).toEqual([]);
    const merged = inserts.filter((statement) => /\[UserName\]/.test(statement.sql)).map((statement) => Object.values(statement.params));
    expect(merged).toEqual([expect.arrayContaining([ids[0], 'first']), expect.arrayContaining([ids[100], 'last'])]);
    const keys = ids.map(userKey);
    expect(owners.exports.filter((call) => call.keys !== undefined)).toEqual(
      otherTusersTargets.flatMap((target) =>
        [keys.slice(0, 100), keys.slice(100)].map((chunk) => ({ owner: target.owner, unit: target.unit, keys: chunk, opened: (tx ?? 0) - 1 })),
      ),
    );
  });

  it.each([
    ['a split-table delete', 'people', changeRow([120, 1], 'person', 'people.person', 'delete', { before: { UserID: USER, SiteID: SITE, Fname: 'Ada' } })],
    ['an update of a table that is not split', 'strategies-content', contentUpdate()],
  ])('asks no other owner for parts when the batch holds only %s', async (_label, owner, row) => {
    const owners = fakeOwners({ pages: { [`${owner}|${CURSOR_START}`]: page([row], '999', CURSOR_START) } });
    const result = await runProjectorCycle(harness({ owners }).ctx, cycleDeps());
    expect(result).toMatchObject({ rowsApplied: 1, errors: [] });
    expect(owners.exports.map((call) => [call.unit, call.keys])).toEqual([[row.legacy[0]?.unit, undefined]]);
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

  it("passes the cycle's signal to the file operations, which read no later state of a replaced object once it aborts", async () => {
    const fileId = 'F1E2D3C4-0000-0000-0000000000000002';
    const after = encodeRow(FILE_OBJECT_COLUMNS, {
      tenant_id: TENANT,
      file_id: fileId,
      variant: '',
      ext: 'pdf',
      object_key: `${TENANT}/${fileId}.pdf`,
      size: '5',
      sha256: createHash('sha256').update('older').digest('hex'),
      content_type: 'application/pdf',
      orphan: '0',
      created_at: '2026-06-30 12:00:00.000',
    });
    const row: ProjectedChangeRow = { ...contentUpdate(), xid: '120', table: 'file_object', op: 'insert', after, legacy: [] };
    const owners = fakeOwners({ pages: { [`strategies-content|${CURSOR_START}`]: page([row], '121', CURSOR_START) } });
    const stop = new AbortController();
    const serve = owners.owners.getObject;
    owners.owners.getObject = () => {
      stop.abort();
      return serve();
    };
    const h = harness({ owners });

    const result = await runProjectorCycle(h.ctx, { ...cycleDeps(), signal: stop.signal });

    expect(result).toMatchObject({ files: { put: 0, deleted: 0 }, errors: [] });
    expect(owners.changes).not.toContainEqual({ owner: 'strategies-content', after: '120:1' });
    expect(h.logger.info).toHaveBeenCalledWith(
      { tenantId: TENANT },
      `Skipped legacy file ${SITE}/cache/file/${fileId}.pdf from ${TENANT}/${fileId}.pdf: a later change of the key projects it`,
    );
  });

  catalogs['Program_1.finance_attachment'] = {
    ...table(
      'finance_attachment',
      [
        column('attachment_id', 'char'),
        column('record_id', 'char'),
        column('file_name', 'nvarchar'),
        column('content_type', 'nvarchar'),
        column('size_bytes', 'int', 'i'),
        column('sha256', 'char'),
        column('content', 'varbinary', 'b'),
        column('created', 'datetime', 't'),
        column('createdByID', 'char'),
      ],
      ['attachment_id'],
    ),
    schema: 'Program_1',
    qualified: 'Program_1.finance_attachment',
  };
  UNITS['finance.attachment'] = {
    legacyTable: 'Program_1.finance_attachment',
    columns: [
      { name: 'attachment_id', type: 's' },
      { name: 'record_id', type: 's' },
      { name: 'file_name', type: 's' },
      { name: 'content_type', type: 's' },
      { name: 'size_bytes', type: 'i' },
      { name: 'sha256', type: 's' },
      { name: 'created', type: 't' },
      { name: 'createdByID', type: 's' },
    ],
  };

  describe('finance attachment bytes', () => {
    const attachmentId = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
    const served = Buffer.from('%PDF-1');
    /** A target insert of program 1's attachment recording `recorded`, as finance's change feed projects it. */
    const attachmentInsert = (recorded: Buffer): ProjectedChangeRow => {
      const row = changeRow([130, 1], 'attachment', 'finance.attachment', 'insert', {
        after: {
          attachment_id: attachmentId,
          record_id: USER,
          file_name: 'scan.pdf',
          content_type: 'application/pdf',
          size_bytes: String(recorded.byteLength),
          sha256: createHash('sha256').update(recorded).digest('hex'),
          created: '2026-06-30 12:00:00.000',
          createdByID: USER,
        },
      });
      return { ...row, legacy: row.legacy.map((entry) => ({ ...entry, legacyProgramId: 1 })) };
    };
    const attachmentWrites = /^(INSERT INTO|UPDATE|DELETE FROM) \[Program_1\]\.\[finance_attachment\]/;

    it('binds the verified bytes into the INSERT, committed in the transaction of its checkpoint', async () => {
      const legacy = fakeLegacy({ zeroRows: /^UPDATE \[Program_1\]\.\[finance_attachment\]/ });
      const owners = fakeOwners({ pages: { [`finance|${CURSOR_START}`]: page([attachmentInsert(served)], '131', CURSOR_START) } });
      const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());

      expect(result).toMatchObject({ rowsApplied: 1, errors: [] });
      expect(owners.owners.getAttachmentObject).toHaveBeenCalledWith({ tenantId: TENANT, attachmentId });
      const [inserted, ...others] = legacy.applied(/^INSERT INTO \[Program_1\]\.\[finance_attachment\]/);
      expect(others).toEqual([]);
      expect(inserted?.sql).toMatch(/\[content\]/);
      const bytes = Object.values(inserted?.params ?? {}).filter((value) => Buffer.isBuffer(value));
      expect(bytes).toEqual([served]);
      const checkpoint = legacy.applied(/^UPDATE opt2_sync\.projector_checkpoint/).find((statement) => statement.params.owner === 'finance');
      expect(checkpoint?.tx).toBe(inserted?.tx);
      expect(legacy.checkpoint('finance')).toMatchObject({ cursor_xid: '130', cursor_seq: '1', applied_horizon: '131', rows_applied: 1 });
      expect(owners.watermarks).toEqual([{ owner: 'finance', legacyTable: 'Program_1.finance_attachment', direction: 'reverse' }]);
    });

    it('stops the stream with nothing written when finance serves bytes other than the change recorded', async () => {
      const legacy = fakeLegacy({ zeroRows: /^UPDATE \[Program_1\]\.\[finance_attachment\]/ });
      const owners = fakeOwners({ pages: { [`finance|${CURSOR_START}`]: page([attachmentInsert(Buffer.from('%PDF-2'))], '131', CURSOR_START) } });
      const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());

      expect(result.errors.map((error) => [error.owner, error.cursor, error.error.name])).toEqual([['finance', CURSOR_START, 'AttachmentContentMismatchError']]);
      expect(legacy.statements.filter((statement) => attachmentWrites.test(statement.sql))).toEqual([]);
      expect(legacy.checkpoint('finance')).toBeUndefined();
      expect(owners.watermarks).toEqual([]);
    });
  });

  catalogs['synthetic.export_job'] = {
    ...table(
      'export_job',
      [
        column('job_id', 'char'),
        column('siteID', 'nvarchar'),
        column('state', 'varchar'),
        column('finished_at', 'datetime', 't'),
        column('file_name', 'nvarchar'),
        column('content_type', 'varchar'),
        column('output', 'varbinary', 'b'),
        column('output_sha256', 'char'),
      ],
      ['job_id'],
    ),
    schema: 'synthetic',
    qualified: 'synthetic.export_job',
  };
  UNITS['reporting.export_job'] = {
    legacyTable: 'synthetic.export_job',
    columns: [
      { name: 'job_id', type: 's' },
      { name: 'siteID', type: 's' },
      { name: 'state', type: 's' },
      { name: 'finished_at', type: 't' },
      { name: 'file_name', type: 's' },
      { name: 'content_type', type: 's' },
      { name: 'output_sha256', type: 's' },
    ],
  };

  describe('reporting export output bytes', () => {
    const jobId = 'D1E2F3A4-0001-4B5C-8D7E9F0A1B2C3D4E';
    const served = Buffer.from('job,done\r\n');
    const running = { job_id: jobId, siteID: SITE, state: 'running', finished_at: null, file_name: null, content_type: null, output_sha256: null };
    /** The target's done move of the job recording `recorded`, as reporting's change feed projects it. */
    const doneUpdate = (recorded: Buffer): ProjectedChangeRow =>
      changeRow(
        [140, 1],
        'export_job',
        'reporting.export_job',
        'update',
        {
          before: running,
          after: {
            ...running,
            state: 'done',
            finished_at: '2026-06-30 12:00:00.000',
            file_name: `export-${jobId}.csv`,
            content_type: 'text/csv',
            output_sha256: createHash('sha256').update(recorded).digest('hex'),
          },
        },
        { changed: ['state', 'finished_at', 'file_name', 'content_type', 'output_sha256'] },
      );

    it('binds the verified output into the done UPDATE, committed in the transaction of its checkpoint', async () => {
      const legacy = fakeLegacy();
      const owners = fakeOwners({ pages: { [`reporting|${CURSOR_START}`]: page([doneUpdate(served)], '141', CURSOR_START) } });
      const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());

      expect(result).toMatchObject({ rowsApplied: 1, errors: [] });
      expect(owners.owners.getExportObject).toHaveBeenCalledWith({ tenantId: TENANT, jobId });
      const [updated, ...others] = legacy.applied(/^UPDATE \[synthetic\]\.\[export_job\]/);
      expect(others).toEqual([]);
      expect(updated?.sql).toMatch(/\[output\] = /);
      expect(Object.values(updated?.params ?? {}).filter((value) => Buffer.isBuffer(value))).toEqual([served]);
      const checkpoint = legacy.applied(/^UPDATE opt2_sync\.projector_checkpoint/).find((statement) => statement.params.owner === 'reporting');
      expect(checkpoint?.tx).toBe(updated?.tx);
      expect(legacy.checkpoint('reporting')).toMatchObject({ cursor_xid: '140', cursor_seq: '1', applied_horizon: '141', rows_applied: 1 });
    });

    it('stops the stream with nothing written when reporting serves other output than the change recorded', async () => {
      const legacy = fakeLegacy();
      const owners = fakeOwners({ pages: { [`reporting|${CURSOR_START}`]: page([doneUpdate(Buffer.from('job,other\r\n'))], '141', CURSOR_START) } });
      const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());

      expect(result.errors.map((error) => [error.owner, error.cursor, error.error.name])).toEqual([['reporting', CURSOR_START, 'AttachmentContentMismatchError']]);
      expect(legacy.statements.filter((statement) => /^(INSERT INTO|UPDATE|DELETE FROM) \[synthetic\]\.\[export_job\]/.test(statement.sql))).toEqual([]);
      expect(legacy.checkpoint('reporting')).toBeUndefined();
    });
  });

  it('stops a stream whose owner fails and projects the others', async () => {
    const h = harness();
    const { changes } = h.owners.owners;
    h.owners.owners.changes = async (owner, params) => (owner === 'people' ? Promise.reject(new Error('people down')) : changes(owner, params));
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result.errors.map((error) => [error.owner, error.tenantId, error.cursor, error.error.message])).toEqual([['people', TENANT, CURSOR_START, 'people down']]);
    expect(result.batches).toBe(config.dataOwners.length - 1);
    expect(h.legacy.checkpoint('people')).toBeUndefined();
    expect(h.legacy.committed.size).toBe(config.dataOwners.length - 1);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it.each(['beforeFirstRead', 'beforeFirstBatch'] as const)('rejects the cycle when %s throws', async (hook) => {
    const lost = new Error('process lost');
    await expect(runProjectorCycle(harness().ctx, cycleDeps({ [hook]: () => Promise.reject(lost) }))).rejects.toBe(lost);
  });

  it('runs beforeFirstBatch once per cycle, before the first batch transaction, however many batches commit', async () => {
    const pages = { [`people|${CURSOR_START}`]: page([person('Grace')], '101', CURSOR_START), [`identity|${CURSOR_START}`]: page([account('grace')], '103', CURSOR_START) };
    const h = harness({ owners: fakeOwners({ pages }) });
    const opened: number[] = [];
    const beforeFirstBatch = vi.fn(() => {
      opened.push(h.legacy.begun());
      return Promise.resolve();
    });

    const result = await runProjectorCycle(h.ctx, cycleDeps({ beforeFirstBatch }));

    // The identity and people batches, then each other owner's idle advance.
    expect(result).toMatchObject({ batches: config.dataOwners.length, rowsApplied: 2, errors: [] });
    expect(opened).toEqual([0]);
    await runProjectorCycle(h.ctx, cycleDeps({ beforeFirstBatch }));
    expect(beforeFirstBatch).toHaveBeenCalledTimes(2);
  });

  it('runs beforeFirstRead once per cycle before any tenant, checkpoint or page read, and projects a change committed during it in that cycle', async () => {
    const pages: Record<string, ChangesResponse> = {};
    const h = harness({ owners: fakeOwners({ pages }) });
    const seen: { sql: string[]; pageReads: number }[] = [];
    const beforeFirstRead = vi.fn(() => {
      seen.push({ sql: h.legacy.statements.map((statement) => statement.sql), pageReads: h.owners.changes.length });
      pages[`people|${CURSOR_START}`] = page([person('Grace')], '101', CURSOR_START);
      return Promise.resolve();
    });

    const result = await runProjectorCycle(h.ctx, cycleDeps({ beforeFirstRead }));

    expect(seen).toEqual([{ sql: [expect.stringContaining('sys.tables')], pageReads: 0 }]);
    expect(result).toMatchObject({ ran: true, rowsApplied: 1, errors: [] });
    expect(h.legacy.checkpoint('people')).toMatchObject({ applied_horizon: '101', rows_applied: 1 });
    await runProjectorCycle(h.ctx, cycleDeps({ beforeFirstRead }));
    expect(beforeFirstRead).toHaveBeenCalledTimes(2);
  });
});

catalogs.toauthclients = table('toauthclients', [column('clientid', 'char'), column('siteid', 'nvarchar'), column('name', 'nvarchar')], ['clientid']);
UNITS['identity.oauth_client'] = {
  legacyTable: 'toauthclients',
  columns: [{ name: 'clientid', type: 's' }, { name: 'siteid', type: 's' }, { name: 'name', type: 's' }],
};

/** One dbo table's rows answering the statements the projector issues on it, compared as the default collation compares; writes apply at once, so no test using it rolls back. */
function statefulTable(name: string, initial: Record<string, unknown>[]) {
  const rows = initial.map((row) => ({ ...row }));
  const same = (a: unknown, b: unknown) => String(a).replace(/ +$/, '').toLowerCase() === String(b).replace(/ +$/, '').toLowerCase();
  const valueOf = (expr: string, params: Record<string, unknown>) => (expr === 'NULL' ? null : params[expr.slice(1)]);
  const pairs = (list: string, separator: string, params: Record<string, unknown>) =>
    list.split(separator).map((pair): [string, unknown] => {
      const [, column = '', expr = ''] = /^\[(\w+)\] = (@p\d+|NULL)$/.exec(pair.trim()) ?? [];
      return [column, valueOf(expr, params)];
    });
  const where = (text: string, params: Record<string, unknown>) => {
    const conditions = pairs(text, ' AND ', params);
    return rows.filter((row) => conditions.every(([column, value]) => same(row[column], value)));
  };
  const query = (text: string, params: Record<string, unknown>, inTransaction: boolean) => {
    if (!text.includes(`[dbo].[${name}]`)) return undefined;
    const read = /^SELECT (?:\[(\w+)\] AS site|(COUNT)\(\*\) AS n) FROM \S+ WHERE (.+)$/.exec(text);
    if (read !== null) {
      const found = where(read[3] ?? '', params);
      return { recordset: read[2] === undefined ? found.map((row) => ({ site: row[read[1] ?? ''] })) : [{ n: found.length }], rowsAffected: [] };
    }
    if (!inTransaction) throw new Error(`write outside a transaction: ${text}`);
    const update = /^UPDATE \S+ SET (.+) WHERE (.+)$/.exec(text);
    const insert = /^INSERT INTO \S+ \((.+)\) VALUES \((.+)\);$/.exec(text);
    const remove = /^DELETE FROM \S+ WHERE (.+)$/.exec(text);
    if (update !== null) {
      const found = where(update[2] ?? '', params);
      for (const row of found) Object.assign(row, Object.fromEntries(pairs(update[1] ?? '', ', ', params)));
      return { recordset: [], rowsAffected: [found.length] };
    }
    if (insert !== null) {
      const values = (insert[2] ?? '').split(', ');
      rows.push(Object.fromEntries((insert[1] ?? '').split(', ').map((column, index) => [column.slice(1, -1), valueOf(values[index] ?? '', params)])));
      return { recordset: [], rowsAffected: [1] };
    }
    if (remove !== null) {
      const found = where(remove[1] ?? '', params);
      for (const row of found) rows.splice(rows.indexOf(row), 1);
      return { recordset: [], rowsAffected: [found.length] };
    }
    throw new Error(`unexpected ${name} SQL: ${text}`);
  };
  return { rows, query };
}

describe('runProjectorCycle keys moving between tenants', () => {
  const OTHER_SITE = 'tenant-b';
  const tenantOf = (site: string) => tenantIdForSite(site);
  const CLIENT = 'C1D2E3F4-0000-0000-0000000000000001';
  const client = (siteid: string, name = 'Portal') => ({ clientid: CLIENT, siteid, name });
  const clientRow = (position: [number, number], op: ProjectedChangeRow['op'], images: Images, changed: string[] = []) =>
    changeRow(position, 'oauth_client', 'identity.oauth_client', op, images, { changed });
  /** Streams of each site's tenant from the start, at one horizon past their last row. */
  const streams = (bySite: Record<string, ProjectedChangeRow[]>) =>
    Object.fromEntries(
      Object.entries(bySite).map(([site, rows]) => [`identity|${tenantOf(site)}|${CURSOR_START}`, page(rows, String(Number(rows.at(-1)?.xid ?? 0) + 1), CURSOR_START)]),
    );

  async function project(initial: Record<string, unknown>[], bySite: Record<string, ProjectedChangeRow[]>, holders: Record<string, Record<string, unknown>[]>) {
    const clients = statefulTable('toauthclients', initial);
    const legacy = fakeLegacy({ sites: [SITE, OTHER_SITE], table: clients });
    const exportRows = Object.fromEntries(Object.entries(holders).map(([site, rows]) => [`identity.oauth_client|${tenantOf(site)}`, rows]));
    const owners = fakeOwners({ pages: streams(bySite), exportRows });
    const result = await runProjectorCycle(harness({ legacy, owners }).ctx, cycleDeps());
    return { result, rows: clients.rows, legacy, owners };
  }

  it.each([
    { order: 'the destination stream first', from: OTHER_SITE, to: SITE },
    { order: 'the source stream first', from: SITE, to: OTHER_SITE },
  ])('leaves one row at the destination site after a move projected with $order', async ({ from, to }) => {
    const { result, rows, legacy } = await project(
      [client(from)],
      { [to]: [clientRow([600, 1], 'insert', { after: client(to) })], [from]: [clientRow([601, 1], 'delete', { before: client(from) })] },
      { [to]: [client(to)] },
    );

    expect(result).toMatchObject({ rowsApplied: 2, errors: [] });
    expect(rows).toEqual([client(to)]);
    expect(legacy.applied(/^DELETE FROM \[dbo\]\.\[toauthclients\]/).map((statement) => Object.values(statement.params))).toEqual([[CLIENT, from]]);
    expect(legacy.checkpoint('identity', tenantOf(to))).toMatchObject({ cursor_xid: '600' });
    expect(legacy.checkpoint('identity', tenantOf(from))).toMatchObject({ cursor_xid: '601' });
  });

  it('passes over a source-tenant update made before the move', async () => {
    const { result, rows } = await project(
      [client(OTHER_SITE, 'Old')],
      {
        [SITE]: [clientRow([602, 1], 'insert', { after: client(SITE, 'New') })],
        [OTHER_SITE]: [
          clientRow([600, 1], 'update', { before: client(OTHER_SITE, 'Old'), after: client(OTHER_SITE, 'Mid') }, ['name']),
          clientRow([603, 1], 'delete', { before: client(OTHER_SITE, 'Mid') }),
        ],
      },
      { [SITE]: [client(SITE, 'New')] },
    );

    expect(result).toMatchObject({ rowsApplied: 3, errors: [] });
    expect(rows).toEqual([client(SITE, 'New')]);
  });

  it('writes nothing for the insert of a move its tenant has since moved back, deciding outside the batch transaction', async () => {
    const { result, rows, legacy, owners } = await project(
      [client(SITE)],
      {
        [SITE]: [clientRow([601, 1], 'delete', { before: client(SITE) }), clientRow([602, 1], 'insert', { after: client(SITE) })],
        [OTHER_SITE]: [clientRow([600, 1], 'insert', { after: client(OTHER_SITE) }), clientRow([603, 1], 'delete', { before: client(OTHER_SITE) })],
      },
      { [SITE]: [client(SITE)] },
    );

    expect(result).toMatchObject({ rowsApplied: 4, errors: [] });
    expect(rows).toEqual([client(SITE)]);
    expect(legacy.statements.filter((statement) => statement.sql.startsWith('SELECT [siteid] AS site')).map((statement) => statement.tx)).toEqual([null, null]);
    const clientKey = encodeRow([{ name: 'clientid', type: 's' }], { clientid: CLIENT });
    expect(owners.exports.filter((call) => call.keys !== undefined)).toEqual([{ owner: 'identity', unit: 'identity.oauth_client', keys: [clientKey], opened: 0 }]);
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

  it('lets the guard reload await content positions only a later cycle projects, then lifts the freeze without a projection timeout', async () => {
    const guardVersion = 'v9002';
    const frozenRoute = 'admin:carch.list';
    writeFileSync(
      path.join(cutoverDir, 'versions', `${guardVersion}.json`),
      JSON.stringify({
        tableVersion: guardVersion,
        groupAuthority: Object.fromEntries(groupIds.map((id) => [id, 'target'])),
        entries: [
          { route: frozenRoute, owningService: 'strategies-content', tableVersion: guardVersion, state: 'legacy', kind: 'read', group: null, units: ['content.content'], disposition: 'legacy-served' },
        ],
      }),
    );
    const legacy = fakeLegacy({ startupCounts: [2] });
    // The guarded batch's horizon is 301; the page after it, read only by a later cycle, reaches 401.
    const owners = fakeOwners({ pages: { ...pages, 'strategies-content|300:1': page([], '401', '300:1') } });
    // A content write committed after the guarded batch, read as the owner's current position.
    owners.owners.position = (owner: string) => Promise.resolve({ owner, position: '400', outbox: null, inbox: null });
    const h = harness({ legacy, owners });
    const ctx = { ...h.ctx, clock: { now: () => new Date() } } as unknown as MigrationContext;
    const gateway = createGatewayDouble({ active: guardVersion, epoch: 1 });
    const logger = { ...h.logger, warn: vi.fn() };
    const events: string[] = [];
    // A reload window's open: the content gates close while the freeze holds, then the owner's current position is awaited.
    const reload = async (): Promise<ReloadWindowResult> => {
      events.push(`open frozen=${[...gateway.frozen].join(',')}`);
      await projector.awaitProjection({ owners: ['strategies-content'], timeoutMs: config.windows.openBudgetMs });
      events.push('projection awaited');
      return { windowId: 'W1', legacyStatus: 200, windowState: 'closed', startupRowsRemaining: 0 };
    };
    const runner = createStartupGuardRunner({ gateway, config, legacy: legacy.legacy, logger } as unknown as GuardRunnerContext, reload);
    const projector = createProjector(ctx, { startupGuard: runner });

    projector.start();
    try {
      await vi.waitFor(() => expect(events).not.toEqual([]), { timeout: 10_000 });
      await runner.settled();
    } finally {
      await projector.stop();
    }

    expect(events).toEqual([`open frozen=${frozenRoute}`, 'projection awaited']);
    expect(gateway.calls.filter((call) => call.op === 'freeze' || call.op === 'unfreeze')).toEqual([
      { op: 'freeze', args: { routes: [frozenRoute] } },
      { op: 'unfreeze', args: { routes: [frozenRoute] } },
    ]);
    expect(gateway.frozen.size).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(legacy.checkpoint('strategies-content')).toMatchObject({ cursor_xid: '300', cursor_seq: '1', applied_horizon: '401' });
  });
});

describe('runProjectorCycle roster operations', () => {
  /** `owners` whose people feed answers an event-loop turn later, once identity's lane has read and parked its stream. */
  function peopleAnswersLater(owners: ReturnType<typeof fakeOwners>): ReturnType<typeof fakeOwners> {
    const changes = owners.owners.changes.bind(owners.owners);
    owners.owners.changes = async (owner, params) => {
      if (owner === 'people') await new Promise((resolve) => setImmediate(resolve));
      return changes(owner, params);
    };
    return owners;
  }

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
    const participants = h.legacy.applied(/^UPDATE opt2_sync/).filter((statement) => ['identity', 'people'].includes(String(statement.params.owner)));
    expect(participants.map((statement) => statement.tx)).toEqual([joint, joint]);
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
    const h = harness({ owners: peopleAnswersLater(fakeOwners({ pages })), streamPagesPerCycle: 2 });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ held: 1, rowsApplied: 1, errors: [] });
    expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0)).toEqual(['lin']);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '105', cursor_seq: '2' });
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '101', cursor_seq: '1' });
  });

  it('keeps a row whose same-row predecessor follows a rolled-back run unapplied until the re-run applies both in seq order', async () => {
    const pages = {
      [`identity|${CURSOR_START}`]: page(
        [account('lin', {}, [100, 5]), account('op', { operationId: OP, key: 'held' }, [101, 2]), account('grace', {}, [102, 4])],
        '103',
        CURSOR_START,
        { [OP]: 'open' },
      ),
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP }, [101, 1])], '102', CURSOR_START, { [OP]: 'rolled-back' }),
    };
    const h = harness({ owners: peopleAnswersLater(fakeOwners({ pages })), streamPagesPerCycle: 2 });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ held: 1, rowsApplied: 2, skipped: 2, errors: [] });
    expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0)).toEqual(['grace', 'lin']);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '4', applied_horizon: '103' });
  });

  it('counts as skipped only the rolled-back parts checkpointed past their stream, leaving the rest to the re-run', async () => {
    const pages: Record<string, PageSource> = {
      [`identity|${CURSOR_START}`]: page(
        [account('lin', {}, [100, 5]), account('op', { operationId: OP, key: 'held' }, [101, 2]), account('grace', {}, [102, 4])],
        '103',
        CURSOR_START,
        { [OP]: 'open' },
      ),
      // People's turn reports no status of the operation; its status read finds it rolled back.
      [`people|${CURSOR_START}`]: (read) => page([person('Grace', { operationId: OP }, [101, 1])], '102', CURSOR_START, read === 1 ? {} : { [OP]: 'rolled-back' }),
    };
    const h = harness({ owners: fakeOwners({ pages }), streamPagesPerCycle: 2 });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ held: 2, rowsApplied: 2, skipped: 2, errors: [] });
    expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0)).toEqual(['grace', 'lin']);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '4', applied_horizon: '103' });
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '101', cursor_seq: '1' });
  });

  it('leaves a rolled-back operation parked while one of its streams has stopped, counting and committing none of it', async () => {
    const pages: Record<string, PageSource> = {
      [`identity|${CURSOR_START}`]: (read) => page([account('grace', { operationId: OP }, [100, 1])], '102', CURSOR_START, read === 1 ? {} : { [OP]: 'rolled-back' }),
      [`people|${CURSOR_START}`]: (read) => {
        if (read > 1) throw new Error('people down');
        return page([person('Grace', { operationId: OP }, [101, 1])], '102', CURSOR_START);
      },
    };
    const h = harness({ owners: fakeOwners({ pages }), streamPagesPerCycle: 2 });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result).toMatchObject({ held: 2, rowsApplied: 0, skipped: 0 });
    expect(result.errors.map((error) => [error.owner, error.cursor, error.error.message])).toEqual([['people', CURSOR_START, 'people down']]);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '0', cursor_seq: '0', applied_horizon: '100' });
  });

  it('re-runs a stream whose read-ahead reached a held row and then releases the operation', async () => {
    const pages: Record<string, PageSource> = {
      [`identity|${CURSOR_START}`]: (read) =>
        read === 1 ? page([], '101', CURSOR_START) : page([account('grace', { operationId: OP })], '200', CURSOR_START, { [OP]: 'done' }),
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
    };
    const h = harness({ owners: fakeOwners({ pages }), streamPagesPerCycle: 2 });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result.errors).toEqual([]);
    const updates = h.legacy.applied(TUSERS_UPDATE);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.tx).toBe(updates[1]?.tx);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1' });
    // The first read's empty page commits its idle advance in identity's lane; the parked page commits nothing of its own.
    const identityUpserts = h.legacy.applied(/^UPDATE opt2_sync/).filter((statement) => statement.params.owner === 'identity');
    expect(identityUpserts.map((statement) => [statement.tx === updates[0]?.tx, statement.params.appliedHorizon])).toEqual([
      [false, '101'],
      [true, '200'],
    ]);
  });

  it.each<[string, OwnersOptions['failPosition'], LegacyOptions, Partial<CheckpointRecord> | undefined]>([
    // People's parked horizon rides the idle batch; a failed joint batch stops both participants, which commit nothing.
    ['a fence owner cannot report its position', 'identity', {}, { cursor_xid: '0', applied_horizon: '100' }],
    ['the joint batch fails', undefined, { failOn: /SET \[UserName\]/ }, undefined],
  ])('keeps the operation unapplied when %s', async (_label, failPosition, legacyOptions, peopleCheckpoint) => {
    const pages = {
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
      [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP })], '103', CURSOR_START, { [OP]: 'done' }),
    };
    const legacy = fakeLegacy(legacyOptions);
    const result = await runProjectorCycle(harness({ legacy, owners: fakeOwners({ pages, failPosition }) }).ctx, cycleDeps());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(legacy.applied(TUSERS_UPDATE)).toEqual([]);
    expect(legacy.checkpoint('people')).toEqual(peopleCheckpoint === undefined ? undefined : expect.objectContaining(peopleCheckpoint));
  });

  describe('beforeOperationChange', () => {
    /** People's person update at 100:1 and identity's account update at 102:1 of the done operation. */
    const donePages = () => ({
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
      [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP })], '103', CURSOR_START, { [OP]: 'done' }),
    });
    /** Statements transaction `tx` issued so far: its tusers update values and its checkpoint upserts. */
    const issuedIn = (legacy: ReturnType<typeof fakeLegacy>, tx: number) => {
      const own = legacy.statements.filter((statement) => statement.tx === tx);
      return {
        tusers: own.filter((statement) => TUSERS_UPDATE.test(statement.sql)).map((statement) => statement.params.p0),
        checkpoints: own.filter((statement) => statement.sql.startsWith('UPDATE opt2_sync')).length,
        ended: legacy.log.filter(([, id]) => id === tx),
      };
    };

    it('runs inside the open joint transaction before each operation change, with the owners already written', async () => {
      const h = harness({ owners: fakeOwners({ pages: donePages() }) });
      const calls: (OperationChangePoint & { tx: number; issued: ReturnType<typeof issuedIn> })[] = [];
      const hooks: ProjectorHooks = {
        beforeOperationChange: async (info) => {
          const tx = h.legacy.begun();
          calls.push({ ...info, written: [...info.written], tx, issued: issuedIn(h.legacy, tx) });
        },
      };
      expect(await runProjectorCycle(h.ctx, cycleDeps(hooks))).toMatchObject({ rowsApplied: 2, errors: [] });
      const [joint] = h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.tx);
      const batchId = calls[0]?.batchId;
      expect(batchId).toEqual(expect.any(String));
      expect(calls).toEqual([
        { batchId, operationId: OP, owner: 'people', written: [], tx: joint, issued: { tusers: [], checkpoints: 0, ended: [] } },
        { batchId, operationId: OP, owner: 'identity', written: ['people'], tx: joint, issued: { tusers: ['Grace'], checkpoints: 0, ended: [] } },
      ]);
      expect(issuedIn(h.legacy, joint ?? 0)).toEqual({ tusers: ['Grace', 'grace'], checkpoints: 2, ended: [['commit', joint]] });
    });

    it.each<[string, (info: OperationChangePoint) => boolean, unknown[]]>([
      ["before the first participant's change", (info) => info.written.length === 0, []],
      ['between the participants', (info) => info.written.length > 0 && !info.written.includes(info.owner), ['Grace']],
    ])('rolls back both participants and both checkpoints when it throws %s; the next cycle commits both in one transaction', async (_label, at, issuedBeforeThrow) => {
      const legacy = fakeLegacy();
      const owners = fakeOwners({ pages: donePages() });
      const fault = new Error('held operation failed');
      let failing = true;
      const hooks: ProjectorHooks = {
        beforeOperationChange: async (info) => {
          if (failing && at(info)) throw fault;
        },
      };
      const loop = createProjectorLoop(harness({ legacy, owners }).ctx, { hooks, startupGuard: refuseGuard });

      await expect(loop.runOnce()).rejects.toBe(fault);
      const rolledBack = legacy.log.filter(([kind]) => kind === 'rollback').map(([, id]) => id);
      expect(rolledBack).toHaveLength(1);
      expect(issuedIn(legacy, rolledBack[0] ?? 0)).toEqual({ tusers: issuedBeforeThrow, checkpoints: 0, ended: [['rollback', rolledBack[0]]] });
      expect(legacy.applied(TUSERS_UPDATE)).toEqual([]);
      for (const owner of ['people', 'identity']) expect(legacy.checkpoint(owner), owner).toBeUndefined();

      failing = false;
      expect(await loop.runOnce()).toMatchObject({ rowsApplied: 2, errors: [] });
      const [joint, ...others] = new Set(legacy.applied(TUSERS_UPDATE).map((statement) => statement.tx));
      expect(others).toEqual([]);
      expect(issuedIn(legacy, joint ?? 0)).toEqual({ tusers: ['Grace', 'grace'], checkpoints: 2, ended: [['commit', joint]] });
      expect(legacy.checkpoint('people')).toMatchObject({ cursor_xid: '100', cursor_seq: '1' });
      expect(legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1' });
    });

    it('holds the joint transaction open while it waits between the participants, then commits both in that transaction', async () => {
      const h = harness({ owners: fakeOwners({ pages: donePages() }) });
      let reached: (tx: number) => void = () => undefined;
      const holding = new Promise<number>((resolve) => {
        reached = resolve;
      });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hooks: ProjectorHooks = {
        beforeOperationChange: async ({ owner }) => {
          if (owner !== 'identity') return;
          reached(h.legacy.begun());
          await released;
        },
      };
      const cycle = runProjectorCycle(h.ctx, cycleDeps(hooks));
      const tx = await holding;
      expect(issuedIn(h.legacy, tx)).toEqual({ tusers: ['Grace'], checkpoints: 0, ended: [] });
      expect(h.legacy.applied(TUSERS_UPDATE)).toEqual([]);
      expect(h.legacy.checkpoint('identity')).toBeUndefined();

      release();
      expect(await cycle).toMatchObject({ rowsApplied: 2, errors: [] });
      expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => [statement.tx, statement.params.p0])).toEqual([
        [tx, 'Grace'],
        [tx, 'grace'],
      ]);
      expect(issuedIn(h.legacy, tx)).toMatchObject({ checkpoints: 2, ended: [['commit', tx]] });
      expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1' });
    });
  });
});

/** Identity account updates, one per xid, as a changes page read after `after`. */
const accounts = (xids: number[], horizon: number, after: string, complete = false): ChangesResponse =>
  page(
    xids.map((xid) => account(`u${String(xid)}`, {}, [xid, 1])),
    String(horizon),
    after,
    {},
    complete,
  );

describe('runProjectorCycle turns', () => {
  it('reads a stream whose end keeps moving only up to the horizon of its first read, projecting the next stream in between', async () => {
    const h = harness({ owners: fakeOwners({ pages: { [`people|${CURSOR_START}`]: page([person('Grace')], '101', CURSOR_START) } }), streamPagesPerCycle: 5 });
    const changes = h.owners.owners.changes.bind(h.owners.owners);
    const reads: string[] = [];
    // Every read of identity returns the next two transactions and a horizon 60 past the cursor, never a complete page.
    h.owners.owners.changes = async (owner, params) => {
      reads.push(`${owner}|${params.after}`);
      if (owner !== 'identity') return changes(owner, params);
      if (reads.filter((read) => read.startsWith('identity|')).length > 10) throw new Error('identity read past its frontier');
      const xid = Number(params.after.split(':')[0]);
      return accounts([xid + 10, xid + 20], xid + 60, params.after);
    };

    const result = await runProjectorCycle(h.ctx, cycleDeps());

    expect(result).toMatchObject({ rowsApplied: 7, errors: [], backlog: true });
    // The frontier is 60: the third page reaches it, and no read follows a cursor at or past it.
    expect(reads.filter((read) => /^(identity|people)\|/.test(read))).toEqual([`identity|${CURSOR_START}`, `people|${CURSOR_START}`, 'identity|20:1', 'identity|40:1']);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '60', cursor_seq: '1', applied_horizon: '60' });
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '100', cursor_seq: '1', applied_horizon: '101', rows_applied: 1 });
  });

  it('gives streams with several pages one page per turn, alternately', async () => {
    const pages = {
      [`identity|${CURSOR_START}`]: accounts([10], 100, CURSOR_START),
      'identity|10:1': accounts([20], 100, '10:1'),
      'identity|20:1': accounts([30], 100, '20:1', true),
      [`people|${CURSOR_START}`]: page([person('A', {}, [11, 1])], '100', CURSOR_START, {}, false),
      'people|11:1': page([person('B', {}, [21, 1])], '100', '11:1', {}, false),
      'people|21:1': page([person('C', {}, [31, 1])], '100', '21:1'),
    };
    const h = harness({ owners: fakeOwners({ pages }), streamPagesPerCycle: 3 });

    const result = await runProjectorCycle(h.ctx, cycleDeps());

    expect(result).toMatchObject({ rowsApplied: 6, errors: [], backlog: false });
    expect(h.owners.changes.filter((read) => read.owner === 'identity' || read.owner === 'people').map((read) => `${read.owner}|${read.after}`)).toEqual([
      `identity|${CURSOR_START}`,
      `people|${CURSOR_START}`,
      'identity|10:1',
      'people|11:1',
      'identity|20:1',
      'people|21:1',
    ]);
  });

  it('reads a fenced stream ahead only until it passes the fence, then applies the operation jointly', async () => {
    const pages: Record<string, PageSource> = {
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
      // Identity's change of the operation commits after its first read; its later write at 160 lies past the fence at 150.
      [`identity|${CURSOR_START}`]: (read) =>
        read === 1 ? page([], '101', CURSOR_START) : page([account('grace', { operationId: OP }), account('lin', {}, [160, 1])], '200', CURSOR_START, { [OP]: 'done' }, false),
    };
    const h = harness({ owners: fakeOwners({ pages }), streamPagesPerCycle: 2 });

    const result = await runProjectorCycle(h.ctx, cycleDeps());

    expect(result).toMatchObject({ held: 2, rowsApplied: 2, errors: [], backlog: true });
    const updates = h.legacy.applied(TUSERS_UPDATE);
    expect(updates.map((statement) => statement.params.p0)).toEqual(['Grace', 'grace']);
    expect(new Set(updates.map((statement) => statement.tx)).size).toBe(1);
    // The first read, the read-ahead that stopped past the fence, the re-run that parked at the operation, and the release's re-read of its span.
    expect(h.owners.changes.filter((read) => read.owner === 'identity').map((read) => read.after)).toEqual([CURSOR_START, CURSOR_START, CURSOR_START, CURSOR_START]);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1', applied_horizon: '160' });
  });

  /** Identity's three pages from the start, each below the horizon 100 of a cycle's first read; the last one is complete. */
  const threePages = (): Record<string, PageSource> => ({
    [`identity|${CURSOR_START}`]: accounts([10], 100, CURSOR_START),
    'identity|10:1': accounts([20], 100, '10:1'),
    'identity|20:1': accounts([30], 100, '20:1', true),
  });

  it.each<[number, string[][], boolean[]]>([
    [1, [[CURSOR_START], ['10:1'], ['20:1']], [true, true, false]],
    [2, [[CURSOR_START, '10:1'], ['20:1']], [true, false]],
  ])('reads at most %i pages of a stream per cycle, each next cycle continuing from its checkpoint', async (streamPagesPerCycle, reads, backlogs) => {
    const h = harness({ owners: fakeOwners({ pages: threePages() }), streamPagesPerCycle });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
    const identityReads = () => h.owners.changes.filter((read) => read.owner === 'identity').map((read) => read.after);

    for (const [cycle, expected] of reads.entries()) {
      const before = identityReads().length;
      expect(await loop.runOnce(), `cycle ${String(cycle + 1)}`).toMatchObject({ rowsApplied: expected.length, errors: [], backlog: backlogs[cycle] });
      expect(identityReads().slice(before)).toEqual(expected);
    }
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '30', cursor_seq: '1', applied_horizon: '100' });
  });

  it("applies another stream's new rows in the next cycle while a stream works off its backlog one page per cycle", async () => {
    const pages: Record<string, PageSource> = {
      ...threePages(),
      // People's row commits after the first cycle has read the stream.
      [`people|${CURSOR_START}`]: (read) => (read === 1 ? page([], '100', CURSOR_START) : page([person('Grace', {}, [101, 1])], '102', CURSOR_START)),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
    const applied = () => h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0);

    expect(await loop.runOnce()).toMatchObject({ rowsApplied: 1, errors: [], backlog: true });
    expect(applied()).toEqual(['u10']);

    expect(await loop.runOnce()).toMatchObject({ rowsApplied: 2, errors: [], backlog: true });
    expect(applied()).toEqual(['u10', 'u20', 'Grace']);
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '101', cursor_seq: '1', applied_horizon: '102' });
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '20', cursor_seq: '1' });

    expect(await loop.runOnce()).toMatchObject({ rowsApplied: 1, errors: [], backlog: false });
    expect(applied()).toEqual(['u10', 'u20', 'Grace', 'u30']);
  });

  it('applies a released operation in one transaction, then resumes its stream with the turn that parked it, in the same cycle', async () => {
    const pages = {
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP }), person('Lin', {}, [104, 1])], '105', CURSOR_START, { [OP]: 'done' }),
      'people|100:1': page([person('Lin', {}, [104, 1])], '105', '100:1'),
      [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP })], '103', CURSOR_START, { [OP]: 'done' }),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
    const peopleReads = () => h.owners.changes.filter((read) => read.owner === 'people').map((read) => read.after);

    expect(await loop.runOnce()).toMatchObject({ held: 2, rowsApplied: 3, errors: [], backlog: false });
    const applied = h.legacy.applied(TUSERS_UPDATE);
    expect(applied.map((statement) => statement.params.p0)).toEqual(['Grace', 'grace', 'Lin']);
    const [tx, later, ...others] = new Set(applied.map((statement) => statement.tx));
    expect([applied[1]?.tx, applied[2]?.tx, others]).toEqual([tx, later, []]);
    const checkpointed = h.legacy.applied(/^UPDATE opt2_sync/).filter((statement) => statement.tx === tx);
    expect(checkpointed.map((statement) => statement.params.owner).sort()).toEqual(['identity', 'people']);
    // The turn that parked people, its read-ahead past the fence, the release's re-read of its span, and the resumed turn.
    expect(peopleReads()).toEqual([CURSOR_START, '104:1', CURSOR_START, '100:1']);
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '104', cursor_seq: '1', applied_horizon: '105' });

    expect(await loop.runOnce()).toMatchObject({ rowsApplied: 0, errors: [], backlog: false });
    expect(peopleReads().slice(4)).toEqual(['104:1']);
  });

  it('defers the re-run of a stream that has used its budget, applying nothing of the operation until a later cycle releases it jointly', async () => {
    const pages: Record<string, PageSource> = {
      // Identity's change of the operation commits after its first read.
      [`identity|${CURSOR_START}`]: (read) =>
        read === 1 ? page([], '101', CURSOR_START) : page([account('grace', { operationId: OP })], '200', CURSOR_START, { [OP]: 'done' }),
      [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    expect(await loop.runOnce()).toMatchObject({ held: 1, rowsApplied: 0, errors: [], backlog: true });
    expect(h.legacy.applied(TUSERS_UPDATE)).toEqual([]);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '0', cursor_seq: '0', applied_horizon: '101' });

    expect(await loop.runOnce()).toMatchObject({ held: 2, rowsApplied: 2, errors: [] });
    const updates = h.legacy.applied(TUSERS_UPDATE);
    expect(updates.map((statement) => statement.params.p0)).toEqual(['Grace', 'grace']);
    expect(new Set(updates.map((statement) => statement.tx)).size).toBe(1);
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1' });
  });
});

describe('runProjectorCycle read-ahead budget and kept scans', () => {
  const OP_B = 'b0000000-0000-4000-8000-00000000000b';
  /** A data owner without rows whose horizon rises every cycle, so that each cycle has an idle advance to commit. */
  const IDLE_OWNER = 'communications';

  /** Cycle collaborators sharing one tracker and one stream memory across cycles, as a loop's cycles do. */
  function sharedDeps() {
    const tracker = new OperationTracker();
    const memory: StreamMemory = { mirrored: new Map(), failures: new Map(), fenceFailures: new Map(), scans: new Map() };
    const deps = (signal?: AbortSignal): CycleDeps => ({ hooks: {}, startupGuard: refuseGuard, tracker, memory, ...(signal === undefined ? {} : { signal }) });
    const scanOf = (owner: string) => [...memory.scans.values()].find((saved) => saved.scan.owner === owner)?.scan;
    return { tracker, memory, deps, scanOf };
  }

  /** People's change of the operation at 100:1 on an incomplete page, then one later people row per page at xid 110, seq 1 to `last`. */
  function heldBacklog(h: ReturnType<typeof harness>, last: number, onRead: (after: string) => void = () => undefined) {
    const changes = h.owners.owners.changes.bind(h.owners.owners);
    const reads: { owner: string; after: string; limit: number | undefined }[] = [];
    let cycle = 0;
    h.owners.owners.changes = async (owner, params) => {
      reads.push({ owner, after: params.after, limit: (params as { limit?: number }).limit });
      if (owner === IDLE_OWNER) return page([], String(300 + cycle), params.after);
      if (owner !== 'people') return changes(owner, params);
      onRead(params.after);
      if (params.after === CURSOR_START) return page([person('Held', { operationId: OP })], '200', params.after, { [OP]: 'done' }, false);
      const seq = params.after === '100:1' ? 1 : Number(params.after.split(':')[1]) + 1;
      return page([person('Later', {}, [110, seq])], '200', params.after, { [OP]: 'done' }, seq === last);
    };
    return {
      nextCycle: () => {
        cycle += 1;
        return reads.length;
      },
      readsSince: (from: number, owner: string) => reads.slice(from).filter((read) => read.owner === owner),
    };
  }

  /** Identity's change of the operation at 102:1, on a complete page past every fence. */
  const identityPages = () => ({ [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP })], '200', CURSOR_START, { [OP]: 'done' }) });

  it('reads a parked stream ahead one page per cycle below a fixed fence, resuming each cycle, then releases it jointly', async () => {
    const h = harness({ owners: fakeOwners({ pages: identityPages() }), streamPagesPerCycle: 1, batchRows: 1 });
    const feed = heldBacklog(h, 100);
    const shared = sharedDeps();

    for (let cycle = 1; cycle < 100; cycle += 1) {
      const from = feed.nextCycle();
      const result = await runProjectorCycle(h.ctx, shared.deps());
      expect(result, `cycle ${String(cycle)}`).toMatchObject({ rowsApplied: 0, errors: [], backlog: true });
      // One turn page and one read-ahead page, continuing from where the previous cycle stopped.
      const ahead = cycle === 1 ? '100:1' : `110:${String(cycle - 1)}`;
      expect(feed.readsSince(from, 'people').map((read) => read.after)).toEqual([CURSOR_START, ahead]);
      expect(shared.scanOf('people')).toMatchObject({ start: CURSOR_START, end: `110:${String(cycle)}`, entries: [{ cursor: '100:1', operationId: OP, next: '110' }] });
      expect(shared.scanOf('people')?.entries).toHaveLength(1);
      expect(h.legacy.checkpoint(IDLE_OWNER)).toMatchObject({ applied_horizon: String(300 + cycle) });
    }
    expect(h.legacy.applied(TUSERS_UPDATE)).toEqual([]);

    const from = feed.nextCycle();
    expect(await runProjectorCycle(h.ctx, shared.deps())).toMatchObject({ rowsApplied: 3, errors: [] });
    // The turn, the last read-ahead page past the fence, the release's re-read of the span, and the resumed turn.
    expect(feed.readsSince(from, 'people').map((read) => [read.after, read.limit])).toEqual([
      [CURSOR_START, 1],
      ['110:99', 1],
      [CURSOR_START, 1],
      ['100:1', 1],
    ]);
    expect(h.legacy.checkpoint(IDLE_OWNER)).toMatchObject({ applied_horizon: '400' });
    const updates = h.legacy.applied(TUSERS_UPDATE);
    expect(updates.map((statement) => statement.params.p0)).toEqual(['Held', 'grace', 'Later']);
    const [joint, later, ...others] = new Set(updates.map((statement) => statement.tx));
    expect([updates[1]?.tx, updates[2]?.tx, others]).toEqual([joint, later, []]);
    const checkpointed = h.legacy.applied(/^UPDATE opt2_sync/).filter((statement) => statement.tx === joint);
    expect(checkpointed.map((statement) => statement.params.owner).sort()).toEqual(['identity', 'people']);
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '110', cursor_seq: '1', applied_horizon: '110' });
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '102', cursor_seq: '1', applied_horizon: '200' });
  });

  it('drops a kept scan whose stream checkpoint moved, scanning afresh from the new checkpoint', async () => {
    const legacy = fakeLegacy();
    const pages = { ...identityPages(), 'people|110:1': page([person('Open', { operationId: OP_B }, [120, 1])], '200', '110:1', { [OP_B]: 'open' }) };
    const h = harness({ legacy, owners: fakeOwners({ pages }), streamPagesPerCycle: 1 });
    const changes = h.owners.owners.changes.bind(h.owners.owners);
    h.owners.owners.changes = async (owner, params) => {
      if (owner !== 'people' || params.after === '110:1') return changes(owner, params);
      if (params.after === CURSOR_START) return page([person('Held', { operationId: OP })], '200', params.after, { [OP]: 'done' }, false);
      return page([person('Later', {}, [110, 1])], '200', params.after, { [OP]: 'done' }, false);
    };
    const shared = sharedDeps();

    expect(await runProjectorCycle(h.ctx, shared.deps())).toMatchObject({ rowsApplied: 0, errors: [] });
    expect(shared.scanOf('people')).toMatchObject({ start: CURSOR_START, end: '110:1' });

    // Another instance released the operation, moving people's checkpoint to the kept scan's end and identity's past its row.
    legacy.seed({ owner: 'people', tenant_id: TENANT, cursor_xid: '110', cursor_seq: '1', applied_horizon: '120', batch_id: 'other', rows_applied: 2, updated_at: null, pending_effects: null, ready_horizon: null });
    legacy.seed({ owner: 'identity', tenant_id: TENANT, cursor_xid: '102', cursor_seq: '1', applied_horizon: '200', batch_id: 'other', rows_applied: 1, updated_at: null, pending_effects: null, ready_horizon: null });
    expect(await runProjectorCycle(h.ctx, shared.deps())).toMatchObject({ rowsApplied: 0, errors: [] });
    expect(shared.scanOf('people')).toEqual({
      owner: 'people',
      tenantId: TENANT,
      start: '110:1',
      end: '120:1',
      horizon: '200',
      entries: [{ cursor: '120:1', previous: '110:1', xid: '120', operationId: OP_B, through: '120:1', next: undefined }],
    });
  });

  /**
   * People parked at done operation A, whose second transaction at 108:1 follows B's row at 105:1 on the second page;
   * `fault` sees each people read with the number of reads after the start so far this cycle.
   */
  function interleaved(fault: (after: string, limit: number | undefined, startReads: number) => void = () => undefined) {
    const status = { b: 'open' as OperationStatus };
    const pages: Record<string, PageSource> = {
      [`people|${CURSOR_START}`]: page([person('A1', { operationId: OP })], '200', CURSOR_START, { [OP]: 'done' }, false),
      'people|100:1': () => page([person('B', { operationId: OP_B }, [105, 1]), person('A2', { operationId: OP }, [108, 1])], '200', '100:1', { [OP]: 'done', [OP_B]: status.b }),
    };
    const h = harness({ owners: fakeOwners({ pages }), streamPagesPerCycle: 1 });
    const changes = h.owners.owners.changes.bind(h.owners.owners);
    const reads: [string, number | undefined][] = [];
    h.owners.owners.changes = async (owner, params) => {
      if (owner === 'people') {
        const limit = (params as { limit?: number }).limit;
        reads.push([params.after, limit]);
        fault(params.after, limit, reads.filter(([after]) => after === CURSOR_START).length);
      }
      return changes(owner, params);
    };
    return { h, status, reads };
  }

  it('refreshes the status of an operation a kept scan holds past its first page, and releases the closure once it is done', async () => {
    const { h, status, reads } = interleaved();
    const shared = sharedDeps();

    expect(await runProjectorCycle(h.ctx, shared.deps())).toMatchObject({ held: 1, rowsApplied: 0, errors: [] });
    expect(shared.scanOf('people')?.entries.map((entry) => [entry.cursor, entry.operationId])).toEqual([
      ['100:1', OP],
      ['105:1', OP_B],
      ['108:1', OP],
    ]);

    status.b = 'done';
    reads.length = 0;
    expect(await runProjectorCycle(h.ctx, shared.deps())).toMatchObject({ rowsApplied: 3, errors: [] });
    const batchRows = config.projection.batchRows;
    // The turn re-reads only the first page; one row read refreshes B; the release re-reads the span; the resumed turn reads on.
    expect(reads).toEqual([
      [CURSOR_START, batchRows],
      ['100:1', 1],
      [CURSOR_START, batchRows],
      ['100:1', batchRows],
      ['108:1', batchRows],
    ]);
    const updates = h.legacy.applied(TUSERS_UPDATE);
    expect(updates.map((statement) => statement.params.p0)).toEqual(['A1', 'B', 'A2']);
    expect(new Set(updates.map((statement) => statement.tx)).size).toBe(1);
    expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '108', cursor_seq: '1', applied_horizon: '200' });
  });

  it.each<[string, (after: string, limit: number | undefined, startReads: number) => boolean, 'fail' | 'stop']>([
    ['its status read fails', (after, limit) => after === '100:1' && limit === 1, 'fail'],
    ['its span re-read fails', (after, _limit, startReads) => after === CURSOR_START && startReads === 2, 'fail'],
    ['the cycle stops during its span re-read', (after, _limit, startReads) => after === CURSOR_START && startReads === 2, 'stop'],
  ])('keeps the scan of a parked stream and releases it in the next cycle when %s', async (_label, at, kind) => {
    let armed = false;
    let stop = new AbortController();
    const { h, status, reads } = interleaved((after, limit, startReads) => {
      if (!armed || !at(after, limit, startReads)) return;
      armed = false;
      if (kind === 'stop') stop.abort();
      else throw new Error('people unavailable');
    });
    const shared = sharedDeps();
    await runProjectorCycle(h.ctx, shared.deps());

    status.b = 'done';
    reads.length = 0;
    armed = true;
    const faulted = await runProjectorCycle(h.ctx, shared.deps(stop.signal));
    expect(faulted.rowsApplied).toBe(0);
    expect(faulted.errors.map((error) => error.owner)).toEqual(kind === 'fail' ? ['people'] : []);
    expect(h.legacy.applied(TUSERS_UPDATE)).toEqual([]);
    expect(shared.scanOf('people')).toMatchObject({ start: CURSOR_START, end: '108:1' });

    stop = new AbortController();
    expect(await runProjectorCycle(h.ctx, shared.deps(stop.signal))).toMatchObject({ rowsApplied: 3, errors: [] });
    expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0)).toEqual(['A1', 'B', 'A2']);
  });

  it.each<[string, ProjectedChangeRow[]]>([
    ['misses the span end', [person('Grace', {}, [100, 2])]],
    ['holds a row its scan did not', [person('Early', { operationId: OP }, [99, 1]), person('Grace', { operationId: OP })]],
  ])('fails the stream without applying when the re-read span %s', async (_label, reread) => {
    const pages: Record<string, PageSource> = {
      ...identityPages(),
      [`people|${CURSOR_START}`]: (read) => page(read === 1 ? [person('Grace', { operationId: OP })] : reread, '200', CURSOR_START, { [OP]: 'done' }),
    };
    const h = harness({ owners: fakeOwners({ pages }) });
    const result = await runProjectorCycle(h.ctx, cycleDeps());
    expect(result.rowsApplied).toBe(0);
    expect(result.errors.map(({ owner, cursor, error }) => [owner, cursor, error])).toEqual([['people', CURSOR_START, new HeldSpanChangedError('people', TENANT, '100:1')]]);
    expect(h.legacy.applied(TUSERS_UPDATE)).toEqual([]);
    expect(h.legacy.checkpoint('people')).toBeUndefined();
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '0', cursor_seq: '0' });
    const logged = h.logger.error.mock.calls.find(([, text]) => text === `Reverse projection of people for tenant ${TENANT} stopped at cursor ${CURSOR_START}`);
    expect(logged?.[0]).toMatchObject({ tenantId: TENANT, error: { type: 'HeldSpanChangedError' } });
  });

  it('stops the read-ahead before its next page, keeps the scan and resumes it in the next cycle', async () => {
    const h = harness({ owners: fakeOwners({ pages: identityPages() }), streamPagesPerCycle: 2, batchRows: 1 });
    let stop = new AbortController();
    const feed = heldBacklog(h, 100, (after) => {
      if (after === '100:1') stop.abort();
    });
    const shared = sharedDeps();

    let from = feed.nextCycle();
    expect(await runProjectorCycle(h.ctx, shared.deps(stop.signal))).toMatchObject({ rowsApplied: 0, errors: [], backlog: true });
    expect(feed.readsSince(from, 'people').map((read) => read.after)).toEqual([CURSOR_START, '100:1']);
    expect(shared.scanOf('people')).toMatchObject({ start: CURSOR_START, end: '110:1' });

    stop = new AbortController();
    from = feed.nextCycle();
    expect(await runProjectorCycle(h.ctx, shared.deps(stop.signal))).toMatchObject({ rowsApplied: 0, errors: [], backlog: true });
    expect(feed.readsSince(from, 'people').map((read) => read.after)).toEqual([CURSOR_START, '110:1', '110:2']);
    expect(shared.scanOf('people')).toMatchObject({ start: CURSOR_START, end: '110:3' });
  });
});

describe('runProjectorCycle idle streams', () => {
  const CHECKPOINT_UPSERT = /^UPDATE opt2_sync\.projector_checkpoint WITH/;

  /** Commits a checkpoint for every data owner's stream of the tenant, as an applying batch left it, except `except`'s. */
  function seedAll(legacy: ReturnType<typeof fakeLegacy>, appliedHorizon: string, except?: string) {
    for (const owner of config.dataOwners.filter((name) => name !== except)) {
      legacy.seed({ owner, tenant_id: TENANT, cursor_xid: '50', cursor_seq: '1', applied_horizon: appliedHorizon, batch_id: `batch-${owner}`, rows_applied: 3, updated_at: null, pending_effects: null, ready_horizon: null });
    }
  }

  it('commits and mirrors nothing for streams whose stored checkpoint already holds the horizon of their empty page', async () => {
    const legacy = fakeLegacy();
    seedAll(legacy, '200');
    const h = harness({ legacy, owners: fakeOwners({ defaultHorizon: '200' }) });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    // The loop's first cycle mirrors what it finds stored, all in one transaction.
    expect(await loop.runOnce()).toMatchObject({ batches: 0, errors: [] });
    expect(new Set(h.db.mirrorTx).size).toBe(1);
    expect(h.db.mirrorTx).toHaveLength(config.dataOwners.length);
    const mirrored = h.db.mirrorTx.length;

    expect(await loop.runOnce()).toMatchObject({ batches: 0, rowsApplied: 0, errors: [], backlog: false });
    expect(legacy.begun()).toBe(0);
    expect(h.db.mirrorTx).toHaveLength(mirrored);
    expect(h.owners.changes.filter((read) => read.owner === 'people')).toHaveLength(2);
  });

  it("commits the newer horizons of each owner's idle streams in one SQL Server transaction and one mirror transaction of their own, keeping each batch record", async () => {
    const legacy = fakeLegacy();
    seedAll(legacy, '150', 'people');
    const h = harness({ legacy, owners: fakeOwners({ defaultHorizon: '200' }) });

    expect(await runProjectorCycle(h.ctx, cycleDeps())).toMatchObject({ batches: config.dataOwners.length, rowsApplied: 0, errors: [] });

    const upserts = legacy.applied(CHECKPOINT_UPSERT);
    expect(upserts).toHaveLength(config.dataOwners.length);
    expect(new Set(upserts.map((statement) => statement.tx)).size).toBe(config.dataOwners.length);
    expect(legacy.begun()).toBe(config.dataOwners.length);
    expect(h.db.mirrorTx).toHaveLength(config.dataOwners.length);
    expect(new Set(h.db.mirrorTx).size).toBe(config.dataOwners.length);
    expect(legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '50', cursor_seq: '1', applied_horizon: '200', batch_id: 'batch-identity', rows_applied: 3 });
    // The stream without a stored checkpoint gets its first one in its owner's idle batch.
    expect(legacy.checkpoint('people')).toMatchObject({ cursor_xid: '0', cursor_seq: '0', applied_horizon: '200', rows_applied: 0 });
    expect(h.db.mirror.get(`people|${TENANT}`)).toEqual({ cursor: CURSOR_START, horizon: '200' });
  });

  it.each<[string, boolean, Partial<CheckpointRecord>]>([
    ['without a stored checkpoint', false, { cursor_xid: '0', cursor_seq: '0', applied_horizon: '100', rows_applied: 0 }],
    ['with a lower stored horizon', true, { cursor_xid: '50', cursor_seq: '1', applied_horizon: '100', batch_id: 'batch-people', rows_applied: 3 }],
  ])('commits the held xid of a stream parked at its first row %s once, in the idle batch after the settle rounds, then nothing while it stays parked', async (_label, peopleStored, stored) => {
    const legacy = fakeLegacy();
    seedAll(legacy, '60', peopleStored ? undefined : 'people');
    const after = peopleStored ? '50:1' : CURSOR_START;
    const pages = { [`people|${after}`]: page([person('Grace', { operationId: OP })], '101', after, { [OP]: 'open' }) };
    const h = harness({ legacy, owners: fakeOwners({ pages, defaultHorizon: '200' }) });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    // Each other owner's lane commits its idle advance; the parked stream's waits for the settle rounds.
    expect(await loop.runOnce()).toMatchObject({ held: 1, batches: config.dataOwners.length, rowsApplied: 0, errors: [] });
    const upserts = legacy.applied(CHECKPOINT_UPSERT);
    expect(upserts).toHaveLength(config.dataOwners.length);
    expect(upserts.at(-1)?.params.owner).toBe('people');
    expect(new Set(upserts.map((statement) => statement.tx)).size).toBe(config.dataOwners.length);
    expect(legacy.checkpoint('people')).toMatchObject(stored);
    expect(legacy.checkpoint('identity')).toMatchObject({ applied_horizon: '200' });
    expect(h.db.mirror.get(`people|${TENANT}`)).toEqual({ cursor: after, horizon: '100' });
    const begun = legacy.begun();
    const mirrored = h.db.mirrorTx.length;

    expect(await loop.runOnce()).toMatchObject({ held: 1, batches: 0, rowsApplied: 0, errors: [] });
    expect(legacy.begun()).toBe(begun);
    expect(h.db.mirrorTx).toHaveLength(mirrored);
    expect(legacy.checkpoint('people')).toMatchObject(stored);
  });

  it.each<[string, (legacy: ReturnType<typeof fakeLegacy>, db: ReturnType<typeof fakeDb>) => Promise<CycleResult>]>([
    ['their idle advances fail after their commits', (legacy, db) => runProjectorCycle(harness({ legacy, db }).ctx, cycleDeps())],
    [
      'mirroring the checkpoints a new loop finds stored fails',
      (legacy, db) => {
        seedAll(legacy, '200');
        return createProjectorLoop(harness({ legacy, db }).ctx, { startupGuard: refuseGuard }).runOnce();
      },
    ],
  ])('stops every idle stream for the cycle when %s', async (_label, run) => {
    const legacy = fakeLegacy();
    const result = await run(legacy, fakeDb(true, () => true));

    expect(result.errors.map((error) => error.owner).sort()).toEqual([...config.dataOwners].sort());
    expect(result.errors.every((error) => error.error.message === 'mirror unavailable')).toBe(true);
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

describe('owed legacy effects', () => {
  const pages = { [`strategies-content|${CURSOR_START}`]: page([contentUpdate()], '301', CURSOR_START) };
  const PURGE: LegacyEffect[] = [{ kind: 'purgeCache', siteId: SITE }];
  const TCONTENT_UPDATE = /^UPDATE \[dbo\]\.\[tcontent\]/;

  /** Barrier over the fake legacy database for the content write at xid 300, the cycle's tenant and authority. */
  function barrier(h: ReturnType<typeof harness>) {
    const awaiter = createAwaiter({
      legacy: h.ctx.legacy,
      owners: { position: () => Promise.resolve({ owner: 'strategies-content', position: '300', outbox: null, inbox: null }) },
      authority: () => currentAuthority({ gateway: h.ctx.gateway, config: config.paths }),
      catalog: unitCatalog,
      tenants: () => Promise.resolve([TENANT]),
      quarantined: () => Promise.resolve([]),
      clock: { now: () => new Date(0) },
      sleep: () => Promise.resolve(),
      defaults: { timeoutMs: 0, pollIntervalMs: 1 },
    });
    return awaiter.awaitProjection({ positions: new Map([['strategies-content', '300']]) });
  }

  /** A checkpoint an earlier cycle committed while its batch's effects were still owed. */
  function owedRecord(owner: string, tenantId: string, effects: LegacyEffect[]): CheckpointRecord {
    const base = { owner, tenant_id: tenantId, cursor_xid: '50', cursor_seq: '1', applied_horizon: '51', batch_id: 'batch-old', rows_applied: 1, updated_at: null };
    return { ...base, pending_effects: JSON.stringify(effects), ready_horizon: null };
  }

  it.each<[string, (h: ReturnType<typeof harness>, legacyOptions: LegacyOptions) => void, [string, string][]]>([
    [
      'the cache purge fails',
      (h) => {
        h.bridge.bridge.purgeCache = () => Promise.reject(new Error('bridge unavailable'));
      },
      [],
    ],
    [
      'clearing them fails',
      (_h, legacyOptions) => {
        legacyOptions.failClear = true;
      },
      [['purgeCache', SITE]],
    ],
  ])('keeps them owed and the barrier pending when %s after commit, then the next cycle runs and clears them', async (_label, breakIt, firstCalls) => {
    const legacyOptions: LegacyOptions = {};
    const legacy = fakeLegacy(legacyOptions);
    const db = fakeDb();
    const owners = fakeOwners({ pages, defaultHorizon: '301' });
    const first = harness({ legacy, db, owners });
    breakIt(first, legacyOptions);

    const failed = await runProjectorCycle(first.ctx, cycleDeps());

    expect(failed.errors.map((error) => [error.owner, error.cursor])).toEqual([['strategies-content', '300:1']]);
    expect(first.bridge.calls).toEqual(firstCalls);
    expect(legacy.checkpoint('strategies-content')).toMatchObject({ cursor_xid: '300', applied_horizon: '301', pending_effects: JSON.stringify(PURGE), ready_horizon: null });
    await expect(barrier(first)).rejects.toBeInstanceOf(ProjectionTimeoutError);

    legacyOptions.failClear = false;
    const next = harness({ legacy, db, owners });
    expect(await runProjectorCycle(next.ctx, cycleDeps())).toMatchObject({ errors: [] });
    expect(next.bridge.calls).toEqual([['purgeCache', SITE]]);
    expect(legacy.checkpoint('strategies-content')).toMatchObject({ cursor_xid: '300', pending_effects: null, ready_horizon: null });
    expect(legacy.applied(TCONTENT_UPDATE)).toHaveLength(1);
    await expect(barrier(next)).resolves.toMatchObject({ positions: new Map([['strategies-content', '300']]) });
  });

  it('keeps them owed across a crash after the SQL Server commit and runs them once the projector restarts', async () => {
    const legacy = fakeLegacy();
    const db = fakeDb();
    const owners = fakeOwners({ pages, defaultHorizon: '301' });
    const crash = new Error('ProjectorCrashed');
    const hooks: ProjectorHooks = { afterLegacyCommit: ({ owner }) => (owner === 'strategies-content' ? Promise.reject(crash) : Promise.resolve()) };
    const crashed = harness({ legacy, db, owners });

    await expect(createProjectorLoop(crashed.ctx, { hooks, startupGuard: refuseGuard }).runOnce()).rejects.toBe(crash);
    expect(crashed.bridge.calls).toEqual([]);
    expect(legacy.checkpoint('strategies-content')).toMatchObject({ cursor_xid: '300', pending_effects: JSON.stringify(PURGE) });
    await expect(barrier(crashed)).rejects.toBeInstanceOf(ProjectionTimeoutError);

    const restarted = harness({ legacy, db, owners });
    expect(await createProjectorLoop(restarted.ctx, { startupGuard: refuseGuard }).runOnce()).toMatchObject({ errors: [] });
    expect(restarted.bridge.calls).toEqual([['purgeCache', SITE]]);
    expect(legacy.checkpoint('strategies-content')).toMatchObject({ pending_effects: null });
    expect(legacy.applied(TCONTENT_UPDATE)).toHaveLength(1);
    await expect(barrier(restarted)).resolves.toBeDefined();
  });

  it.each([
    ['a streamed tenant', SITE],
    ['a tenant whose site has left tsettings', 'gone-site'],
  ])('runs and clears what an earlier cycle left owed for %s before streaming', async (_label, site) => {
    const tenantId = tenantIdForSite(site);
    const effects: LegacyEffect[] = [
      { kind: 'siteRefresh', siteId: site },
      { kind: 'purgeCache', siteId: site },
    ];
    const legacy = fakeLegacy();
    legacy.seed(owedRecord('programs-sites', tenantId, effects));
    const h = harness({ legacy });
    const order: string[] = [];
    const changes = h.owners.owners.changes.bind(h.owners.owners);
    h.owners.owners.changes = (owner, params) => {
      order.push(`changes:${owner}`);
      return changes(owner, params);
    };
    const siteRefresh = h.bridge.bridge.siteRefresh.bind(h.bridge.bridge);
    h.bridge.bridge.siteRefresh = (siteId) => {
      order.push(`siteRefresh:${siteId}`);
      return siteRefresh(siteId);
    };

    expect(await runProjectorCycle(h.ctx, cycleDeps())).toMatchObject({ errors: [] });
    expect(h.bridge.calls).toEqual([
      ['siteRefresh', site],
      ['purgeCache', site],
    ]);
    expect(order[0]).toBe(`siteRefresh:${site}`);
    expect(legacy.checkpoint('programs-sites', tenantId)).toMatchObject({ cursor_xid: '50', pending_effects: null, ready_horizon: null });
  });

  it('holds the barrier while a site that left tsettings still owes its refresh, until a later cycle runs and clears it', async () => {
    const gone = tenantIdForSite('gone-site');
    const effects: LegacyEffect[] = [
      { kind: 'siteRefresh', siteId: 'gone-site' },
      { kind: 'purgeCache', siteId: 'gone-site' },
    ];
    const legacy = fakeLegacy();
    legacy.seed({ ...owedRecord('programs-sites', gone, effects), applied_horizon: '301' });
    const h = harness({ legacy, owners: fakeOwners({ defaultHorizon: '301' }) });
    const siteRefresh = h.bridge.bridge.siteRefresh.bind(h.bridge.bridge);
    h.bridge.bridge.siteRefresh = () => Promise.reject(new Error('bridge unavailable'));
    const ctx = { ...h.ctx, clock: { now: () => new Date() } } as unknown as MigrationContext;
    const projector = createProjector(ctx, { startupGuard: refuseGuard });
    const barrierOf = () => projector.awaitProjection({ positions: new Map([['programs-sites', '300']]), timeoutMs: 50 });

    const failed = await projector.runOnce();

    expect(failed.errors.map((error) => [error.owner, error.tenantId])).toEqual([['programs-sites', gone]]);
    expect(legacy.checkpoint('programs-sites')).toMatchObject({ applied_horizon: '301', pending_effects: null });
    const timeout: unknown = await barrierOf().catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(ProjectionTimeoutError);
    expect(timeout).toMatchObject({ pending: [{ owner: 'programs-sites', xid: '300', tenantsBehind: [gone] }] });

    h.bridge.bridge.siteRefresh = siteRefresh;
    expect(await projector.runOnce()).toMatchObject({ errors: [] });
    expect(h.bridge.calls).toEqual([
      ['siteRefresh', 'gone-site'],
      ['purgeCache', 'gone-site'],
    ]);
    expect(legacy.checkpoint('programs-sites', gone)).toMatchObject({ pending_effects: null, ready_horizon: null });
    await expect(barrierOf()).resolves.toMatchObject({ positions: new Map([['programs-sites', '300']]) });
  });

  it.each<[string, BridgeError, boolean]>([
    ['answers unregistered site, which settles the purge', new BridgeError('jobs.purgeCache', 404, { error: 'notFound', message: 'unregistered site' }), true],
    ['answers the bodiless 404 of the guard, which keeps it owed', new BridgeError('jobs.purgeCache', 404, ''), false],
    ['answers unknown job, which keeps it owed', new BridgeError('jobs.purgeCache', 404, { error: 'notFound', message: 'unknown job' }), false],
  ])('after a site delete, when the purge of the refreshed-away site %s', async (_label, purgeError, settled) => {
    const deleted = changeRow([400, 1], 'site', 'programs_sites.site', 'delete', { before: { SiteID: SITE, Site: 'A' } });
    const legacy = fakeLegacy();
    const h = harness({ legacy, owners: fakeOwners({ pages: { [`programs-sites|${CURSOR_START}`]: page([deleted], '401', CURSOR_START) }, defaultHorizon: '401' }) });
    h.bridge.bridge.siteRefresh = (siteId) => {
      h.bridge.calls.push(['siteRefresh', siteId]);
      return Promise.resolve({ refreshed: true, siteExists: false, serverTime: '2026-06-30T12:00:00' });
    };
    h.bridge.bridge.purgeCache = (siteId) => {
      h.bridge.calls.push(['purgeCache', siteId]);
      return Promise.reject(purgeError);
    };
    const ctx = { ...h.ctx, clock: { now: () => new Date() } } as unknown as MigrationContext;
    const projector = createProjector(ctx, { startupGuard: refuseGuard });

    const result = await projector.runOnce();

    expect(legacy.applied(/^DELETE FROM \[dbo\]\.\[tsettings\]/)).toHaveLength(1);
    expect(h.bridge.calls).toEqual([
      ['siteRefresh', SITE],
      ['purgeCache', SITE],
    ]);
    expect(result.errors.map((error) => error.owner)).toEqual(settled ? [] : ['programs-sites']);
    expect(legacy.checkpoint('programs-sites')?.pending_effects).toBe(settled ? null : JSON.stringify([{ kind: 'siteRefresh', siteId: SITE }, { kind: 'purgeCache', siteId: SITE }]));
    const barrier = projector.awaitProjection({ positions: new Map([['programs-sites', '400']]), timeoutMs: 50 });
    if (settled) await expect(barrier).resolves.toBeDefined();
    else await expect(barrier).rejects.toBeInstanceOf(ProjectionTimeoutError);
  });

  it('stops only the owing stream for the cycle when running what it owes fails', async () => {
    const legacy = fakeLegacy();
    legacy.seed(owedRecord('people', TENANT, PURGE));
    const h = harness({ legacy });
    h.bridge.bridge.purgeCache = () => Promise.reject(new Error('bridge unavailable'));

    const result = await runProjectorCycle(h.ctx, cycleDeps());

    expect(result.errors.map((error) => [error.owner, error.tenantId, error.cursor, error.error.message])).toEqual([['people', TENANT, '50:1', 'bridge unavailable']]);
    expect(result.batches).toBe(config.dataOwners.length - 1);
    expect(h.owners.changes.some((read) => read.owner === 'people')).toBe(false);
    expect(legacy.checkpoint('people')).toMatchObject({ cursor_xid: '50', pending_effects: JSON.stringify(PURGE) });
  });
});

describe('createProjector awaiter', () => {
  it('bounds the gateway status call and cancels the live tsettings and checkpoint reads when the budget passes', async () => {
    const h = harness();
    let cancelled = 0;
    const stalled = {
      request() {
        let fail: (error: Error) => void = () => undefined;
        return {
          input: () => undefined,
          query: () =>
            new Promise((_resolve, reject) => {
              fail = reject;
            }),
          cancel: () => {
            cancelled += 1;
            fail(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
          },
        };
      },
    };
    const ctx = { ...h.ctx, legacy: { ...h.ctx.legacy, live: () => Promise.resolve(stalled) } } as unknown as MigrationContext;

    const error = await createProjector(ctx, { startupGuard: refuseGuard })
      .awaitProjection({ positions: new Map([['people', '100']]), timeoutMs: 50 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProjectionTimeoutError);
    expect(h.gateway.status).toHaveBeenCalledWith({ timeoutMs: 50 });
    expect(cancelled).toBe(2);
  });
});

describe('createProjectorLoop', () => {
  const { idlePollMs, idleMaxPollMs } = config.projection;

  /** Runs `body` under fake timers, passing the delays of the timers set so far. */
  async function withTimers(body: (delays: () => unknown[]) => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await body(() => timers.mock.calls.map(([, delayMs]) => delayMs));
    } finally {
      timers.mockRestore();
      vi.useRealTimers();
    }
  }

  it('joins the cycle in flight, runs its first cycle one base interval after start, and stops', async () => {
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
      await vi.advanceTimersByTimeAsync(idlePollMs);
      expect(h.gateway.status).toHaveBeenCalledTimes(2);
      await loop.stop();
      await vi.advanceTimersByTimeAsync(idleMaxPollMs * 2);
      expect(h.gateway.status).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<[string, () => Fakes, number, number[]]>([
    ['idle cycles, doubling to the ceiling', () => ({}), 12_750, [250, 500, 1000, 2000, 4000, 5000, 5000]],
    ['cycles another instance leads', () => ({ db: fakeDb(false) }), 3750, [250, 500, 1000, 2000, 4000]],
    ['cycles while no unit is target-authoritative', () => ({ tableVersion: null }), 3750, [250, 500, 1000, 2000, 4000]],
    [
      'idle cycles, returning to the base cadence after an active one',
      () => ({
        owners: fakeOwners({ pages: { [`people|${CURSOR_START}`]: (read) => (read === 3 ? page([person('Grace')], '201', CURSOR_START) : page([], '200', CURSOR_START)) } }),
      }),
      2000,
      [250, 500, 1000, 250, 500],
    ],
  ])('backs off %s', async (_label, fakes, advanceMs, expected) => {
    await withTimers(async (delays) => {
      const loop = createProjectorLoop(harness(fakes()).ctx, { startupGuard: refuseGuard });
      loop.start();
      await vi.advanceTimersByTimeAsync(advanceMs);
      await loop.stop();
      expect(delays()).toEqual(expected);
    });
  });

  it('cancels a backed-off timer for a demand, holds the base cadence while it is held, then backs off again', async () => {
    await withTimers(async (delays) => {
      const h = harness();
      const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
      loop.start();
      await vi.advanceTimersByTimeAsync(idlePollMs * 3);
      const cycles = h.gateway.status.mock.calls.length;

      const release = loop.demand();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.gateway.status).toHaveBeenCalledTimes(cycles + 1);
      await vi.advanceTimersByTimeAsync(idlePollMs * 2 - 1);
      release();
      await vi.advanceTimersByTimeAsync(1);
      await loop.stop();

      expect(delays()).toEqual([250, 500, 1000, 0, 250, 250, 500]);
    });
  });

  it('starts the next cycle as soon as the one in flight settles when a demand comes while it runs', async () => {
    await withTimers(async (delays) => {
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const beforeFirstBatch = vi.fn(() => opened);
      const loop = createProjectorLoop(harness().ctx, { hooks: { beforeFirstBatch }, startupGuard: refuseGuard });
      loop.start();
      await vi.advanceTimersByTimeAsync(idlePollMs);
      expect(beforeFirstBatch).toHaveBeenCalledTimes(1);

      const release = loop.demand();
      open();
      await vi.advanceTimersByTimeAsync(1);
      release();
      await loop.stop();

      expect(delays()).toEqual([250, 0, 250]);
    });
  });

  it('only counts demands on a loop not started, and releases each demand once', async () => {
    await withTimers(async (delays) => {
      const loop = createProjectorLoop(harness().ctx, { startupGuard: refuseGuard });
      const first = loop.demand();
      const second = loop.demand();
      expect(delays()).toEqual([]);

      loop.start();
      await vi.advanceTimersByTimeAsync(idlePollMs * 2);
      first();
      first();
      await vi.advanceTimersByTimeAsync(idlePollMs);
      second();
      await vi.advanceTimersByTimeAsync(idlePollMs);
      await loop.stop();

      expect(delays()).toEqual([250, 250, 250, 250, 500]);
    });
  });

  it('runs the next cycle at once for an await of the projection, through its demand', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const projector = createProjector(h.ctx as unknown as MigrationContext, { startupGuard: refuseGuard });
      const peopleReads = () => h.owners.changes.filter((read) => read.owner === 'people').length;
      projector.start();
      await vi.advanceTimersByTimeAsync(idlePollMs * 3);
      const reads = peopleReads();
      await vi.advanceTimersByTimeAsync(0);
      expect(peopleReads()).toBe(reads);

      await expect(projector.awaitProjection({ positions: new Map([['people', '100']]) })).resolves.toMatchObject({ positions: new Map([['people', '100']]) });
      await vi.advanceTimersByTimeAsync(0);
      await projector.stop();

      expect(peopleReads()).toBe(reads + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a roster write through its participants commit positions within one cycle under projector-delay, inside the barrier budget', async () => {
    vi.useFakeTimers();
    try {
      // Each participant's commit transaction holds only a row with no legacy form, after the held rows of the operation.
      const commit = (table: string, xid: number): ProjectedChangeRow => ({ ...account('grace', { operationId: OP }, [xid, 1]), table, legacy: [] });
      const pages = {
        [`identity|${CURSOR_START}`]: page([account('grace', { operationId: OP }), commit('account_operation', 106)], '200', CURSOR_START, { [OP]: 'done' }),
        'identity|102:1': page([commit('account_operation', 106)], '200', '102:1', { [OP]: 'done' }),
        [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP }), commit('roster_operation', 108)], '200', CURSOR_START, { [OP]: 'done' }),
        'people|100:1': page([commit('roster_operation', 108)], '200', '100:1', { [OP]: 'done' }),
      };
      const h = harness({ owners: fakeOwners({ pages }) });
      const clock = { now: () => new Date() };
      const ctx = { ...h.ctx, clock };
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const faults = createFaultRegistry({ config, clock, logger: h.ctx.logger, env: { OPT2_ENV: 'local' } } as unknown as Parameters<typeof createFaultRegistry>[0], { sleep });
      faults.set('projector-delay', { delayMs: 3000 });
      const loop = createProjectorLoop(ctx, { hooks: faults.projectorHooks(), startupGuard: refuseGuard });
      // As createProjector wires its awaiter, on the fake timers.
      const awaiter = createAwaiter({
        legacy: ctx.legacy,
        owners: ctx.owners,
        authority: () => currentAuthority({ gateway: ctx.gateway, config: config.paths }),
        catalog: unitCatalog,
        tenants: () => Promise.resolve(loop.lastTenants() ?? [TENANT]),
        quarantined: () => Promise.resolve([]),
        clock,
        sleep,
        defaults: { timeoutMs: config.projection.defaultAwaitTimeoutMs, pollIntervalMs: config.projection.idlePollMs },
      });
      loop.start();
      const release = loop.demand();
      const barrier = awaiter.awaitProjection({ positions: new Map([['identity', '106'], ['people', '108']]), timeoutMs: 5000 }).finally(release);
      const outcome = barrier.then(
        (result) => result,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(5000);
      // A cycle in flight may still sleep out the delay.
      const stopped = loop.stop();
      await vi.advanceTimersByTimeAsync(3000);
      await stopped;

      const result = await outcome;
      expect(result).toMatchObject({ positions: new Map([['identity', '106'], ['people', '108']]) });
      // One delayed cycle, then at most one poll interval.
      expect((result as { waitedMs: number }).waitedMs).toBeLessThanOrEqual(3000 + config.projection.idlePollMs);
      expect(h.legacy.applied(TUSERS_UPDATE).map((statement) => statement.params.p0)).toEqual(['Grace', 'grace']);
      expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '106', cursor_seq: '1', applied_horizon: '200' });
      expect(h.legacy.checkpoint('people')).toMatchObject({ cursor_xid: '108', cursor_seq: '1', applied_horizon: '200' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failure streak once at WARNING and again on each change of its error, backs off, and logs its recovery at INFO', async () => {
    await withTimers(async (delays) => {
      const h = harness();
      const refused = new Error('Service gateway unavailable (ECONNREFUSED)');
      const timedOut = new Error('Service gateway unavailable (ETIMEDOUT)');
      const missing = new Opt2SyncUnavailableError(timedOut.message, undefined);
      for (const error of [refused, refused, refused, timedOut, missing]) h.gateway.status.mockRejectedValueOnce(error);
      h.gateway.status.mockResolvedValueOnce({ tableVersion: 'v9001', epoch: 1 }).mockRejectedValueOnce(refused);
      const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

      loop.start();
      await vi.advanceTimersByTimeAsync(17_750);
      await loop.stop();

      expect(h.gateway.status).toHaveBeenCalledTimes(7);
      expect(delays()).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
      expect(h.logger.warn.mock.calls).toEqual(
        [refused, timedOut, missing, refused].map((error) => [{ error: serializeError(error) }, 'Reverse projector cycle failed']),
      );
      expect(h.logger.info.mock.calls).toEqual([['Reverse projector cycle recovered after 5 failed cycles']]);
      expect(h.logger.error).not.toHaveBeenCalled();
    });
  });

  it('starts the next cycle at once after a cycle with backlog, then backs off when that one is idle', async () => {
    await withTimers(async (delays) => {
      // Each of the first two cycles applies one page that is not complete, its one page of the cycle; the third reads the empty rest.
      const pages = { [`identity|${CURSOR_START}`]: accounts([10], 11, CURSOR_START), 'identity|10:1': accounts([20], 30, '10:1') };
      const h = harness({ owners: fakeOwners({ pages }) });
      const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

      loop.start();
      await vi.advanceTimersByTimeAsync(idlePollMs * 2);
      await loop.stop();

      expect(h.gateway.status).toHaveBeenCalledTimes(3);
      expect(delays()).toEqual([idlePollMs, 0, 0, idlePollMs * 2]);
      expect(h.owners.changes.filter((read) => read.owner === 'identity').map((read) => read.after)).toEqual([CURSOR_START, '10:1', '20:1']);
    });
  });

  it('stops the cycle in flight after its current batch, reading no further page', async () => {
    const pages = { [`identity|${CURSOR_START}`]: accounts([10], 100, CURSOR_START), 'identity|10:1': accounts([20], 100, '10:1', true) };
    const h = harness({ owners: fakeOwners({ pages }) });
    let committed: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hooks: ProjectorHooks = {
      afterLegacyCommit: async () => {
        committed();
        await released;
      },
    };
    const loop = createProjectorLoop(h.ctx, { hooks, startupGuard: refuseGuard });

    const cycle = loop.runOnce();
    await reached;
    const stopping = loop.stop();
    release();
    await stopping;

    const first = await cycle;
    expect(first).toMatchObject({ rowsApplied: 1, errors: [], backlog: true });
    // Every lane read its first page before the stop; none read a further one.
    expect([...h.owners.changes].sort((a, b) => a.owner.localeCompare(b.owner))).toEqual(
      [...config.dataOwners].sort().map((owner) => ({ owner, after: CURSOR_START })),
    );
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '10', cursor_seq: '1' });
    const second = await loop.runOnce();
    expect(second).toMatchObject({ rowsApplied: 1, backlog: false });
    expect(h.legacy.checkpoint('identity')).toMatchObject({ cursor_xid: '20', cursor_seq: '1' });
    // Identity's two batches, and each other owner's idle advance in whichever cycle its lane committed it.
    expect(first.batches + second.batches).toBe(2 + config.dataOwners.length - 1);
  });
});

describe('createProjectorLoop tracing', () => {
  const exporter = new MemorySpanExporter();
  /** `traceparent` of each request the owner double received. */
  const received: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    received.push(request.headers.traceparent as string | undefined);
    request.resume();
    response.end('ok');
  });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    await startTracing({ serviceName: 'reverse-projector-test', version: '1.0.0', exporter });
  });

  beforeEach(async () => {
    await flushTracing();
    exporter.reset();
    received.length = 0;
  });

  afterAll(async () => {
    await shutdownTracing();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A harness whose owners call the double over HTTP on every changes read and watermark write, as the real client does. */
  function tracedHarness(pages: OwnersOptions['pages'] = {}) {
    const h = harness({ owners: fakeOwners({ pages }) });
    const { changes, putWatermark } = h.owners.owners;
    const call = async (path: string): Promise<void> => {
      await (await fetch(`${base}${path}`)).text();
    };
    h.owners.owners.changes = async (owner, params) => {
      await call('/internal/v1/migration/changes');
      return changes(owner, params);
    };
    h.owners.owners.putWatermark = async (owner, record) => {
      await call('/internal/v1/migration/watermarks');
      return putWatermark(owner, record);
    };
    return h;
  }

  it('exports no span for an idle cycle, whose owner calls carry one unsampled trace', async () => {
    const h = tracedHarness();

    const result = await createProjectorLoop(h.ctx, { startupGuard: refuseGuard }).runOnce();
    await flushTracing();

    expect(result).toMatchObject({ ran: true, rowsApplied: 0, batches: config.dataOwners.length });
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(received).toHaveLength(config.dataOwners.length);
    expect(new Set(received.map((traceparent) => traceparent?.split('-')[3]))).toStrictEqual(new Set(['00']));
    expect(new Set(received.map((traceparent) => traceparent?.split('-')[1])).size).toBe(1);
  });

  it('exports a batch that applies rows as one root span linked to the cycle, with its calls as children', async () => {
    const pages = { [`people|${CURSOR_START}`]: page([person('Grace')], '101', CURSOR_START) };
    const h = tracedHarness(pages);

    const result = await createProjectorLoop(h.ctx, { startupGuard: refuseGuard }).runOnce();
    await flushTracing();
    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((span) => span.parentSpanContext === undefined);
    const cycleTrace = received[0]?.split('-')[1];

    expect(result).toMatchObject({ rowsApplied: 1, errors: [] });
    expect(roots.map((span) => span.name)).toStrictEqual(['projector.batch people']);
    expect(roots[0]?.links.map((link) => link.context.traceId)).toStrictEqual([cycleTrace]);
    expect(spans.filter((span) => span !== roots[0]).map((span) => [span.kind, span.parentSpanContext?.spanId])).toStrictEqual([
      [SpanKind.CLIENT, roots[0]?.spanContext().spanId],
    ]);
  });
});

describe('error logs', () => {
  /** Remote answer body the logged error must not carry. */
  const BODY = { detail: 'remote-body-marker' };
  /** Roster participant with no stream this cycle, so its fence failure is logged rather than failing streams. */
  const UNSTREAMED = 'unstreamed-owner';

  it.each<
    [site: string, error: Error, run: (error: Error) => Promise<ReturnType<typeof harness>['logger']>, fields: Record<string, unknown>, message: string, level: 'error' | 'warn']
  >([
    [
      'stream failure',
      new OwnerCallError('people', 'GET', '/internal/v1/migration/changes', 502, BODY),
      async (error) => {
        const h = harness();
        const changes = h.owners.owners.changes.bind(h.owners.owners);
        h.owners.owners.changes = async (owner, params) => (owner === 'people' ? Promise.reject(error) : changes(owner, params));
        await runProjectorCycle(h.ctx, cycleDeps());
        return h.logger;
      },
      { tenantId: TENANT },
      `Reverse projection of people for tenant ${TENANT} stopped at cursor ${CURSOR_START}`,
      'error',
    ],
    [
      'fence position failure',
      new OwnerCallError(UNSTREAMED as DataOwner, 'GET', '/internal/v1/migration/position', 503, BODY),
      async (error) => {
        const pages = { [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }) };
        const h = harness({ owners: fakeOwners({ pages }) });
        const position = h.owners.owners.position.bind(h.owners.owners);
        h.owners.owners.position = async (owner) => (owner === UNSTREAMED ? Promise.reject(error) : position(owner));
        const tracker = new OperationTracker({ participants: [...ROSTER_PARTICIPANTS, UNSTREAMED] });
        await runProjectorCycle(h.ctx, { ...cycleDeps(), tracker });
        return h.logger;
      },
      {},
      `Reading the write position of ${UNSTREAMED} for operation fences failed`,
      'error',
    ],
    [
      'background cycle failure',
      new GatewayCallError('cutoverStatus', 502, BODY),
      async (error) => {
        vi.useFakeTimers();
        try {
          const h = harness();
          h.gateway.status.mockRejectedValue(error);
          const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
          loop.start();
          await vi.advanceTimersByTimeAsync(config.projection.idlePollMs);
          await loop.stop();
          return h.logger;
        } finally {
          vi.useRealTimers();
        }
      },
      {},
      'Reverse projector cycle failed',
      'warn',
    ],
  ])('logs a %s with the serialized error record and no remote body', async (_site, error, run, fields, message, level) => {
    const logger = await run(error);
    const call = logger[level].mock.calls.find(([, text]) => text === message);
    expect(call?.[0]).toStrictEqual({ ...fields, error: serializeError(error) });
    expect(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls])).not.toContain(BODY.detail);
  });
});

describe('failure logs across cycles', () => {
  const UNSTREAMED = 'unstreamed-owner';

  it('logs a stream failure once while it lasts and again when its error changes, still reporting every failed cycle, and logs its resumption at INFO', async () => {
    const h = harness();
    const down = new Error('people down');
    const refused = new Error('people refused');
    const outcomes = [down, down, down, refused, null, down];
    const changes = h.owners.owners.changes.bind(h.owners.owners);
    let peopleReads = 0;
    h.owners.owners.changes = async (owner, params) => {
      if (owner !== 'people') return changes(owner, params);
      const failure = outcomes[peopleReads++] ?? null;
      return failure === null ? changes(owner, params) : Promise.reject(failure);
    };
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    const reported: string[][] = [];
    for (let cycle = 0; cycle < outcomes.length; cycle += 1) reported.push((await loop.runOnce()).errors.map((error) => error.error.message));

    expect(reported).toEqual([['people down'], ['people down'], ['people down'], ['people refused'], [], ['people down']]);
    const stopped = `Reverse projection of people for tenant ${TENANT} stopped at cursor ${CURSOR_START}`;
    expect(h.logger.error.mock.calls).toEqual([down, refused, down].map((error) => [{ tenantId: TENANT, error: serializeError(error) }, stopped]));
    expect(h.logger.info.mock.calls).toEqual([[{ tenantId: TENANT }, `Reverse projection of people for tenant ${TENANT} resumed at cursor ${CURSOR_START} after 4 failed cycles`]]);
  });

  it('forgets the failure of a stream whose tenant has left, so that its failure is logged again when it returns', async () => {
    const OTHER = tenantIdForSite('tenant-b');
    const sites = [SITE, 'tenant-b'];
    const h = harness({ legacy: fakeLegacy({ sites }) });
    const down = new Error('people down');
    const changes = h.owners.owners.changes.bind(h.owners.owners);
    h.owners.owners.changes = async (owner, params) => (owner === 'people' && params.tenantId === OTHER ? Promise.reject(down) : changes(owner, params));
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
    const stopped = `Reverse projection of people for tenant ${OTHER} stopped at cursor ${CURSOR_START}`;
    const logged = () => h.logger.error.mock.calls.filter(([, message]) => message === stopped).length;

    await loop.runOnce();
    await loop.runOnce();
    expect(logged()).toBe(1);
    sites.pop();
    expect((await loop.runOnce()).errors).toEqual([]);
    sites.push('tenant-b');
    await loop.runOnce();

    expect(logged()).toBe(2);
    expect(h.logger.info).not.toHaveBeenCalled();
  });

  it('counts one failed cycle for the checkpoint of a gone site failing twice in a cycle, and logs its resumption once it settles', async () => {
    const gone = tenantIdForSite('gone-site');
    const legacy = fakeLegacy();
    legacy.seed({
      owner: 'programs-sites',
      tenant_id: gone,
      cursor_xid: '50',
      cursor_seq: '1',
      applied_horizon: '51',
      batch_id: 'batch-old',
      rows_applied: 1,
      updated_at: null,
      pending_effects: JSON.stringify([{ kind: 'purgeCache', siteId: 'gone-site' }]),
      ready_horizon: null,
    });
    let broken = true;
    const h = harness({ legacy, db: fakeDb(true, (owner, tenantId) => broken && owner === 'programs-sites' && tenantId === gone) });
    const purgeCache = h.bridge.bridge.purgeCache.bind(h.bridge.bridge);
    h.bridge.bridge.purgeCache = (siteId) => (broken ? Promise.reject(new Error('bridge unavailable')) : purgeCache(siteId));
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    const failed = await loop.runOnce();
    broken = false;
    await loop.runOnce();

    expect(failed.errors.map((error) => [error.owner, error.tenantId, error.error.message])).toEqual([
      ['programs-sites', gone, 'bridge unavailable'],
      ['programs-sites', gone, 'mirror unavailable'],
    ]);
    expect(h.logger.error).toHaveBeenCalledTimes(2);
    expect(h.logger.info.mock.calls).toEqual([[{ tenantId: gone }, `Reverse projection of programs-sites for tenant ${gone} resumed at cursor 50:1 after 1 failed cycles`]]);
    expect(legacy.checkpoint('programs-sites', gone)).toMatchObject({ pending_effects: null });
  });

  it('logs a fence position failure of an owner without streams once while it lasts, and its recovery at INFO', async () => {
    const pages = { [`people|${CURSOR_START}`]: page([person('Grace', { operationId: OP })], '101', CURSOR_START, { [OP]: 'done' }) };
    const h = harness({ owners: fakeOwners({ pages }) });
    const unavailable = new Error('position unavailable');
    let failing = 2;
    const position = h.owners.owners.position.bind(h.owners.owners);
    h.owners.owners.position = async (owner) => (owner === UNSTREAMED && failing-- > 0 ? Promise.reject(unavailable) : position(owner));
    const deps: CycleDeps = {
      ...cycleDeps(),
      tracker: new OperationTracker({ participants: [...ROSTER_PARTICIPANTS, UNSTREAMED] }),
      memory: { mirrored: new Map(), failures: new Map(), fenceFailures: new Map(), scans: new Map() },
    };

    for (let cycle = 0; cycle < 3; cycle += 1) await runProjectorCycle(h.ctx, deps);

    const failed = `Reading the write position of ${UNSTREAMED} for operation fences failed`;
    expect(h.logger.error.mock.calls).toEqual([[{ error: serializeError(unavailable) }, failed]]);
    expect(h.logger.info.mock.calls).toEqual([[`Reading the write position of ${UNSTREAMED} for operation fences recovered after 2 failed cycles`]]);
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
