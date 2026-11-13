// Unit tests for the reverse projector cycle and loop over fakes of the legacy database, owners, bridge, gateway and migration pool.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { GatewayCallError } from '../../src/cutover/gateway-client.js';
import { currentAuthority } from '../../src/cutover/index.js';
import type { CatalogColumn, TableCatalog } from '../../src/extract/index.js';
import { BridgeError, Opt2SyncUnavailableError, STARTUP_COUNT_SQL } from '../../src/legacy/index.js';
import { OwnerCallError, loadUnitCatalog, type DataOwner } from '../../src/owners/index.js';
import type { LegacyEffect } from '../../src/reverse/apply-legacy.js';
import { ProjectionTimeoutError, createAwaiter } from '../../src/reverse/await.js';
import { createProjector } from '../../src/reverse/index.js';
import { OperationTracker, ROSTER_PARTICIPANTS } from '../../src/reverse/operations.js';
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
    const record: CheckpointRecord = {
      owner: String(params.owner),
      tenant_id: String(params.tenantId),
      cursor_xid: String(params.cursorXid),
      cursor_seq: String(params.cursorSeq),
      applied_horizon: previous !== undefined && BigInt(previous.applied_horizon) > BigInt(horizon) ? previous.applied_horizon : horizon,
      batch_id: String(params.batchId),
      rows_applied: Number(params.rowsApplied),
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
    const opened = (inserted?.tx ?? 0) - 1;
    expect(owners.exports.filter((call) => call.keys !== undefined)).toEqual(
      otherTusersTargets.map((target) => ({ owner: target.owner, unit: target.unit, keys: [userKey(USER)], opened })),
    );
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
      expect(h.logger.error.mock.lastCall).toMatchObject([{ error: { type: 'Opt2SyncUnavailableError' } }, 'Reverse projector cycle failed']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('error logs', () => {
  /** Remote answer body the logged error must not carry. */
  const BODY = { detail: 'remote-body-marker' };
  /** Roster participant with no stream this cycle, so its fence failure is logged rather than failing streams. */
  const UNSTREAMED = 'unstreamed-owner';

  it.each<[site: string, error: Error, run: (error: Error) => Promise<ReturnType<typeof harness>['logger']>, fields: Record<string, unknown>, message: string]>([
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
    ],
  ])('logs a %s with the serialized error record and no remote body', async (_site, error, run, fields, message) => {
    const logger = await run(error);
    const call = logger.error.mock.calls.find(([, text]) => text === message);
    expect(call?.[0]).toStrictEqual({ ...fields, error: serializeError(error) });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(BODY.detail);
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
