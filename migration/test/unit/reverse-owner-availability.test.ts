// Unit tests for the reverse projector while an owner is unavailable, over fakes of the legacy database, owners, gateway and migration pool.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CURSOR_START, encodeRow, type CanonicalColumn, type ChangesResponse, type OperationStatus, type ProjectedChangeRow } from '@opt2/platform/migration-kit';
import { SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { currentAuthority } from '../../src/cutover/index.js';
import type { CatalogColumn, TableCatalog } from '../../src/extract/index.js';
import { OwnerCallError, loadUnitCatalog } from '../../src/owners/index.js';
import { createAwaiter } from '../../src/reverse/await.js';
import { OperationTracker } from '../../src/reverse/operations.js';
import {
  PROJECTOR_LOCK_KEY,
  createProjectorLoop,
  runProjectorCycle,
  type ProjectorContext,
  type ProjectorHooks,
  type ProjectorLoop,
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

const SITES = ['tenant-a', 'tenant-b', 'tenant-c'];
const TENANTS = SITES.map(tenantIdForSite);
const [TENANT_A = '', TENANT_B = '', TENANT_C = ''] = TENANTS;
const OP = 'a0000000-0000-4000-8000-00000000000b';
const USER = 'A1B2C3D4-0000-0000-0000000000000002';
const CLIENT = 'C0FFEE00-0000-0000-0000000000000001';

function column(name: string): CatalogColumn {
  return { name, type: 's', sqlType: 'nvarchar', nullable: true, maxLength: null, precision: null, numericScale: null, ordinal: 1 };
}

function table(name: string, columns: string[], primaryKey: string[]): TableCatalog {
  return { database: 'muradb', schema: 'dbo', table: name, qualified: name, columns: columns.map(column), primaryKey, identityColumns: [], hasPrimaryKey: true };
}

Object.assign(catalogs, {
  toauthclients: table('toauthclients', ['clientid', 'siteid', 'name'], ['clientid']),
  tusers: table('tusers', ['UserID', 'SiteID', 'Fname', 'UserName', 'Type'], ['UserID']),
  tpermissions: table('tpermissions', ['ContentID', 'GroupID', 'SiteID', 'Type'], ['ContentID', 'GroupID', 'SiteID', 'Type']),
});

/** Each unit's legacy table and the columns its owner encodes images over, as its export declares them. */
const UNITS: Record<string, { legacyTable: string; columns: CanonicalColumn[] }> = {
  'identity.oauth_client': { legacyTable: 'toauthclients', columns: ['clientid', 'siteid', 'name'].map((name) => ({ name, type: 's' })) },
  'identity.user_account': { legacyTable: 'tusers', columns: ['UserID', 'UserName', 'SiteID'].map((name) => ({ name, type: 's' })) },
  'identity.permission': { legacyTable: 'tpermissions', columns: ['ContentID', 'GroupID', 'SiteID', 'Type'].map((name) => ({ name, type: 's' })) },
  'people.person': { legacyTable: 'tusers', columns: ['UserID', 'SiteID', 'Fname'].map((name) => ({ name, type: 's' })) },
};

// v9001 makes every group target-authoritative; v9002 every group without a people unit, so people has no stream.
const committedConfig = loadConfig();
const cutoverDir = mkdtempSync(path.join(os.tmpdir(), 'reverse-owner-availability-cutover-'));
mkdirSync(path.join(cutoverDir, 'versions'));
const groupsFile = path.join(cutoverDir, 'groups.json');
copyFileSync(committedConfig.paths.groupsFile, groupsFile);
const groups = (JSON.parse(readFileSync(groupsFile, 'utf8')) as { groups: { id: string; units: string[] }[] }).groups;
const writeVersion = (tableVersion: string, target: (units: string[]) => boolean): void => {
  const groupAuthority = Object.fromEntries(groups.map((group) => [group.id, target(group.units) ? 'target' : 'legacy']));
  writeFileSync(path.join(cutoverDir, 'versions', `${tableVersion}.json`), JSON.stringify({ tableVersion, groupAuthority, entries: [] }));
};
writeVersion('v9001', () => true);
writeVersion('v9002', (units) => !units.some((unit) => unit.startsWith('people.')));
const config = { ...committedConfig, paths: { ...committedConfig.paths, cutoverDir, groupsFile } };
const unitCatalog = loadUnitCatalog(config.paths.tableOwnership);
const { idlePollMs } = config.projection;
afterAll(() => rmSync(cutoverDir, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
});

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

/** Legacy database answering the projector's statements for the live sites; checkpoint upserts stage per transaction until commit. */
function fakeLegacy(sites: readonly string[] = SITES) {
  const committed = new Map<string, CheckpointRecord>();
  const statements: { tx: number | null; sql: string }[] = [];
  const commits = new Set<number>();
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
      pending_effects: params.pendingEffects as string | null,
      ready_horizon: null,
    };
    staged.set(key, record);
    return reply([record]);
  };

  const handle = (text: string, params: Record<string, unknown>, staged: Map<string, CheckpointRecord> | null) => {
    if (text.includes('sys.tables')) return reply([{ n: 1 }]);
    if (text.startsWith('SELECT DISTINCT SiteID')) return reply(sites.map((SiteID) => ({ SiteID })));
    if (text.startsWith('SELECT owner, tenant_id')) {
      const owners = Object.entries(params)
        .filter(([name]) => /^o\d+$/.test(name))
        .map(([, value]) => value);
      return reply([...committed.values()].filter((row) => owners.includes(row.owner)));
    }
    if (staged === null) throw new Error(`write outside a transaction: ${text}`);
    if (text.startsWith('UPDATE opt2_sync.projector_checkpoint')) return upsert(params, staged);
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
        statements.push({ tx: tx?.id ?? null, sql: text });
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
      const result = await fn({ request: () => request(state) } as never);
      for (const [key, value] of state.staged) committed.set(key, value);
      commits.add(state.id);
      return result;
    },
    close: async () => undefined,
  };
  return {
    legacy,
    checkpoint: (owner: string, tenantId: string) => committed.get(`${owner}|${tenantId}`),
    /** Statements of committed transactions matching `pattern`. */
    applied: (pattern: RegExp) => statements.filter((statement) => statement.tx !== null && commits.has(statement.tx) && pattern.test(statement.sql)),
  };
}

