/** Continuous reverse projector: owners' target changelogs into the live legacy tables, checkpointed in the batch's SQL Server transaction. */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { serializeError } from '@opt2/platform/logging';
import {
  CURSOR_START,
  commitOrder,
  compareXid,
  decodeRow,
  encodeRow,
  formatCanonicalTimestamp,
  formatCursor,
  parseCursor,
  qualified,
  type CanonicalColumn,
  type CanonicalValue,
  type ChangesResponse,
  type ProjectedChangeRow,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { SpanKind, startLinkedRootSpan, withUnsampledTrace } from '@opt2/platform/tracing';
import type { Transaction } from 'mssql';

import { ownerByName, ownerBySchema } from '../config.js';
import type { MigrationContext } from '../context.js';
import { currentAuthority, type CurrentAuthority } from '../cutover/index.js';
import { readTableCatalog, type TableCatalog } from '../extract/index.js';
import { BridgeError, Opt2SyncUnavailableError, countStartupRows, opt2SyncReady, type LegacyDb } from '../legacy/index.js';
import type { DataOwner, LegacyTableTarget, Unit } from '../owners/index.js';

import {
  applyLegacyChange,
  cancellableQuery,
  clearPendingEffects,
  decodeLegacyChange,
  liveSiteOf,
  readCheckpoints,
  summarise,
  upsertCheckpoint,
  type ApplyLegacyOptions,
  type ApplySummary,
  type CheckpointRow,
  type LegacyChange,
  type LegacyEffect,
  type RequestScope,
} from './apply-legacy.js';
import { bindAttachmentContent } from './attachments.js';
import { FILE_OBJECT_UNIT, executeFileOps, isFileObjectChange, planFileOps } from './files.js';
import {
  HeldSpanChangedError,
  OperationTracker,
  classifyRow,
  compareCursors,
  cursorOf,
  readHorizon,
  releasedRows,
  splitAtHold,
  type FenceRequest,
  type ParkedPart,
  type ReadyOperation,
  type ReadyPart,
  type RowDisposition,
  type StreamScan,
} from './operations.js';

/** Advisory lock key (`'opt2revp'`) electing the one projecting instance; bound as `$1::bigint` text. */
export const PROJECTOR_LOCK_KEY = 0x6f70743272657670n;

/** A change of an operation about to be written in a batch's open SQL Server transaction. */
export interface OperationChangePoint {
  batchId: string;
  operationId: string;
  /** Owner of the change. */
  owner: string;
  /** Owners whose changes of this operation the batch transaction has already written. */
  written: readonly string[];
}

/** Fault points of a projector cycle and its batches; each defaults to a no-op, and a throw from any aborts the whole cycle. */
export interface ProjectorHooks {
  /** Runs once per cycle, before its first batch touches the legacy file store or database. */
  beforeFirstBatch?(): Promise<void>;
  /** Runs inside the batch's SQL Server transaction before each change carrying an operation id; a throw rolls the batch back. */
  beforeOperationChange?(info: OperationChangePoint): Promise<void>;
  /** Runs after a batch's SQL Server commit and before its checkpoint mirror. */
  afterLegacyCommit?(info: { owner: string; tenantId: string; batchId: string }): Promise<void>;
}

/** Commits a batch inside the start-up guard sequence: freeze legacy-bound entries, `commit`, reload window, unfreeze. */
export interface StartupGuardRunner {
  /** Resolves once `commit` has committed under the freeze; the reload window and unfreeze continue without the caller. */
  run(commit: () => Promise<void>): Promise<unknown>;
}

/** A stream stopped for the cycle; the next cycle resumes it from its SQL Server checkpoint. */
export interface StreamError {
  owner: string;
  tenantId: string;
  /** Checkpoint cursor the stream stopped at. */
  cursor: string;
  error: Error;
}

/** Outcome of one projector cycle. */
export interface CycleResult {
  /** False when another instance holds the projector lock. */
  leader: boolean;
  /** True when some unit was `target`-authoritative and the streams were read. */
  ran: boolean;
  /** SQL Server batch transactions committed. */
  batches: number;
  /** Legacy changes written. */
  rowsApplied: number;
  /** Rows passed over: origins legacy already holds, units not `target`-authoritative, rolled-back operations, target-only tables. */
  skipped: number;
  /** Rows parked at multi-participant operations. */
  held: number;
  files: { put: number; deleted: number };
  errors: StreamError[];
  /** True when a stream neither failed nor parked ended without a complete page, or a running stream's read-ahead stopped short of its bound. */
  backlog: boolean;
}

/** Context members a cycle uses. */
export type ProjectorContext = Pick<
  MigrationContext,
  'config' | 'clock' | 'logger' | 'db' | 'legacy' | 'bridge' | 'catalog' | 'owners' | 'gateway'
>;

/** What a loop keeps of its streams across cycles. */
export interface StreamMemory {
  /** Cursor and applied horizon each stream's checkpoint was last mirrored at, by stream. */
  mirrored: Map<string, string>;
  /** Failures of the streams still failing, by stream; each is logged once per change of its error. */
  failures: Map<string, FailureState>;
  /** Failures of operation-fence position reads of owners without streams, by owner; logged as stream failures are. */
  fenceFailures: Map<string, FailureState>;
  /** Scans running past their streams' checkpoints, by stream; a cycle resumes each from where an earlier one left it. */
  scans: Map<string, SavedScan>;
}

/** A stream scan kept across cycles, with the active version its rows were classified under. */
export interface SavedScan {
  tableVersion: string | null;
  scan: StreamScan;
}

/** Collaborators of one cycle; the tracker outlives cycles because the fences of done operations stay valid. */
export interface CycleDeps {
  hooks?: ProjectorHooks;
  startupGuard: StartupGuardRunner;
  tracker: OperationTracker;
  /** Receives the tenant set each leading cycle reads from the live `tsettings`. */
  onTenants?(tenants: readonly string[]): void;
  /** Stops the cycle at its next turn, read-ahead page, span re-read page or settle round; a batch in progress completes. */
  signal?: AbortSignal;
  /** The loop's memory of its streams; without it, no stored checkpoint is mirrored again, every failure is logged and scans last one cycle. */
  memory?: StreamMemory;
}

/** Options of {@link createProjectorLoop}. */
export interface ProjectorLoopOptions {
  hooks?: ProjectorHooks;
  startupGuard: StartupGuardRunner;
}

/** The projector's cycle schedule and the tenant set it streams. */
export interface ProjectorLoop {
  /**
   * Runs cycles until `stop`; each next cycle starts once the previous one settles: at once after a backlog, after
   * `idlePollMs` after an active cycle or while a demand is held, else after an idle delay doubling up to `idleMaxPollMs`.
   */
  start(): void;
  /** Cancels the schedule, stops the cycle in flight at its next turn, and waits for it. */
  stop(): Promise<void>;
  /** Runs one cycle now, or joins the one in flight. */
  runOnce(): Promise<CycleResult>;
  /** Holds the base cadence until the returned release runs; on a started loop the next cycle starts at once. */
  demand(): () => void;
  /** Tenants of the last cycle that read the live `tsettings`; null before the first. */
  lastTenants(): readonly string[] | null;
}

const LOCK_SQL = 'SELECT pg_try_advisory_xact_lock($1::bigint) AS ok';
const LIVE_SITES_SQL = 'SELECT DISTINCT SiteID FROM dbo.tsettings WHERE SiteID IS NOT NULL';
const MIRROR_TABLE = 'projector_cursor';
const SETTINGS_TABLE = 'tsettings';
const FILES_TABLE = 'tfiles';
/** Schema of strategies-content, whose `content.file_object` manifest the file store follows. */
const CONTENT_SCHEMA = FILE_OBJECT_UNIT.slice(0, FILE_OBJECT_UNIT.indexOf('.'));
/** Legacy keys per owner export request: the `maxItems` of the export's `keys` parameter. */
const EXPORT_KEYS_PER_REQUEST = 100;

/** One owner's changelog in one tenant, as far as this cycle has read it. */
interface Stream {
  readonly owner: DataOwner;
  readonly tenantId: string;
  /** Cursor of the committed SQL Server checkpoint. */
  checkpoint: string;
  /** Applied horizon of the committed SQL Server checkpoint; undefined while none is stored. */
  storedHorizon: string | undefined;
  /** Horizon past the stored one of a page that consumed no row, committed with the cycle's other idle advances unless a batch supersedes it. */
  idleHorizon: string | undefined;
  /** Horizon of the first page read this cycle; no turn reads after a checkpoint at or past it. */
  frontier: string | undefined;
  /** True when the stream's last turn read a complete page. */
  complete: boolean;
  /** Turns taken this cycle, at most `projection.streamPagesPerCycle`. */
  turns: number;
  /** Read-ahead pages read this cycle, at most `projection.streamPagesPerCycle`. */
  aheadPages: number;
  /** True when the stream's last read-ahead stopped before passing its bound. */
  aheadBehind: boolean;
  /** Operation the stream is parked at. */
  parkedAt: string | undefined;
  failed: boolean;
  /** Effects its committed SQL Server checkpoint still owes legacy. */
  pendingEffects: LegacyEffect[];
}

/** Read state of a stream before its first read of a cycle. */
const UNREAD = {
  idleHorizon: undefined,
  frontier: undefined,
  complete: false,
  turns: 0,
  aheadPages: 0,
  aheadBehind: false,
  parkedAt: undefined,
  failed: false,
} as const satisfies Omit<Stream, 'owner' | 'tenantId' | 'checkpoint' | 'storedHorizon' | 'pendingEffects'>;

/** A stream's rows of one batch and the checkpoint the batch commits for it. */
interface BatchPart {
  stream: Stream;
  rows: readonly ProjectedChangeRow[];
  endCursor: string;
  appliedHorizon: string;
}

/** A batch part decoded into legacy changes, file-store rows and rows with no legacy form. */
interface DecodedPart extends BatchPart {
  changes: LegacyChange[];
  /** The changelog row of each change, index for index. */
  sources: ProjectedChangeRow[];
  fileRows: ProjectedChangeRow[];
  targetOnly: number;
}

/** A hook's throw, carried past stream error handling to abort the cycle. */
class HookFailure extends Error {
  override readonly name = 'HookFailure';

  constructor(readonly original: unknown) {
    super('A projector hook failed', { cause: original });
  }
}

/** Rolls a batch transaction back when rows would still match Masa's start-up predicate at commit. */
class StartupRowsPending extends Error {
  override readonly name = 'StartupRowsPending';

  constructor(readonly count: number) {
    super(`${String(count)} tcontent rows match the start-up predicate`);
  }
}

async function callHook(run: () => Promise<void> | undefined): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw new HookFailure(error);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A failure kept across cycles: its error's type and message, and the cycles it has lasted. */
export interface FailureState {
  signature: string;
  cycles: number;
}

/** The type and message that tell one failure from another. */
function failureSignature(error: unknown): string {
  const err = toError(error);
  return JSON.stringify([serializeError(err).type, err.message]);
}

/**
 * Keeps `error` as the failure of `key`, counting a cycle unless `sameCycle`; true when it is to be logged: no failures
 * are kept, `key` had none, or its error changed.
 */
function noteFailure(failures: Map<string, FailureState> | undefined, key: string, error: unknown, sameCycle = false): boolean {
  if (failures === undefined) return true;
  const signature = failureSignature(error);
  const kept = failures.get(key);
  failures.set(key, { signature, cycles: kept === undefined ? 1 : kept.cycles + (sameCycle ? 0 : 1) });
  return kept?.signature !== signature;
}

function streamKey(owner: string, tenantId: string): string {
  return JSON.stringify([owner, tenantId.toLowerCase()]);
}

function cursorOfCheckpoint(row: Pick<CheckpointRow, 'cursorXid' | 'cursorSeq'>): string {
  return formatCursor({ xid: BigInt(row.cursorXid), seq: BigInt(row.cursorSeq) });
}

/** What the mirror holds of a checkpoint: its cursor and applied horizon. */
function mirrorStateOf(row: CheckpointRow): string {
  return `${cursorOfCheckpoint(row)}@${row.appliedHorizon}`;
}

function byPosition(a: { xid: string; seq: string }, b: { xid: string; seq: string }): number {
  const xid = compareXid(a.xid, b.xid);
  if (xid !== 0) return xid;
  const left = BigInt(a.seq);
  const right = BigInt(b.seq);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `items` in `(xid, seq)` order, except that the rows of one legacy row of one stream follow seq, its commit order. */
function inApplyOrder<T>(items: readonly T[], rowOf: (item: T) => ProjectedChangeRow, streamOf: (item: T) => Stream): T[] {
  const ordered = [...items].sort((a, b) => byPosition(rowOf(a), rowOf(b)));
  return commitOrder(ordered, rowOf, (item) => streamKey(streamOf(item).owner, streamOf(item).tenantId));
}

/** The effects of every list once each, in first-seen order with site refreshes before cache purges. */
function mergeEffects(lists: readonly (readonly LegacyEffect[])[]): LegacyEffect[] {
  const unique = new Map<string, LegacyEffect>();
  for (const effect of lists.flat()) unique.set(JSON.stringify([effect.kind, effect.siteId]), effect);
  const all = [...unique.values()];
  return [...all.filter((effect) => effect.kind === 'siteRefresh'), ...all.filter((effect) => effect.kind === 'purgeCache')];
}

/** The bridge's 404 for a site the registry does not hold, such as a deleted one; its caches left the registry with it. */
function isUnregisteredSite(error: unknown): boolean {
  if (!(error instanceof BridgeError) || error.status !== 404 || typeof error.body !== 'object' || error.body === null) return false;
  const body = error.body as { error?: unknown; message?: unknown };
  return body.error === 'notFound' && body.message === 'unregistered site';
}

function isDboTable(change: LegacyChange, table: string): boolean {
  return change.physicalTable.schema.toLowerCase() === 'dbo' && change.physicalTable.table.toLowerCase() === table;
}

/** Value of column `name` in an image, matched case-insensitively as SQL Server resolves names. */
function valueAt(image: Readonly<Record<string, CanonicalValue>>, name: string): CanonicalValue | undefined {
  if (Object.hasOwn(image, name)) return image[name];
  const lower = name.toLowerCase();
  const found = Object.keys(image).find((key) => key.toLowerCase() === lower);
  return found === undefined ? undefined : image[found];
}

/** Lookup form of a legacy table name: `Program_<id>` folded, no `dbo.`, lower case. */
function genericTable(catalog: Pick<ProjectorContext['catalog'], 'foldProgramTable'>, name: string): string {
  return catalog.foldProgramTable(name).legacyTable.replace(/^dbo\./i, '').toLowerCase();
}

/** Comparison text of an image's legacy key. */
function keyText(columns: readonly string[], image: Readonly<Record<string, CanonicalValue>>): string {
  return JSON.stringify(
    columns.map((name) => {
      const value = valueAt(image, name);
      if (value === undefined || value === null) return null;
      return Buffer.isBuffer(value) ? `b${value.toString('hex')}` : `s${value}`;
    }),
  );
}

/**
 * Legacy site of each tenant, from the live `tsettings` site ids; the first site in order wins when two fold to one tenant.
 * Site ids keep their spelling, without the trailing spaces SQL Server ignores; `signal` cancels the read.
 */
export async function liveTenantSites(legacy: Pick<LegacyDb, 'live'>, options: { signal?: AbortSignal } = {}): Promise<Map<string, string>> {
  const pool = await legacy.live();
  const result = await cancellableQuery<{ SiteID: string }>(pool.request(), LIVE_SITES_SQL, options.signal);
  const sites = result.recordset
    .map((row) => row.SiteID.replace(/ +$/, ''))
    .filter((site) => site !== '')
    .sort();
  const tenants = new Map<string, string>();
  for (const site of sites) {
    const tenantId = tenantIdForSite(site);
    if (!tenants.has(tenantId)) tenants.set(tenantId, site);
  }
  return tenants;
}

/** The change's after-image key as owners' export rows encode it: its key columns in ownership order, typed as its images. */
function exportKey(keyColumns: readonly string[], change: LegacyChange): string {
  const image = change.after ?? {};
  const columns = keyColumns.map((name): CanonicalColumn => {
    const lower = name.toLowerCase();
    const column = change.columns.find((candidate) => candidate.name.toLowerCase() === lower);
    if (column === undefined) throw new Error(`Images of ${change.unit} carry no key column ${name} of ${change.legacyTable}`);
    return { ...column, name };
  });
  return encodeRow(columns, Object.fromEntries(keyColumns.map((name) => [name, valueAt(image, name) ?? null])));
}

/** Identity of one other unit's parts in the change's tenant and program. */
function partsId(unit: string, change: LegacyChange): string {
  return JSON.stringify([unit, change.tenantId, change.programId ?? null]);
}

/** The keys a batch needs of one other unit in one tenant and program. */
interface PartsRequest {
  readonly target: LegacyTableTarget;
  /** A change of the request's tenant, program and legacy table. */
  readonly change: LegacyChange;
  readonly keyColumns: readonly string[];
  /** Export key encodings by key text. */
  readonly keys: Map<string, string>;
}

/** Other owners' legacy images of a batch's split-table rows, fetched by legacy key before the batch transaction opens. */
class OtherParts {
  readonly #ctx: Pick<ProjectorContext, 'catalog' | 'owners'>;
  /** Images by parts identity, then by requested key text; a requested key without rows holds none. */
  readonly #indexes = new Map<string, Map<string, Record<string, CanonicalValue>[]>>();

  constructor(ctx: Pick<ProjectorContext, 'catalog' | 'owners'>) {
    this.#ctx = ctx;
  }

  /** Fetches the other units' parts of every split-table change that may insert its after-image; deletes never merge parts. */
  async preload(changes: readonly LegacyChange[]): Promise<void> {
    const { catalog } = this.#ctx;
    const wanted = new Map<string, PartsRequest>();
    for (const change of changes) {
      if (change.after === undefined || !catalog.isSplit(change.legacyTable)) continue;
      const keyColumns = catalog.keyColumnsOf(change.legacyTable);
      if (keyColumns.length === 0) continue;
      const text = keyText(keyColumns, change.after);
      const encoded = exportKey(keyColumns, change);
      for (const target of catalog.unitsForLegacyTable(change.legacyTable)) {
        if (target.unit === change.unit) continue;
        const id = partsId(target.unit, change);
        const request = wanted.get(id) ?? { target, change, keyColumns, keys: new Map<string, string>() };
        request.keys.set(text, encoded);
        wanted.set(id, request);
      }
    }
    for (const [id, request] of wanted) this.#indexes.set(id, await this.#load(request));
  }

  /** Every other unit's preloaded values for the change's legacy key, in ownership-file order. */
  fetch(change: LegacyChange): Record<string, CanonicalValue>[] {
    const { catalog } = this.#ctx;
    const keyColumns = catalog.keyColumnsOf(change.legacyTable);
    if (keyColumns.length === 0) return [];
    const key = keyText(keyColumns, change.after ?? change.before ?? {});
    const parts: Record<string, CanonicalValue>[] = [];
    for (const target of catalog.unitsForLegacyTable(change.legacyTable)) {
      if (target.unit === change.unit) continue;
      const images = this.#indexes.get(partsId(target.unit, change))?.get(key);
      if (images === undefined) throw new Error(`Parts of ${target.unit} for ${change.legacyTable} were not fetched before the batch transaction`);
      parts.push(...images);
    }
    return parts;
  }

  /** The request's keys from the unit's owner, in chunks the export accepts, keeping only the requested keys' rows. */
  async #load({ target, change, keyColumns, keys }: PartsRequest): Promise<Map<string, Record<string, CanonicalValue>[]>> {
    const { catalog, owners } = this.#ctx;
    const generic = genericTable(catalog, change.legacyTable);
    const index = new Map([...keys.keys()].map((key): [string, Record<string, CanonicalValue>[]] => [key, []]));
    const encoded = [...keys.values()];
    for (let from = 0; from < encoded.length; from += EXPORT_KEYS_PER_REQUEST) {
      const params = {
        unit: target.unit,
        tenantId: change.tenantId,
        ...(change.programId === undefined ? {} : { programId: change.programId }),
        keys: encoded.slice(from, from + EXPORT_KEYS_PER_REQUEST),
      };
      for await (const page of owners.exportPages(target.owner, params)) {
        for (const table of page.tables) {
          if (table.unit !== target.unit || genericTable(catalog, table.legacyTable) !== generic) continue;
          for (const row of table.rows) {
            const values = decodeRow(table.columns, row.row);
            index.get(keyText(keyColumns, values))?.push(values);
          }
        }
      }
    }
    return index;
  }
}

/** Site ids compared as SQL Server's default collation compares them: case-insensitive, trailing spaces ignored. */
function sameSite(site: string, other: CanonicalValue | undefined): boolean {
  return typeof other === 'string' && site.replace(/ +$/, '').toLowerCase() === other.replace(/ +$/, '').toLowerCase();
}

/** True when the change's owner still exports a row with the change's after-image key in the change's own tenant. */
async function tenantHoldsKey(ctx: Pick<ProjectorContext, 'catalog' | 'owners'>, change: LegacyChange, keyColumns: readonly string[]): Promise<boolean> {
  const { catalog, owners } = ctx;
  const generic = genericTable(catalog, change.legacyTable);
  const wanted = keyText(keyColumns, change.after ?? {});
  const params = {
    unit: change.unit,
    tenantId: change.tenantId,
    ...(change.programId === undefined ? {} : { programId: change.programId }),
    keys: [exportKey(keyColumns, change)],
  };
  for await (const page of owners.exportPages(catalog.ownerOf(change.unit), params)) {
    for (const table of page.tables) {
      if (table.unit !== change.unit || genericTable(catalog, table.legacyTable) !== generic) continue;
      if (table.rows.some((row) => keyText(keyColumns, decodeRow(table.columns, row.row)) === wanted)) return true;
    }
  }
  return false;
}

/**
 * Inserts of the batch whose key moved on to another tenant: legacy holds the key under another site, and the change's
 * own tenant no longer exports it. Read before the batch transaction opens.
 */
async function supersededInserts(
  ctx: Pick<ProjectorContext, 'catalog' | 'owners'>,
  pool: RequestScope,
  changes: readonly LegacyChange[],
  catalogs: ReadonlyMap<string, TableCatalog>,
): Promise<Set<LegacyChange>> {
  const { catalog } = ctx;
  const superseded = new Set<LegacyChange>();
  for (const change of changes) {
    const after = change.op === 'insert' ? change.after : undefined;
    const siteColumn = after === undefined ? null : catalog.siteColumnOf(change.legacyTable);
    if (after === undefined || siteColumn === null) continue;
    const keyColumns = catalog.keyColumnsOf(change.legacyTable);
    // Read for every physical table of the batch before this runs.
    const tableCatalog = catalogs.get(change.physicalTable.qualified.toLowerCase()) as TableCatalog;
    // A keyless row is inserted as a new occurrence, which no move supersedes.
    if (keyColumns.length === 0 || !tableCatalog.hasPrimaryKey) continue;
    const site = await liveSiteOf(pool, change, { tableCatalog, keyColumns, siteColumn });
    if (site === null || sameSite(site, valueAt(after, siteColumn))) continue;
    if (!(await tenantHoldsKey(ctx, change, keyColumns))) superseded.add(change);
  }
  return superseded;
}

/** One leading cycle's streams over the owners of `target`-authoritative units and every live tenant. */
class ProjectorCycle {
  readonly #ctx: ProjectorContext;
  readonly #deps: CycleDeps;
  readonly #authority: CurrentAuthority;
  readonly #tenantSites: ReadonlyMap<string, string>;
  readonly #result: CycleResult;
  readonly #streams = new Map<string, Stream>();
  readonly #classifiers = new Map<string, (row: ProjectedChangeRow) => RowDisposition>();
  readonly #schemas = new Map<string, string>();
  readonly #columns = new Map<string, Promise<readonly CanonicalColumn[]>>();
  readonly #units: ReadonlySet<string>;
  readonly #contentOwner: string;
  /** `content.file_object` rows are `content.file` data, written in the gated transactions of the unit fed by `tfiles`. */
  readonly #filesProjected: boolean;
  /** Owners whose position read failed this cycle. */
  readonly #unfenced = new Set<string>();
  /** Streams that completed a turn this cycle, or settled what they owed without one. */
  readonly #progressed = new Set<Stream>();
  /** Streams standing for checkpoints this cycle does not read, by stream. */
  readonly #standIns = new Map<string, Stream>();
  /** True once the cycle's first batch has called `beforeFirstBatch`. */
  #batched = false;

  constructor(
    ctx: ProjectorContext,
    deps: CycleDeps,
    authority: CurrentAuthority,
    tenantSites: ReadonlyMap<string, string>,
    result: CycleResult,
  ) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.#authority = authority;
    this.#tenantSites = tenantSites;
    this.#result = result;
    this.#units = new Set(ctx.catalog.units().map((unit) => unit.id));
    this.#contentOwner = ownerBySchema(ctx.config, CONTENT_SCHEMA).name;
    const feedsFiles = (unit: Unit): boolean => unit.legacyTables.some((table) => genericTable(ctx.catalog, table) === FILES_TABLE);
    this.#filesProjected = ctx.catalog.unitsOfOwner(this.#contentOwner).some((unit) => feedsFiles(unit) && authority.isTargetAuthoritative(unit.id));
  }

  /**
   * Runs effects earlier batches owe and mirrors checkpoints the mirror lacks, then gives every stream page turns from its
   * checkpoint up to its frontier or turn budget, settles parked operations until nothing progresses, and commits the idle advances.
   */
  async run(): Promise<void> {
    const projected = new Set([...this.#authority.targetUnits].map((unit) => this.#ctx.catalog.ownerOf(unit)));
    const owners = this.#ctx.config.dataOwners.filter((owner) => projected.has(owner));
    const checkpoints = await readCheckpoints(await this.#ctx.legacy.live(), { owners });
    const stored = new Map(checkpoints.map((row) => [streamKey(row.owner, row.tenantId), row]));
    for (const owner of owners) {
      for (const tenantId of this.#tenantSites.keys()) {
        const row = stored.get(streamKey(owner, tenantId));
        const checkpoint = row === undefined ? CURSOR_START : cursorOfCheckpoint(row);
        const pendingEffects = row?.pendingEffects ?? [];
        this.#streams.set(streamKey(owner, tenantId), { owner, tenantId, checkpoint, storedHorizon: row?.appliedHorizon, ...UNREAD, pendingEffects });
      }
    }
    // A stream the cycle neither reads nor holds a checkpoint of has gone, and its failure with it.
    const failures = this.#deps.memory?.failures;
    if (failures !== undefined) {
      for (const key of failures.keys()) if (!this.#streams.has(key) && !stored.has(key)) failures.delete(key);
    }
    this.#restoreScans();
    try {
      await this.#recoverEffects(checkpoints);
      await this.#catchUpMirror(checkpoints);
      await this.#runTurns([...this.#streams.values()]);
      await this.#settleOperations();
      await this.#advanceIdle();
      const behind = (stream: Stream): boolean => stream.aheadBehind || (stream.parkedAt === undefined && !stream.complete);
      this.#result.backlog = [...this.#streams.values()].some((stream) => !stream.failed && behind(stream));
      this.#noteRecoveries();
    } finally {
      this.#saveScans();
      this.#deps.tracker.clear();
    }
  }

  /** Takes over the saved scans of streams still at the checkpoint they were read after, under the same version; drops the rest. */
  #restoreScans(): void {
    const scans = this.#deps.memory?.scans;
    if (scans === undefined) return;
    for (const [key, { tableVersion, scan }] of scans) {
      const stream = this.#streams.get(key);
      if (stream?.checkpoint === scan.start && tableVersion === this.#authority.tableVersion) this.#deps.tracker.restoreScan(scan);
    }
    scans.clear();
  }

  /** Keeps for the next cycle each stream's scan that runs past the stream's checkpoint, such as a parked or read-ahead stream's. */
  #saveScans(): void {
    const scans = this.#deps.memory?.scans;
    if (scans === undefined) return;
    for (const [key, stream] of this.#streams) {
      const scan = this.#deps.tracker.savedScan(stream.owner, stream.tenantId);
      if (scan?.start === stream.checkpoint && scan.end !== scan.start) scans.set(key, { tableVersion: this.#authority.tableVersion, scan });
    }
  }

  #schemaOf(owner: string): string {
    let schema = this.#schemas.get(owner);
    if (schema === undefined) {
      schema = ownerByName(this.#ctx.config, owner).schema;
      this.#schemas.set(owner, schema);
    }
    return schema;
  }

  /** Unit id of a changelog row: the owner's schema and the row's target table. */
  #unitOf(owner: string, row: Pick<ProjectedChangeRow, 'table'>): string {
    return `${this.#schemaOf(owner)}.${row.table}`;
  }

  #isTargetRow(owner: string, row: ProjectedChangeRow): boolean {
    const unit = this.#unitOf(owner, row);
    if (isFileObjectChange(row, unit)) return this.#filesProjected;
    return this.#units.has(unit) && this.#authority.isTargetAuthoritative(unit);
  }

  #classifier(owner: string): (row: ProjectedChangeRow) => RowDisposition {
    let classify = this.#classifiers.get(owner);
    if (classify === undefined) {
      const { tracker } = this.#deps;
      const deps = { isTargetUnit: (row: ProjectedChangeRow) => this.#isTargetRow(owner, row), statusOf: (id: string) => tracker.statusOf(id) };
      classify = (row) => classifyRow(row, deps);
      this.#classifiers.set(owner, classify);
    }
    return classify;
  }

  /** Reads one page after `after` and notes its operation statuses and scan with the tracker. */
  async #readPage(stream: Stream, after: string): Promise<ChangesResponse> {
    const { tracker } = this.#deps;
    const page = await this.#ctx.owners.changes(stream.owner, {
      tenantId: stream.tenantId,
      after,
      limit: this.#ctx.config.projection.batchRows,
    });
    tracker.noteStatuses(page.operations, stream.owner);
    tracker.noteScan(stream.owner, stream.tenantId, after, page, this.#classifier(stream.owner));
    stream.frontier ??= page.horizon;
    return page;
  }

  #stopped(): boolean {
    return this.#deps.signal?.aborted === true;
  }

  /** True when the stream's last turn read a complete page, or its checkpoint has passed every row below its frontier. */
  #caughtUp(stream: Stream): boolean {
    if (stream.complete) return true;
    return stream.frontier !== undefined && compareXid(parseCursor(stream.checkpoint).xid, stream.frontier) >= 0;
  }

  /** True when the stream is neither failed, parked nor caught up, and has turns of its cycle budget left. */
  #due(stream: Stream): boolean {
    const budgetLeft = stream.turns < this.#ctx.config.projection.streamPagesPerCycle;
    return !stream.failed && stream.parkedAt === undefined && budgetLeft && !this.#caughtUp(stream);
  }

  /** Gives each due stream one page per round, in order, until none is due or the cycle is stopped. */
  async #runTurns(streams: readonly Stream[]): Promise<void> {
    for (let due = streams.filter((stream) => this.#due(stream)); due.length > 0; due = due.filter((stream) => this.#due(stream))) {
      for (const stream of due) {
        if (this.#stopped()) return;
        await this.#turnSafely(stream);
      }
    }
  }

  /**
   * Projects one page after the stream's checkpoint, up to its first held row, and parks the stream at that operation;
   * a page that consumes no row only defers its horizon to the cycle's idle advances.
   */
  async #turn(stream: Stream): Promise<void> {
    stream.turns += 1;
    const classify = this.#classifier(stream.owner);
    const after = stream.checkpoint;
    const page = await this.#readPage(stream, after);
    if (page.rows.length === 0) {
      this.#deferIdle(stream, readHorizon(page));
      stream.complete = page.complete;
      return;
    }
    const split = splitAtHold(page, classify, after);
    if (split.applicable.length === 0 && split.skipped === 0) this.#deferIdle(stream, split.appliedHorizon);
    else await this.#project([{ stream, rows: split.applicable, endCursor: split.endCursor, appliedHorizon: split.appliedHorizon }]);
    this.#result.skipped += split.skipped;
    const { held } = split;
    if (held !== undefined) {
      this.#deps.tracker.park(stream.owner, stream.tenantId, held.operationId, held.rows, held);
      stream.parkedAt = held.operationId;
      this.#result.held += held.rows.length;
      return;
    }
    stream.complete = page.complete;
  }

  /** Keeps the horizon of a page that consumed no row for the idle advances when it passes the stored one, or none is stored. */
  #deferIdle(stream: Stream, horizon: string): void {
    if (stream.storedHorizon !== undefined && compareXid(horizon, stream.storedHorizon) <= 0) return;
    if (stream.idleHorizon === undefined || compareXid(horizon, stream.idleHorizon) > 0) stream.idleHorizon = horizon;
  }

  /** Commits the deferred idle advances of every stream still running in one batch, unless the cycle was stopped. */
  async #advanceIdle(): Promise<void> {
    if (this.#stopped()) return;
    const idle = [...this.#streams.values()].filter((stream) => !stream.failed && stream.idleHorizon !== undefined);
    if (idle.length === 0) return;
    // Filtered on a deferred horizon just above.
    const parts = idle.map((stream): BatchPart => ({ stream, rows: [], endCursor: stream.checkpoint, appliedHorizon: stream.idleHorizon as string }));
    try {
      await this.#project(parts);
    } catch (error) {
      this.#fail(idle, error);
    }
  }

  async #turnSafely(stream: Stream): Promise<void> {
    try {
      await this.#turn(stream);
      this.#progressed.add(stream);
    } catch (error) {
      this.#fail([stream], error);
    }
  }

  /**
   * Stops the streams for this cycle and reports the error, logging it when a stream was not failing or its error
   * changed; a hook's throw is rethrown to abort the cycle.
   */
  #fail(streams: readonly Stream[], error: unknown): void {
    if (error instanceof HookFailure) throw error;
    const err = toError(error);
    for (const stream of streams) {
      const sameCycle = stream.failed;
      stream.failed = true;
      this.#result.errors.push({ owner: stream.owner, tenantId: stream.tenantId, cursor: stream.checkpoint, error: err });
      if (!noteFailure(this.#deps.memory?.failures, streamKey(stream.owner, stream.tenantId), err, sameCycle)) continue;
      this.#ctx.logger.error(
        { tenantId: stream.tenantId, error: serializeError(err) },
        `Reverse projection of ${stream.owner} for tenant ${stream.tenantId} stopped at cursor ${stream.checkpoint}`,
      );
    }
  }

  /** Logs and forgets the kept failure of each stream that progressed this cycle without failing. */
  #noteRecoveries(): void {
    const failures = this.#deps.memory?.failures;
    if (failures === undefined) return;
    for (const stream of this.#progressed) {
      const key = streamKey(stream.owner, stream.tenantId);
      const kept = failures.get(key);
      if (stream.failed || kept === undefined) continue;
      failures.delete(key);
      this.#ctx.logger.info(
        { tenantId: stream.tenantId },
        `Reverse projection of ${stream.owner} for tenant ${stream.tenantId} resumed at cursor ${stream.checkpoint} after ${String(kept.cycles)} failed cycles`,
      );
    }
  }

  #streamOf(owner: string, tenantId: string): Stream | undefined {
    return this.#streams.get(streamKey(owner, tenantId));
  }

  #streamsOf(owner: string): Stream[] {
    return [...this.#streams.values()].filter((stream) => stream.owner === owner);
  }

  /**
   * Refreshes the statuses of kept held rows, then notes fences, reads fenced and waiting owners' streams ahead, re-runs
   * streams whose read-ahead reached a held row, then applies ready operations jointly and passes over rolled-back ones,
   * resuming their streams, until a round changes nothing or the cycle is stopped.
   */
  async #settleOperations(): Promise<void> {
    const { tracker } = this.#deps;
    await this.#refreshStatuses();
    while (!this.#stopped()) {
      const fenced = await this.#noteFences();
      const owners = new Set<string>(fenced);
      for (const waiting of tracker.waiting()) {
        if (waiting.status !== 'done') continue;
        for (const owner of [...waiting.incomplete, ...waiting.unproven]) owners.add(owner);
      }
      const dirty = await this.#readAhead(owners);
      let progressed = fenced.size > 0 || dirty.length > 0;
      await this.#resume(dirty);
      for (const operation of tracker.ready()) {
        if (this.#stopped()) return;
        progressed = (await this.#apply(operation)) || progressed;
      }
      for (const operation of tracker.rolledBack()) {
        if (this.#stopped()) return;
        const parts = this.#batchParts(operation.parts);
        if (parts === undefined) continue;
        // A part whose run earlier rows wait for keeps its checkpoint; the stream's re-run passes over those rows instead.
        const passedOver = operation.parts.filter((part, index) => part.streamState.endCursor !== (parts[index] as BatchPart).stream.checkpoint);
        const skipped = passedOver.reduce((sum, part) => sum + part.rows.length, 0);
        progressed = (await this.#release(operation.operationIds, parts, skipped)) || progressed;
      }
      if (!progressed) return;
    }
  }

  /** Reads one row per kept held row whose operation its owner has not reported this cycle; these reads are outside the read-ahead budget. */
  async #refreshStatuses(): Promise<void> {
    const { tracker } = this.#deps;
    for (const { owner, tenantId, after } of tracker.statusReads()) {
      const stream = this.#streamOf(owner, tenantId);
      if (this.#stopped() || stream === undefined || stream.failed) continue;
      try {
        const page = await this.#ctx.owners.changes(stream.owner, { tenantId, after, limit: 1 });
        tracker.noteStatuses(page.operations, owner);
      } catch (error) {
        this.#fail([stream], error);
      }
    }
  }

  /** Lets the streams take turns again from their checkpoints, up to their frontiers and within their turn budgets. */
  async #resume(streams: readonly Stream[]): Promise<void> {
    for (const stream of streams) {
      stream.complete = false;
      stream.aheadBehind = false;
    }
    await this.#runTurns(streams);
  }

  /** Reads each owner's position once for every fence the tracker needs of it; returns the owners fenced. */
  async #noteFences(): Promise<Set<string>> {
    const { tracker } = this.#deps;
    const byOwner = new Map<string, FenceRequest[]>();
    for (const request of tracker.fencesNeeded()) {
      if (this.#unfenced.has(request.owner)) continue;
      byOwner.set(request.owner, [...(byOwner.get(request.owner) ?? []), request]);
    }
    const fenced = new Set<string>();
    for (const [owner, requests] of byOwner) {
      try {
        // Fence owners are roster participants, each a data owner.
        const { position } = await this.#ctx.owners.position(owner as DataOwner);
        for (const request of requests) tracker.noteFence(request.operationId, owner, position);
        fenced.add(owner);
        this.#fenceRecovered(owner);
      } catch (error) {
        this.#unfenced.add(owner);
        const streams = this.#streamsOf(owner);
        if (streams.length > 0) this.#fail(streams, error);
        else if (noteFailure(this.#deps.memory?.fenceFailures, owner, error)) {
          this.#ctx.logger.error({ error: serializeError(error) }, `Reading the write position of ${owner} for operation fences failed`);
        }
      }
    }
    return fenced;
  }

  /** Logs and forgets a kept fence failure of the owner once its position is read again. */
  #fenceRecovered(owner: string): void {
    const fenceFailures = this.#deps.memory?.fenceFailures;
    const kept = fenceFailures?.get(owner);
    if (kept === undefined) return;
    fenceFailures?.delete(owner);
    this.#ctx.logger.info(`Reading the write position of ${owner} for operation fences recovered after ${String(kept.cycles)} failed cycles`);
  }

  /**
   * Extends the scans of the owners' streams, without projecting, until a complete page or until they pass the owner's
   * fence bound, else their frontier, reading at most `projection.streamPagesPerCycle` pages per stream and cycle; returns
   * the streams not parked whose read-ahead reached a held row, which must be re-run to park there.
   */
  async #readAhead(owners: ReadonlySet<string>): Promise<Stream[]> {
    const { tracker } = this.#deps;
    const budget = this.#ctx.config.projection.streamPagesPerCycle;
    const dirty: Stream[] = [];
    const bounds = new Map([...owners].map((owner) => [owner, tracker.fenceBound(owner)]));
    for (const stream of this.#streams.values()) {
      if (stream.failed || !owners.has(stream.owner)) continue;
      const classify = this.#classifier(stream.owner);
      const fence = bounds.get(stream.owner);
      let reachedHold = false;
      stream.aheadBehind = false;
      try {
        for (let scan = tracker.scanOf(stream.owner, stream.tenantId); scan !== undefined && !this.#scanPassed(stream, scan, fence); ) {
          if (this.#stopped() || stream.aheadPages >= budget) {
            stream.aheadBehind = true;
            break;
          }
          stream.aheadPages += 1;
          const page = await this.#readPage(stream, scan.end);
          reachedHold ||= stream.parkedAt === undefined && page.rows.some((row) => classify(row) === 'hold');
          scan = page.complete ? undefined : tracker.scanOf(stream.owner, stream.tenantId);
        }
      } catch (error) {
        this.#fail([stream], error);
        continue;
      }
      if (reachedHold) dirty.push(stream);
    }
    return dirty;
  }

  /** True when the scan has read every row at or below `fence`, or without a fence every row below the stream's frontier. */
  #scanPassed(stream: Stream, scan: Readonly<StreamScan>, fence: string | undefined): boolean {
    // Every stream still running took a turn this cycle, and its first read set the frontier.
    const frontier = stream.frontier as string;
    return fence === undefined ? compareXid(scan.horizon, frontier) >= 0 : compareXid(scan.horizon, fence) > 0;
  }

  /** Batch parts without rows checkpointing each part's stream at its span or held run end; undefined when a part's stream has stopped. */
  #batchParts(parts: readonly (ParkedPart | ReadyPart)[]): BatchPart[] | undefined {
    const streams = parts.map((part) => this.#streamOf(part.owner, part.tenantId));
    if (streams.some((stream) => stream === undefined || stream.failed)) return undefined;
    return parts.map(({ streamState }, index): BatchPart => ({
      stream: streams[index] as Stream,
      rows: [],
      endCursor: streamState.endCursor,
      appliedHorizon: streamState.appliedHorizon,
    }));
  }

  /** Applies a ready operation from its parts' re-read spans; false when a stream stopped, a re-read failed or the cycle stopped. */
  async #apply(operation: ReadyOperation): Promise<boolean> {
    const parts = this.#batchParts(operation.parts);
    if (parts === undefined) return false;
    const rows: ProjectedChangeRow[][] = [];
    for (const [index, part] of operation.parts.entries()) {
      const { stream } = parts[index] as BatchPart;
      try {
        const span = await this.#reread(stream, part);
        if (span === undefined) return false;
        rows.push(span);
      } catch (error) {
        if (error instanceof HeldSpanChangedError) this.#deps.tracker.dropScan(stream.owner, stream.tenantId);
        this.#fail([stream], error);
        return false;
      }
    }
    return this.#release(
      operation.operationIds,
      parts.map((part, index) => ({ ...part, rows: rows[index] as ProjectedChangeRow[] })),
      0,
    );
  }

  /** A ready part's rows re-read after its stream's checkpoint through its end; undefined once the cycle stops; throws HeldSpanChangedError. */
  async #reread(stream: Stream, part: ReadyPart): Promise<ProjectedChangeRow[] | undefined> {
    const { tracker } = this.#deps;
    const { batchRows } = this.#ctx.config.projection;
    const end = part.streamState.endCursor;
    const rows: ProjectedChangeRow[] = [];
    for (let after = stream.checkpoint; ; ) {
      if (this.#stopped()) return undefined;
      const page = await this.#ctx.owners.changes(stream.owner, { tenantId: stream.tenantId, after, limit: batchRows });
      tracker.noteStatuses(page.operations, stream.owner);
      const within = page.rows.filter((row) => compareCursors(cursorOf(row), end) <= 0);
      rows.push(...within);
      if (page.complete || within.length < page.rows.length || page.rows.length === 0 || page.cursor === end) {
        return releasedRows(part, rows, this.#classifier(stream.owner));
      }
      after = page.cursor;
    }
  }

  /** Commits the parts with their checkpoints in one legacy transaction, counts `skipped`, releases and resumes; false when the batch failed. */
  async #release(operationIds: readonly string[], parts: readonly BatchPart[], skipped: number): Promise<boolean> {
    try {
      await this.#project(parts);
    } catch (error) {
      this.#fail(parts.map((part) => part.stream), error);
      return false;
    }
    this.#result.skipped += skipped;
    for (const id of operationIds) this.#deps.tracker.release(id);
    for (const part of parts) part.stream.parkedAt = undefined;
    await this.#resume(parts.map((part) => part.stream));
    return true;
  }

  /** Projects `parts` as one batch, recorded as its own linked root span when it carries rows; an empty one only advances checkpoints. */
  #project(parts: readonly BatchPart[]): Promise<void> {
    if (!parts.some((part) => part.rows.length > 0)) return this.#projectBatch(parts);
    const owners = [...new Set(parts.map((part) => part.stream.owner))].join(',');
    return startLinkedRootSpan(`projector.batch ${owners}`, SpanKind.INTERNAL, () => this.#projectBatch(parts));
  }

  /**
   * One batch: file-store operations first, since the bridge may read `tfiles` rows this batch's transaction would lock,
   * and the other owners' parts its split-table rows may merge; then every change in `(xid, seq)` order, the changes of
   * one row in seq order, an operation's after its `beforeOperationChange` hook, and every part's checkpoint, with the
   * site refreshes and cache purges it owes, in one SQL Server transaction; then the commit hooks, checkpoint mirrors,
   * owed effects and reverse watermarks.
   */
  async #projectBatch(parts: readonly BatchPart[]): Promise<void> {
    const { hooks } = this.#deps;
    const decoded: DecodedPart[] = [];
    for (const part of parts) decoded.push(await this.#decode(part));
    const sourced = decoded.flatMap((part) => part.changes.map((change, index) => ({ change, row: part.sources[index] as ProjectedChangeRow, part })));
    const changes = inApplyOrder(sourced, ({ row }) => row, ({ part }) => part.stream).map(({ change }) => change);
    const files = decoded.flatMap((part) => part.fileRows.map((row) => ({ row, part })));
    const fileOps = planFileOps(
      inApplyOrder(files, ({ row }) => row, ({ part }) => part.stream).map(({ row }) => row),
      this.#tenantSites,
    );

    if (!this.#batched) {
      this.#batched = true;
      await callHook(() => hooks?.beforeFirstBatch?.());
    }
    if (fileOps.length > 0) {
      const files = await executeFileOps({ ...this.#ctx, signal: this.#deps.signal }, fileOps);
      this.#result.files.put += files.put;
      this.#result.files.deleted += files.deleted;
    }

    const pool = await this.#ctx.legacy.live();
    const catalogs = new Map<string, TableCatalog>();
    for (const change of changes) {
      const key = change.physicalTable.qualified.toLowerCase();
      if (!catalogs.has(key)) catalogs.set(key, await readTableCatalog(pool, change.physicalTable));
    }
    const others = new OtherParts(this.#ctx);
    await others.preload(changes);
    const superseded = await supersededInserts(this.#ctx, pool, changes, catalogs);
    const batchId = randomUUID();
    const write = async (tx: Transaction): Promise<CheckpointRow[]> => {
      // Per call: the start-up guard may roll a first attempt back and write the batch again.
      const written = new Map<string, readonly string[]>();
      for (const change of changes) {
        const { operationId, owner } = change;
        if (operationId === undefined) {
          await applyLegacyChange(tx, change, this.#applyOptions(change, catalogs, others, superseded));
          continue;
        }
        const before = written.get(operationId) ?? [];
        await callHook(() => hooks?.beforeOperationChange?.({ batchId, operationId, owner, written: before }));
        await applyLegacyChange(tx, change, this.#applyOptions(change, catalogs, others, superseded));
        if (!before.includes(owner)) written.set(operationId, [...before, owner]);
      }
      const stored: CheckpointRow[] = [];
      for (const part of decoded) {
        const { xid, seq } = parseCursor(part.endCursor);
        stored.push(
          await upsertCheckpoint(tx, {
            owner: part.stream.owner,
            tenantId: part.stream.tenantId,
            cursorXid: xid.toString(),
            cursorSeq: seq.toString(),
            appliedHorizon: part.appliedHorizon,
            batchId,
            rowsApplied: part.changes.length,
            pendingEffects: mergeEffects([part.stream.pendingEffects, effects]),
          }),
        );
      }
      return stored;
    };

    const summary = summarise(changes);
    const effects = this.#effectsOf(decoded, summary);
    const { stored, guardError } = await this.#commit(write, summary.touchesTcontent);
    for (const [index, part] of decoded.entries()) {
      part.stream.checkpoint = part.endCursor;
      this.#deps.tracker.rebase(part.stream.owner, part.stream.tenantId, part.endCursor);
      part.stream.storedHorizon = stored[index]?.appliedHorizon ?? part.appliedHorizon;
      part.stream.idleHorizon = undefined;
      part.stream.pendingEffects = stored[index]?.pendingEffects ?? [];
    }
    this.#result.batches += 1;
    this.#result.rowsApplied += changes.length;
    this.#result.skipped += decoded.reduce((sum, part) => sum + part.targetOnly, 0);

    for (const part of decoded) {
      await callHook(() => hooks?.afterLegacyCommit?.({ owner: part.stream.owner, tenantId: part.stream.tenantId, batchId }));
    }
    await this.#mirror(stored);
    await this.#afterCommit(decoded, stored);
    if (guardError !== undefined) throw guardError;
  }

  /**
   * Splits a part's rows into legacy changes and file-store rows; rows whose table has no legacy form count as target-only.
   * Finance attachment and reporting export job changes carry their bytes, read from the owner before the batch transaction opens.
   */
  async #decode(part: BatchPart): Promise<DecodedPart> {
    const { owner, tenantId } = part.stream;
    const changes: LegacyChange[] = [];
    const sources: ProjectedChangeRow[] = [];
    const fileRows: ProjectedChangeRow[] = [];
    let targetOnly = 0;
    for (const row of part.rows) {
      const unit = this.#unitOf(owner, row);
      if (isFileObjectChange(row, unit)) {
        fileRows.push(row);
        continue;
      }
      const projection = row.legacy.find((entry) => entry.unit === unit);
      const columns = projection === undefined ? [] : await this.#legacyColumns(owner, tenantId, unit, projection.legacyTable);
      const change = decodeLegacyChange(row, { owner, tenantId, unit, columns });
      if (change === null) targetOnly += 1;
      else {
        changes.push(await bindAttachmentContent(this.#ctx, change));
        sources.push(row);
      }
    }
    return { ...part, changes, sources, fileRows, targetOnly };
  }

  /** The owner's encoding columns of the unit's legacy table: the changes feed carries none, so they come from its export. */
  #legacyColumns(owner: DataOwner, tenantId: string, unit: string, legacyTable: string): Promise<readonly CanonicalColumn[]> {
    const key = JSON.stringify([owner, unit, legacyTable.toLowerCase()]);
    let columns = this.#columns.get(key);
    if (columns === undefined) {
      columns = this.#exportColumns(owner, tenantId, unit, legacyTable);
      this.#columns.set(key, columns);
    }
    return columns;
  }

  async #exportColumns(owner: DataOwner, tenantId: string, unit: string, legacyTable: string): Promise<readonly CanonicalColumn[]> {
    const wanted = legacyTable.toLowerCase();
    for await (const page of this.#ctx.owners.exportPages(owner, { unit, tenantId, limit: 1 })) {
      const table = page.tables.find((entry) => entry.unit === unit && entry.legacyTable.toLowerCase() === wanted);
      if (table !== undefined) return table.columns;
    }
    throw new Error(`Owner ${owner} exports no columns of ${legacyTable} for unit ${unit}`);
  }

  #applyOptions(
    change: LegacyChange,
    catalogs: ReadonlyMap<string, TableCatalog>,
    others: OtherParts,
    superseded: ReadonlySet<LegacyChange>,
  ): ApplyLegacyOptions {
    const { catalog } = this.#ctx;
    const target = catalog.unitsForLegacyTable(change.legacyTable).find((entry) => entry.unit === change.unit);
    if (target === undefined) throw new Error(`Unit ${change.unit} takes no rows of legacy table ${change.legacyTable}`);
    const siteColumn = catalog.siteColumnOf(change.legacyTable);
    return {
      // Read for every physical table of the batch before the transaction opened.
      tableCatalog: catalogs.get(change.physicalTable.qualified.toLowerCase()) as TableCatalog,
      target,
      split: catalog.isSplit(change.legacyTable),
      ownedColumns: target.ownedColumns,
      keyColumns: catalog.keyColumnsOf(change.legacyTable),
      fetchOtherParts: (merged) => Promise.resolve(others.fetch(merged)),
      ...(siteColumn === null ? {} : { siteColumn }),
      supersededInsert: superseded.has(change),
    };
  }

  /**
   * Commits the batch, through the start-up guard when rows would match Masa's start-up predicate. The guarded batch is
   * rolled back first and re-applied by the guard's commit, so no projector lock is held while the freeze drains legacy
   * requests. The guard returns once that commit is made under the freeze, and its reload window, which awaits this
   * projector's later batches, runs on without it. A guard failure after its commit is returned, so the post-commit
   * steps still run.
   */
  async #commit(
    write: (tx: Transaction) => Promise<CheckpointRow[]>,
    touchesTcontent: boolean,
  ): Promise<{ stored: CheckpointRow[]; guardError?: unknown }> {
    const { legacy } = this.#ctx;
    if (!touchesTcontent) return { stored: await legacy.transaction(write) };
    try {
      const stored = await legacy.transaction(async (tx) => {
        const rows = await write(tx);
        const count = await countStartupRows(tx);
        if (count > 0) throw new StartupRowsPending(count);
        return rows;
      });
      return { stored };
    } catch (error) {
      if (!(error instanceof StartupRowsPending)) throw error;
    }
    const committed: { stored?: CheckpointRow[] } = {};
    try {
      await this.#deps.startupGuard.run(async () => {
        committed.stored = await legacy.transaction(write);
      });
    } catch (error) {
      if (committed.stored === undefined) throw error;
      return { stored: committed.stored, guardError: error };
    }
    if (committed.stored === undefined) throw new Error('The start-up guard returned without committing the batch');
    return { stored: committed.stored };
  }

  /** Copies committed checkpoints into `migration.projector_cursor`, the reporting mirror, in one transaction of its own. */
  async #mirror(rows: readonly CheckpointRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#ctx.db.withMetadata(async (tx) => {
      const table = qualified(tx.schema, MIRROR_TABLE);
      for (const row of rows) {
        await tx.query(
          `INSERT INTO ${table} (owner, tenant_id, cursor, applied_horizon, batches, updated_at)
           VALUES ($1, $2::uuid, $3, $4::numeric, 1, $5::timestamp(3))
           ON CONFLICT (owner, tenant_id) DO UPDATE
             SET cursor = EXCLUDED.cursor, applied_horizon = EXCLUDED.applied_horizon,
                 batches = ${table}.batches + 1, updated_at = EXCLUDED.updated_at`,
          [row.owner, row.tenantId, cursorOfCheckpoint(row), row.appliedHorizon, this.#ctx.clock.now()],
        );
      }
    });
    const mirrored = this.#deps.memory?.mirrored;
    for (const row of rows) mirrored?.set(streamKey(row.owner, row.tenantId), mirrorStateOf(row));
  }

  /** Mirrors the stored checkpoints the loop has not mirrored as they stand, such as a batch's after a crash before its mirror. */
  async #catchUpMirror(checkpoints: readonly CheckpointRow[]): Promise<void> {
    const mirrored = this.#deps.memory?.mirrored;
    if (mirrored === undefined) return;
    const stale = checkpoints.filter((row) => mirrored.get(streamKey(row.owner, row.tenantId)) !== mirrorStateOf(row));
    try {
      await this.#mirror(stale);
    } catch (error) {
      this.#fail(stale.map((row) => this.#streamOf(row.owner, row.tenantId) ?? this.#unstreamed(row)), error);
    }
  }

  /** Effects a batch owes legacy: site refreshes after `tsettings` changes, then purges of touched sites after content or site rows. */
  #effectsOf(parts: readonly DecodedPart[], summary: ApplySummary): LegacyEffect[] {
    const effects: LegacyEffect[] = [];
    if (summary.touchesTsettings) {
      const settings = summarise(parts.flatMap((part) => part.changes).filter((change) => isDboTable(change, SETTINGS_TABLE)));
      for (const siteId of settings.siteIds) effects.push({ kind: 'siteRefresh', siteId });
    }
    const touching = parts.filter((part) => part.changes.length > 0 || part.fileRows.length > 0);
    if (summary.touchesTsettings || touching.some((part) => part.stream.owner === this.#contentOwner)) {
      const sites = new Set(summary.siteIds);
      for (const part of touching) {
        const site = this.#tenantSites.get(part.stream.tenantId);
        if (site !== undefined) sites.add(site);
      }
      for (const siteId of sites) effects.push({ kind: 'purgeCache', siteId });
    }
    return effects;
  }

  /** Runs effects in order through the bridge; a failure propagates and leaves them owed, except a purge of an unregistered site. */
  async #runEffects(effects: readonly LegacyEffect[]): Promise<void> {
    const { bridge } = this.#ctx;
    for (const { kind, siteId } of effects) {
      if (kind === 'siteRefresh') await bridge.siteRefresh(siteId);
      else {
        await bridge.purgeCache(siteId).catch((error: unknown) => {
          if (!isUnregisteredSite(error)) throw error;
        });
      }
    }
  }

  /** Runs the effects the checkpoints owe once each, then clears them from every checkpoint and from its streams. */
  async #settleEffects(rows: readonly CheckpointRow[], streams: readonly Stream[]): Promise<void> {
    const owing = rows.filter((row) => row.pendingEffects.length > 0);
    if (owing.length === 0) return;
    await this.#runEffects(mergeEffects(owing.map((row) => row.pendingEffects)));
    const pool = await this.#ctx.legacy.live();
    for (const row of owing) await clearPendingEffects(pool, row);
    for (const stream of streams) stream.pendingEffects = [];
  }

  /** Settles what earlier cycles' committed batches still owe; a failure stops the owing streams for this cycle. */
  async #recoverEffects(checkpoints: readonly CheckpointRow[]): Promise<void> {
    const owing = checkpoints.filter((row) => row.pendingEffects.length > 0);
    if (owing.length === 0) return;
    // A tenant whose site left `tsettings` has no stream, yet still owes the refresh that drops its site.
    const streams = owing.map((row): Stream => this.#streamOf(row.owner, row.tenantId) ?? this.#unstreamed(row));
    try {
      await this.#settleEffects(owing, streams);
    } catch (error) {
      this.#fail(streams, error);
      return;
    }
    // Streams the cycle reads progress with their turns; settling is all the others do.
    for (const stream of streams) if (!this.#streams.has(streamKey(stream.owner, stream.tenantId))) this.#progressed.add(stream);
  }

  /** A stream this cycle does not read, standing for a checkpoint so that its failure is reported; one per checkpoint and cycle. */
  #unstreamed(row: CheckpointRow): Stream {
    const key = streamKey(row.owner, row.tenantId);
    const known = this.#standIns.get(key);
    if (known !== undefined) return known;
    const checkpoint = cursorOfCheckpoint(row);
    // Checkpoints are read for data owners only.
    const owner = row.owner as DataOwner;
    const stream: Stream = { owner, tenantId: row.tenantId, checkpoint, storedHorizon: row.appliedHorizon, ...UNREAD, pendingEffects: row.pendingEffects };
    this.#standIns.set(key, stream);
    return stream;
  }

  /** Settles the effects the batch's stored checkpoints owe, then records reverse watermarks. */
  async #afterCommit(parts: readonly DecodedPart[], stored: readonly CheckpointRow[]): Promise<void> {
    const { owners, clock } = this.#ctx;
    await this.#settleEffects(stored, parts.map((part) => part.stream));
    const finishedAt = formatCanonicalTimestamp(clock.now());
    for (const part of parts) {
      for (const legacyTable of new Set(part.changes.map((change) => change.legacyTable))) {
        await owners.putWatermark(part.stream.owner, { legacyTable, direction: 'reverse', snapshotSeq: null, backupLsn: null, finishedAt });
      }
    }
  }
}