/** Migration pool answering the advisory lock, the `projector_cursor` mirror upsert and reads of an empty `projector_quarantine`. */
function fakeDb() {
  return {
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
            return { rows: [{ ok: true }] };
          }
          if (text.startsWith('INSERT INTO "migration"."projector_cursor"')) return { rows: [] };
          // Reads of `projector_quarantine`, which holds no change in this suite.
          if (text.startsWith('SELECT ') && text.includes('FROM "migration"."projector_quarantine"')) return { rows: [] };
          throw new Error(`unexpected PostgreSQL SQL: ${text}`);
        },
      };
      return fn(tx as never);
    },
    end: async () => undefined,
  };
}

function page(rows: ProjectedChangeRow[], horizon: string, after: string, operations: Record<string, OperationStatus> = {}): ChangesResponse {
  const last = rows.at(-1);
  return { rows, cursor: last === undefined ? after : `${last.xid}:${last.seq}`, horizon, complete: true, operations };
}

interface OwnersScript {
  /** Pages by `<owner>|<tenantId>|<after>`, each a page or one per read numbered from 1; other reads answer an empty page at `horizon()`. */
  pages?: Record<string, ChangesResponse | ((read: number) => ChangesResponse)>;
  /** Horizon of the empty pages; 200 when unset. */
  horizon?: () => string;
  /** The outcome of every call to each owner listed, by owner. */
  down?: Map<string, () => Promise<never>>;
}

/** Owners answering change feeds, exports, positions and watermarks, recording every call that reaches them. */
function fakeOwners({ pages = {}, horizon = () => '200', down = new Map() }: OwnersScript = {}) {
  const calls: { owner: string; method: string }[] = [];
  const reads = new Map<string, number>();
  const reach = async (owner: string, method: string): Promise<void> => {
    calls.push({ owner, method });
    await down.get(owner)?.();
  };
  const owners = {
    async changes(owner: string, params: { tenantId: string; after: string }) {
      await reach(owner, 'changes');
      const key = `${owner}|${params.tenantId}|${params.after}`;
      const read = (reads.get(key) ?? 0) + 1;
      reads.set(key, read);
      const source = pages[key];
      if (source === undefined) return page([], horizon(), params.after);
      return typeof source === 'function' ? source(read) : source;
    },
    async *exportPages(owner: string, params: { unit: string; tenantId: string }) {
      await reach(owner, 'export');
      const unit = UNITS[params.unit];
      const tables = unit === undefined ? [] : [{ unit: params.unit, legacyTable: unit.legacyTable, targetTable: params.unit, keyless: false, columns: unit.columns, rows: [] }];
      yield { unit: params.unit, tenantId: params.tenantId, tables, next: null };
    },
    async position(owner: string) {
      await reach(owner, 'position');
      return { owner, position: '150', outbox: null, inbox: null };
    },
    async putWatermark(owner: string, record: unknown) {
      await reach(owner, 'putWatermark');
      return record;
    },
  };
  /** Calls that reached `owner`, of `method` when given. */
  const count = (owner: string, method?: string): number => calls.filter((call) => call.owner === owner && (method === undefined || call.method === method)).length;
  return { owners, count };
}

function harness(owners: ReturnType<typeof fakeOwners>, tableVersion = 'v9001', clock = { now: () => new Date(2026, 5, 30, 12, 0, 0) }) {
  const legacy = fakeLegacy();
  const noop = () => undefined;
  const logger = { level: 'info', fatal: noop, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: noop, trace: noop, child: noop, isLevelEnabled: () => true, flush: noop };
  const bridge = { siteRefresh: vi.fn(), purgeCache: vi.fn() };
  const gateway = { status: vi.fn(async () => ({ tableVersion, epoch: 1 })) };
  const ctx = {
    config,
    clock,
    logger,
    db: fakeDb(),
    legacy: legacy.legacy,
    bridge,
    catalog: unitCatalog,
    owners: owners.owners,
    gateway,
  } as unknown as ProjectorContext;
  return { ctx, legacy, logger };
}

const refuseGuard: StartupGuardRunner = { run: () => Promise.reject(new Error('the start-up guard must not run')) };

/** A changelog row of `unit` with its legacy projection. */
function changeRow(position: [xid: number, seq: number], unit: string, op: ProjectedChangeRow['op'], images: { before?: Record<string, unknown>; after?: Record<string, unknown> }, extra: Partial<ProjectedChangeRow> = {}): ProjectedChangeRow {
  const spec = UNITS[unit];
  if (spec === undefined) throw new Error(`no columns for ${unit}`);
  const encode = (image: Record<string, unknown> | undefined) => (image === undefined ? null : encodeRow(spec.columns, image));
  const changed = op === 'update' ? spec.columns.map((entry) => entry.name).filter((name) => images.before?.[name] !== images.after?.[name]) : [];
  return {
    xid: String(position[0]),
    seq: String(position[1]),
    table: unit.slice(unit.indexOf('.') + 1),
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
    legacy: [{ unit, legacyTable: spec.legacyTable, key: 'k', before: encode(images.before), after: encode(images.after), columns: changed }],
    ...extra,
  };
}

/** An identity OAuth client rename, a write of identity alone. */
const clientRename = (name: string, position: [number, number]) =>
  changeRow(position, 'identity.oauth_client', 'update', {
    before: { clientid: CLIENT, siteid: SITES[0], name: 'Old' },
    after: { clientid: CLIENT, siteid: SITES[0], name },
  });