/** True when the cycle moved rows: applied, passed over, parked or written to the file store. */
function isActive(result: CycleResult): boolean {
  return result.rowsApplied > 0 || result.skipped > 0 || result.held > 0 || result.files.put > 0 || result.files.deleted > 0;
}

function emptyResult(): CycleResult {
  return { leader: false, ran: false, batches: 0, rowsApplied: 0, skipped: 0, held: 0, files: { put: 0, deleted: 0 }, errors: [], backlog: false };
}

/**
 * One projector cycle under the `migration`-schema advisory lock, held for the cycle: nothing runs unless some unit is
 * `target`-authoritative; then every (owner, tenant) stream resumes from its SQL Server checkpoint, in turns of one page,
 * up to the horizon of its first read and at most `projection.streamPagesPerCycle` turns, and the horizons its pages
 * advance without consuming a row commit together in one last batch.
 * Stream failures are returned in `errors`; a hook's throw rejects the cycle; an aborted `signal` ends it early.
 * @throws Opt2SyncUnavailableError when `opt2_sync.projector_checkpoint` is missing while a unit is `target`-authoritative.
 */
export async function runProjectorCycle(ctx: ProjectorContext, deps: CycleDeps): Promise<CycleResult> {
  const result = emptyResult();
  try {
    return await ctx.db.withMetadata(async (tx) => {
      const lock = await tx.query<{ ok: boolean }>(LOCK_SQL, [PROJECTOR_LOCK_KEY.toString()]);
      if (lock.rows[0]?.ok !== true) return result;
      result.leader = true;
      const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
      if (!authority.anyTarget) return result;
      if (!(await opt2SyncReady(ctx.legacy))) {
        throw new Opt2SyncUnavailableError('opt2_sync.projector_checkpoint does not exist in the live legacy database', undefined);
      }
      const tenantSites = await liveTenantSites(ctx.legacy);
      deps.onTenants?.([...tenantSites.keys()]);
      result.ran = true;
      await new ProjectorCycle(ctx, deps, authority, tenantSites, result).run();
      return result;
    });
  } catch (error) {
    throw error instanceof HookFailure ? error.original : error;
  }
}