const refused = new ServiceUnavailableError('people', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:20112'), { code: 'ECONNREFUSED' }));
const timedOut = new ServiceUnavailableError('people', Object.assign(new Error('call outlasted its bound'), { name: 'TimeoutError' }));

/** A call to a stopped owner: it fails once the service-call bound passes. */
const hang = (error: Error) => (): Promise<never> =>
  new Promise((_resolve, reject) => {
    setTimeout(() => reject(error), SERVICE_CALL_TIMEOUT_MS);
  });

const CLIENT_UPDATE = /^UPDATE \[dbo\]\.\[toauthclients\]/;

describe('reverse projection while an owner is unavailable', () => {
  it("calls the owner once a cycle, fails its other streams with that error unasked, and commits every other owner's checkpoints", async () => {
    vi.useFakeTimers();
    const owners = fakeOwners({
      pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: page([clientRename('Renamed', [150, 1])], '160', CURSOR_START) },
      down: new Map([['people', hang(timedOut)]]),
    });
    const h = harness(owners);

    const cycle = runProjectorCycle(h.ctx, { startupGuard: refuseGuard, tracker: new OperationTracker() });
    await vi.advanceTimersByTimeAsync(SERVICE_CALL_TIMEOUT_MS);
    const result = await cycle;

    expect(owners.count('people')).toBe(1);
    expect(result.errors.map((error) => [error.owner, error.tenantId, error.error === timedOut])).toEqual(TENANTS.map((tenant) => ['people', tenant, true]));
    expect(h.legacy.applied(CLIENT_UPDATE)).toHaveLength(1);
    // Identity's lane reads tenant A afresh while the owner's call hangs, and that empty page advances it past the batch's 160.
    expect(TENANTS.map((tenant) => h.legacy.checkpoint('identity', tenant)?.applied_horizon)).toEqual(['200', '200', '200']);
    expect(h.legacy.checkpoint('programs-sites', TENANT_C)).toMatchObject({ applied_horizon: '200' });
    expect(TENANTS.map((tenant) => h.legacy.checkpoint('people', tenant))).toEqual([undefined, undefined, undefined]);
    expect(h.logger.error).toHaveBeenCalledTimes(TENANTS.length);

    // Without a loop's memory, the next cycle calls the owner again, once.
    const next = runProjectorCycle(h.ctx, { startupGuard: refuseGuard, tracker: new OperationTracker() });
    await vi.advanceTimersByTimeAsync(SERVICE_CALL_TIMEOUT_MS);
    await next;
    expect(owners.count('people')).toBe(2);
  });

  it('calls the owner no more in the next cycle of the loop, which projects an identity write that an await of identity then finds applied', async () => {
    vi.useFakeTimers();
    let horizon = '200';
    const owners = fakeOwners({
      pages: {
        [`identity|${TENANT_A}|${CURSOR_START}`]: (read) => (read === 1 ? page([], '200', CURSOR_START) : page([clientRename('Renamed', [250, 1])], '300', CURSOR_START)),
      },
      horizon: () => horizon,
      down: new Map([['people', hang(timedOut)]]),
    });
    const h = harness(owners);
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    const first = loop.runOnce();
    await vi.advanceTimersByTimeAsync(SERVICE_CALL_TIMEOUT_MS);
    await first;
    // The cycle that found the owner unavailable is followed by no probe.
    expect(owners.count('people')).toBe(1);

    // Identity commits xid 250 in tenant A; settled with no timer advanced, no call of the next cycle waits on the stopped owner.
    horizon = '300';
    const second = await loop.runOnce();
    expect(owners.count('people', 'changes')).toBe(1);
    expect(second.errors.map((error) => [error.owner, error.error === timedOut])).toEqual(TENANTS.map(() => ['people', true]));
    expect(h.legacy.applied(CLIENT_UPDATE)).toHaveLength(1);
    expect(h.legacy.checkpoint('identity', TENANT_A)).toMatchObject({ cursor_xid: '250', cursor_seq: '1', applied_horizon: '300' });
    const awaiter = createAwaiter({
      legacy: h.ctx.legacy,
      owners: h.ctx.owners,
      catalog: unitCatalog,
      authority: ({ timeoutMs }) => currentAuthority({ gateway: h.ctx.gateway, config: config.paths, timeoutMs }),
      tenants: async () => loop.lastTenants() ?? [],
      quarantined: () => Promise.resolve([]),
      clock: h.ctx.clock,
      defaults: { timeoutMs: config.projection.defaultAwaitTimeoutMs, pollIntervalMs: idlePollMs },
    });
    const awaited = await awaiter.awaitProjection({ positions: new Map([['identity', '250']]) });
    expect(awaited.positions).toEqual(new Map([['identity', '250']]));
    // The cycle that skipped the owner is followed by one probe of its position, outside the cycle.
    expect(owners.count('people', 'position')).toBe(1);
    await loop.stop();
  });

  it('wakes the loop once its probe of the owner answers, reads the owner again and logs its streams resuming', async () => {
    vi.useFakeTimers();
    const down = new Map([['people', () => Promise.reject(refused)]]);
    const owners = fakeOwners({ down });
    const h = harness(owners);
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    loop.start();
    await vi.advanceTimersByTimeAsync(idlePollMs);
    expect(owners.count('people')).toBe(1);
    down.clear();
    // The idle cycle backs off to twice the base interval; its probe answers and starts the next cycle at once.
    await vi.advanceTimersByTimeAsync(idlePollMs * 2);
    await vi.advanceTimersByTimeAsync(1);
    await loop.stop();

    expect(owners.count('people', 'position')).toBe(1);
    expect(owners.count('people', 'changes')).toBe(1 + TENANTS.length);
    expect(h.logger.info).toHaveBeenCalledWith('Owner people answers again; reverse projection resumes calling it');
    for (const tenant of TENANTS) {
      expect(h.logger.info).toHaveBeenCalledWith({ tenantId: tenant }, `Reverse projection of people for tenant ${tenant} resumed at cursor ${CURSOR_START} after 2 failed cycles`);
      expect(h.legacy.checkpoint('people', tenant)).toMatchObject({ applied_horizon: '200' });
    }
  });

  it.each<[string, () => Error, boolean]>([
    ['an OwnerCallError 502', () => new OwnerCallError('people', 'GET', '/internal/v1/migration/changes', 502, {}), true],
    ['an OwnerCallError 503', () => new OwnerCallError('people', 'GET', '/internal/v1/migration/changes', 503, {}), true],
    ['an OwnerCallError 504', () => new OwnerCallError('people', 'GET', '/internal/v1/migration/changes', 504, {}), true],
    ['an OwnerCallError 500', () => new OwnerCallError('people', 'GET', '/internal/v1/migration/changes', 500, {}), false],
    ['a plain Error', () => new Error('people down'), false],
  ])('with %s, skips the owner in the next cycle exactly when the error means it is unavailable', async (_label, makeError, unavailable) => {
    const error = makeError();
    const owners = fakeOwners({ down: new Map([['people', () => Promise.reject(error)]]) });
    const h = harness(owners);
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    const cycles = [await loop.runOnce(), await loop.runOnce()];
    await loop.stop();

    for (const result of cycles) {
      expect(result.errors.map((failure) => [failure.owner, failure.tenantId, failure.error === error])).toEqual(TENANTS.map((tenant) => ['people', tenant, true]));
    }
    expect(owners.count('people', 'changes')).toBe(unavailable ? 1 : 2 * TENANTS.length);
    expect(owners.count('people', 'position')).toBe(unavailable ? 1 : 0);
  });

  it('fails an identity split-table batch needing a people part at once while people is known unavailable', async () => {
    const accountUpdate = changeRow([110, 1], 'identity.user_account', 'update', {
      before: { UserID: USER, UserName: 'ada', SiteID: SITES[0] },
      after: { UserID: USER, UserName: 'grace', SiteID: SITES[0] },
    });
    const owners = fakeOwners({
      pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: page([accountUpdate], '111', CURSOR_START) },
      down: new Map([['people', () => Promise.reject(refused)]]),
    });
    const h = harness(owners);
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    const cycles = [await loop.runOnce(), await loop.runOnce()];
    await loop.stop();

    for (const result of cycles) {
      const failures = result.errors.map((failure) => [failure.owner, failure.tenantId, failure.error === refused]);
      expect(failures).toHaveLength(1 + TENANTS.length);
      expect(failures).toEqual(expect.arrayContaining([['identity', TENANT_A, true], ...TENANTS.map((tenant) => ['people', tenant, true])]));
    }
    // People's own lane finds it unavailable first; identity's part export then fails at once, and nothing else reaches people.
    expect(owners.count('people', 'export')).toBe(0);
    expect(owners.count('people', 'changes')).toBe(1);
    expect(h.legacy.applied(/^UPDATE \[dbo\]\.\[tusers\]/)).toEqual([]);
    expect(h.legacy.checkpoint('identity', TENANT_A)).toBeUndefined();
    expect(h.legacy.checkpoint('identity', TENANT_B)).toMatchObject({ applied_horizon: '200' });
  });

  it('probes an owner without streams, found unavailable reading an operation fence, until it answers, then reads its fence again', async () => {
    const permission = { ContentID: '00000000000000000000000000000001', GroupID: 'G1', SiteID: SITES[0], Type: 'module' };
    const down = new Map([['people', () => Promise.reject(refused)]]);
    const owners = fakeOwners({
      pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: page([changeRow([120, 1], 'identity.permission', 'delete', { before: permission }, { operationId: OP })], '121', CURSOR_START, { [OP]: 'done' }) },
      down,
    });
    const h = harness(owners, 'v9002');
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
    const probed = async (count: number): Promise<void> => {
      await vi.waitFor(() => {
        expect(owners.count('people', 'position')).toBe(count);
      });
    };

    await loop.runOnce();
    expect(owners.count('people')).toBe(1);
    await loop.runOnce();
    await probed(2);
    // Let the failed probe settle before the owner answers again.
    await new Promise((resolve) => setImmediate(resolve));
    down.clear();
    await loop.runOnce();
    await probed(3);
    await vi.waitFor(() => {
      expect(h.logger.info).toHaveBeenCalledWith('Owner people answers again; reverse projection resumes calling it');
    });
    await loop.runOnce();
    await loop.stop();

    expect(owners.count('people')).toBe(4);
    expect(h.logger.error.mock.calls.map(([, message]) => message)).toEqual(['Reading the write position of people for operation fences failed']);
    expect(h.logger.info).toHaveBeenCalledWith('Reading the write position of people for operation fences recovered after 3 failed cycles');
  });

  it('starts no probe after stop, and ignores the answer of a probe in flight when it stopped', async () => {
    const probe = { calls: 0, answer: (): void => undefined };
    const owners = fakeOwners({ down: new Map([['people', () => Promise.reject(refused)]]) });
    const h = harness(owners);
    owners.owners.position = async (owner) => {
      probe.calls += 1;
      await new Promise<void>((resolve) => {
        probe.answer = resolve;
      });
      return { owner, position: '150', outbox: null, inbox: null };
    };
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });

    await loop.runOnce();
    await loop.runOnce();
    expect(probe.calls).toBe(1);
    await loop.stop();
    probe.answer();
    await new Promise((resolve) => setImmediate(resolve));
    await loop.runOnce();

    expect(probe.calls).toBe(1);
    expect(owners.count('people', 'changes')).toBe(1);
    expect(h.logger.info).not.toHaveBeenCalledWith('Owner people answers again; reverse projection resumes calling it');
  });
});

describe('owner lanes of a cycle whose first call to an owner hangs', () => {
  const { defaultAwaitTimeoutMs } = config.projection;

  /** An awaiter of the loop's projection with the gateway's budget, timed and polling on the (fake) global timers. */
  function awaiterOf(h: ReturnType<typeof harness>, loop: ProjectorLoop) {
    return createAwaiter({
      legacy: h.ctx.legacy,
      owners: h.ctx.owners,
      catalog: unitCatalog,
      authority: ({ timeoutMs }) => currentAuthority({ gateway: h.ctx.gateway, config: config.paths, timeoutMs }),
      tenants: () => Promise.resolve(loop.lastTenants() ?? []),
      quarantined: () => Promise.resolve([]),
      clock: h.ctx.clock,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      defaults: { timeoutMs: defaultAwaitTimeoutMs, pollIntervalMs: idlePollMs },
    });
  }

  /** Every call that reached any data owner. */
  const allCalls = (owners: ReturnType<typeof fakeOwners>): number => config.dataOwners.reduce((sum, owner) => sum + owners.count(owner), 0);

  /** Counts the legacy batch transactions `h` opens, and the most open at once; each yields a turn before it runs. */
  function countTransactions(h: ReturnType<typeof harness>) {
    const { legacy } = h.ctx;
    const transaction = legacy.transaction.bind(legacy);
    const counts = { opened: 0, open: 0, most: 0 };
    legacy.transaction = async (fn) => {
      counts.opened += 1;
      counts.open += 1;
      counts.most = Math.max(counts.most, counts.open);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await transaction(fn);
      } finally {
        counts.open -= 1;
      }
    };
    return counts;
  }

  it.each<[string, string[]]>([
    ['identity', ['identity']],
    ['identity and an owner after the hung one', ['identity', 'strategies-content']],
  ])("applies a write of %s committed before the cycle within the barrier's budget while the cycle's first call to people hangs", async (_label, awaited) => {
    vi.useFakeTimers();
    const owners = fakeOwners({
      pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: page([clientRename('Renamed', [150, 1])], '160', CURSOR_START) },
      down: new Map([['people', hang(timedOut)]]),
    });
    const h = harness(owners, 'v9001', { now: () => new Date() });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
    let settled = false;
    const cycle = loop.runOnce().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);

    const answer = awaiterOf(h, loop)
      .awaitProjection({ positions: new Map(awaited.map((owner) => [owner, '150'])) })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(defaultAwaitTimeoutMs);
    const result = await answer;

    expect(result).toMatchObject({ positions: new Map(awaited.map((owner) => [owner, '150'])) });
    expect((result as { waitedMs: number }).waitedMs).toBeLessThan(defaultAwaitTimeoutMs);
    expect(settled).toBe(false);
    expect(h.legacy.applied(CLIENT_UPDATE)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SERVICE_CALL_TIMEOUT_MS);
    expect((await cycle).errors.map((error) => [error.owner, error.error === timedOut])).toEqual(TENANTS.map(() => ['people', true]));
    await loop.stop();
    expect(owners.count('people')).toBe(1);
  });

  it("projects an identity write committed while the cycle's first call to people hangs within two poll intervals, so its await resolves", async () => {
    vi.useFakeTimers();
    let horizon = '200';
    const owners = fakeOwners({
      pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: () => (horizon === '200' ? page([], '200', CURSOR_START) : page([clientRename('Renamed', [250, 1])], '300', CURSOR_START)) },
      horizon: () => horizon,
      down: new Map([['people', hang(timedOut)]]),
    });
    const h = harness(owners, 'v9001', { now: () => new Date() });
    const loop = createProjectorLoop(h.ctx, { startupGuard: refuseGuard });
    let settled = false;
    const cycle = loop.runOnce().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(TENANTS.map((tenant) => h.legacy.checkpoint('identity', tenant)?.applied_horizon)).toEqual(['200', '200', '200']);

    // Identity commits xid 250 in tenant A while the cycle still waits on people.
    horizon = '300';
    const answer = awaiterOf(h, loop)
      .awaitProjection({ positions: new Map([['identity', '250']]) })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(idlePollMs * 3);
    const result = await answer;

    expect(result).toMatchObject({ positions: new Map([['identity', '250']]) });
    expect((result as { waitedMs: number }).waitedMs).toBeLessThanOrEqual(idlePollMs * 2);
    expect(settled).toBe(false);
    expect(h.legacy.applied(CLIENT_UPDATE)).toHaveLength(1);
    expect(h.legacy.checkpoint('identity', TENANT_A)).toMatchObject({ cursor_xid: '250', cursor_seq: '1', applied_horizon: '300' });
    await vi.advanceTimersByTimeAsync(SERVICE_CALL_TIMEOUT_MS);
    await cycle;
    await loop.stop();
    expect(owners.count('people')).toBe(1);
  });

  it("rejects with a hook's throw only once every lane has settled, the one waiting on people included, and calls no owner after", async () => {
    vi.useFakeTimers();
    const lost = new Error('process lost');
    const owners = fakeOwners({
      pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: page([clientRename('Renamed', [150, 1])], '160', CURSOR_START) },
      down: new Map([['people', hang(timedOut)]]),
    });
    const h = harness(owners);
    const hooks: ProjectorHooks = { afterLegacyCommit: ({ owner }) => (owner === 'identity' ? Promise.reject(lost) : Promise.resolve()) };
    let outcome: unknown;
    const cycle = runProjectorCycle(h.ctx, { hooks, startupGuard: refuseGuard, tracker: new OperationTracker() }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    void cycle.then((value) => {
      outcome = value;
    });

    await vi.advanceTimersByTimeAsync(SERVICE_CALL_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await cycle).toBe(lost);
    const calls = allCalls(owners);
    await vi.advanceTimersByTimeAsync(idlePollMs * 4);
    expect(allCalls(owners)).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds one SQL Server batch transaction open at a time while every lane commits', async () => {
    const owners = fakeOwners({ pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: page([clientRename('Renamed', [150, 1])], '160', CURSOR_START) } });
    const h = harness(owners);
    const counts = countTransactions(h);

    const result = await runProjectorCycle(h.ctx, { startupGuard: refuseGuard, tracker: new OperationTracker() });

    // Identity's batch and idle advance, and every other owner's idle advance.
    expect(result).toMatchObject({ batches: config.dataOwners.length + 1, rowsApplied: 1, errors: [] });
    expect(counts).toMatchObject({ opened: result.batches, most: 1 });
  });

  it("runs beforeFirstBatch once, and every lane's first batch waits for it to finish", async () => {
    const owners = fakeOwners({ pages: { [`identity|${TENANT_A}|${CURSOR_START}`]: page([clientRename('Renamed', [150, 1])], '160', CURSOR_START) } });
    const h = harness(owners);
    const counts = countTransactions(h);
    let release = (): void => undefined;
    const beforeFirstBatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const cycle = runProjectorCycle(h.ctx, { hooks: { beforeFirstBatch }, startupGuard: refuseGuard, tracker: new OperationTracker() });
    await vi.waitFor(() => {
      expect(owners.count('people', 'changes')).toBe(TENANTS.length);
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(beforeFirstBatch).toHaveBeenCalledTimes(1);
    expect(counts.opened).toBe(0);
    release();

    expect(await cycle).toMatchObject({ batches: config.dataOwners.length + 1, errors: [] });
    expect(beforeFirstBatch).toHaveBeenCalledTimes(1);
    expect(counts.opened).toBe(config.dataOwners.length + 1);
  });
});