/**
 * Creates the projector loop; its operation tracker and stream memory live as long as the loop, so a new loop starts with
 * none parked and mirrors every stored checkpoint once.
 */
export function createProjectorLoop(ctx: ProjectorContext, options: ProjectorLoopOptions): ProjectorLoop {
  const tracker = new OperationTracker();
  const memory: StreamMemory = { mirrored: new Map(), failures: new Map(), fenceFailures: new Map(), scans: new Map() };
  let tenants: readonly string[] | null = null;
  let inflight: Promise<CycleResult> | undefined;
  let stopCycle: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const { idlePollMs, idleMaxPollMs } = ctx.config.projection;
  /** Delay after the next idle cycle; it doubles with each one, up to `idleMaxPollMs`. */
  let idleDelayMs = idlePollMs;
  /** Demands held by awaits of the projection. */
  let demands = 0;
  /** True when a demand came while a cycle ran, so the next one starts as soon as it settles. */
  let wakeOnSettle = false;
  /** The scheduled cycles' current failure streak; undefined while they succeed. */
  let failing: FailureState | undefined;

  const runOnce = (): Promise<CycleResult> => {
    if (inflight === undefined) {
      const stop = new AbortController();
      stopCycle = stop;
      // A cycle's polling is untraced; each batch carrying rows records its own linked root span.
      const cycle = withUnsampledTrace(() =>
        runProjectorCycle(ctx, {
          hooks: options.hooks,
          startupGuard: options.startupGuard,
          tracker,
          onTenants: (next) => {
            tenants = next;
          },
          signal: stop.signal,
          memory,
        }),
      );
      inflight = cycle.finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };

  /**
   * Delay before the next cycle, given the settled one's result or undefined after a failure: none after a backlog or a
   * demand made while it ran, `idlePollMs` after an active cycle or while a demand is held, else the doubled idle delay.
   */
  const nextDelay = (result: CycleResult | undefined): number => {
    const woken = wakeOnSettle;
    wakeOnSettle = false;
    const active = result !== undefined && (result.backlog || isActive(result));
    if (active || demands > 0) idleDelayMs = idlePollMs;
    if (woken || result?.backlog === true) return 0;
    if (active || demands > 0) return idlePollMs;
    idleDelayMs = Math.min(idleDelayMs * 2, idleMaxPollMs);
    return idleDelayMs;
  };

  /** Ends a failure streak with one recovery line, then schedules the next cycle. */
  const succeeded = (result: CycleResult): void => {
    if (failing !== undefined) {
      ctx.logger.info(`Reverse projector cycle recovered after ${String(failing.cycles)} failed cycles`);
      failing = undefined;
    }
    schedule(nextDelay(result));
  };

  /** Logs the first failure of a streak and each change of its error, then schedules the next cycle. */
  const failed = (error: unknown): void => {
    const signature = failureSignature(error);
    if (failing?.signature !== signature) ctx.logger.warn({ error: serializeError(error) }, 'Reverse projector cycle failed');
    failing = { signature, cycles: (failing?.cycles ?? 0) + 1 };
    schedule(nextDelay(undefined));
  };

  const schedule = (delayMs: number): void => {
    if (!running || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().then(succeeded, failed);
    }, delayMs);
  };

  /** Starts the next cycle at once: now when one is waiting on its timer, else as soon as the cycle in flight settles. */
  const wake = (): void => {
    if (!running) return;
    if (timer === undefined) {
      wakeOnSettle = true;
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    schedule(0);
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule(idlePollMs);
    },
    async stop() {
      running = false;
      wakeOnSettle = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inflight !== undefined) stopCycle?.abort();
      await inflight?.catch(() => undefined);
    },
    runOnce,
    demand() {
      demands += 1;
      idleDelayMs = idlePollMs;
      wake();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        demands -= 1;
      };
    },
    lastTenants: () => tenants,
  };
}
