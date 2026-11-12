/** Continuous reverse projector: owners' target changelogs into the live legacy tables, checkpointed in the batch's SQL Server transaction. */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { serializeError } from '@opt2/platform/logging';
import {
  CURSOR_START,
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
  readCheckpoints,
  summarise,
  upsertCheckpoint,
  type ApplyLegacyOptions,
  type ApplySummary,
  type CheckpointRow,
  type LegacyChange,
  type LegacyEffect,
} from './apply-legacy.js';
import { FILE_OBJECT_UNIT, executeFileOps, isFileObjectChange, planFileOps } from './files.js';
import { OperationTracker, classifyRow, splitAtHold, type FenceRequest, type RowDisposition, type TrackedOperation } from './operations.js';

/** Advisory lock key (`'opt2revp'`) electing the one projecting instance; bound as `$1::bigint` text. */
export const PROJECTOR_LOCK_KEY = 0x6f70743272657670n;

/** Fault points of a projector batch; both default to no-ops, and a throw from either aborts the whole cycle. */
export interface ProjectorHooks {
  /** Runs before a batch touches the legacy file store or database. */
  beforeBatch?(): Promise<void>;
  /** Runs after a batch's SQL Server commit and before its checkpoint mirror. */
  afterLegacyCommit?(info: { owner: string; tenantId: string; batchId: string }): Promise<void>;
}

/** Commits a batch inside the start-up guard sequence: freeze legacy-bound entries, `commit`, reload window, unfreeze. */
export interface StartupGuardRunner {
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
}

/** Context members a cycle uses. */
export type ProjectorContext = Pick<
  MigrationContext,
  'config' | 'clock' | 'logger' | 'db' | 'legacy' | 'bridge' | 'catalog' | 'owners' | 'gateway'
>;

/** Collaborators of one cycle; the tracker outlives cycles because the fences of done operations stay valid. */
export interface CycleDeps {
  hooks?: ProjectorHooks;
  startupGuard: StartupGuardRunner;
  tracker: OperationTracker;
  /** Receives the tenant set each leading cycle reads from the live `tsettings`. */
  onTenants?(tenants: readonly string[]): void;
}

/** Options of {@link createProjectorLoop}. */
export interface ProjectorLoopOptions {
  hooks?: ProjectorHooks;
  startupGuard: StartupGuardRunner;
}

/** The projector's cycle schedule and the tenant set it streams. */
export interface ProjectorLoop {
  /** Runs cycles at the configured cadence until `stop`; each next cycle is scheduled once the previous one settles. */
  start(): void;
  /** Cancels the schedule and waits for the cycle in flight. */
  stop(): Promise<void>;
  /** Runs one cycle now, or joins the one in flight. */
  runOnce(): Promise<CycleResult>;
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
  /** Cursor after the last page noted this cycle; undefined before the first read. */
  scanEnd: string | undefined;
  /** Operation the stream is parked at. */
  parkedAt: string | undefined;
  failed: boolean;
  /** Effects its committed SQL Server checkpoint still owes legacy. */
  pendingEffects: LegacyEffect[];
}

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

function streamKey(owner: string, tenantId: string): string {
  return JSON.stringify([owner, tenantId.toLowerCase()]);
}

function cursorOfCheckpoint(row: Pick<CheckpointRow, 'cursorXid' | 'cursorSeq'>): string {
  return formatCursor({ xid: BigInt(row.cursorXid), seq: BigInt(row.cursorSeq) });
}

function byPosition(a: { xid: string; seq: string }, b: { xid: string; seq: string }): number {
  const xid = compareXid(a.xid, b.xid);
  if (xid !== 0) return xid;
  const left = BigInt(a.seq);
  const right = BigInt(b.seq);
  return left < right ? -1 : left > right ? 1 : 0;
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

  /** Runs effects earlier batches owe, then reads every stream from its checkpoint and settles parked operations until nothing progresses. */
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
        this.#streams.set(streamKey(owner, tenantId), { owner, tenantId, checkpoint, scanEnd: undefined, parkedAt: undefined, failed: false, pendingEffects });
      }
    }
    try {
      await this.#recoverEffects(checkpoints);
      for (const stream of this.#streams.values()) await this.#runStreamSafely(stream);
      await this.#settleOperations();
    } finally {
      this.#deps.tracker.clear();
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
    tracker.noteStatuses(page.operations);
    tracker.noteScan(stream.owner, stream.tenantId, after, page, this.#classifier(stream.owner));
    stream.scanEnd = page.cursor;
    return page;
  }

  /** Projects the stream page by page from its checkpoint until a complete page or a held operation. */
  async #runStream(stream: Stream): Promise<void> {
    const classify = this.#classifier(stream.owner);
    let after = stream.checkpoint;
    for (;;) {
      const page = await this.#readPage(stream, after);
      const split = splitAtHold(page, classify, after);
      await this.#project([{ stream, rows: split.applicable, endCursor: split.endCursor, appliedHorizon: split.appliedHorizon }]);
      this.#result.skipped += split.skipped;
      const { held } = split;
      if (held !== undefined) {
        this.#deps.tracker.park(stream.owner, stream.tenantId, held.operationId, held.rows, held);
        stream.parkedAt = held.operationId;
        this.#result.held += held.rows.length;
        return;
      }
      if (page.complete) return;
      after = split.endCursor;
    }
  }

  async #runStreamSafely(stream: Stream): Promise<void> {
    if (stream.failed) return;
    try {
      await this.#runStream(stream);
    } catch (error) {
      this.#fail([stream], error);
    }
  }

  /** Stops the streams for this cycle and reports the error; a hook's throw is rethrown to abort the cycle. */
  #fail(streams: readonly Stream[], error: unknown): void {
    if (error instanceof HookFailure) throw error;
    const err = toError(error);
    for (const stream of streams) {
      stream.failed = true;
      this.#result.errors.push({ owner: stream.owner, tenantId: stream.tenantId, cursor: stream.checkpoint, error: err });
      this.#ctx.logger.error(
        { tenantId: stream.tenantId, error: serializeError(err) },
        `Reverse projection of ${stream.owner} for tenant ${stream.tenantId} stopped at cursor ${stream.checkpoint}`,
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
   * Notes fences, reads fenced and waiting owners' streams ahead, re-runs streams whose read-ahead reached a held row,
   * then applies ready operations jointly and passes over rolled-back ones, resuming their streams, until a round changes nothing.
   */
  async #settleOperations(): Promise<void> {
    const { tracker } = this.#deps;
    for (;;) {
      const fenced = await this.#noteFences();
      const owners = new Set<string>(fenced);
      for (const waiting of tracker.waiting()) {
        if (waiting.status !== 'done') continue;
        for (const owner of [...waiting.incomplete, ...waiting.unproven]) owners.add(owner);
      }
      const dirty = await this.#readAhead(owners);
      let progressed = fenced.size > 0 || dirty.length > 0;
      for (const stream of dirty) await this.#runStreamSafely(stream);
      for (const operation of tracker.ready()) progressed = (await this.#release(operation, true)) || progressed;
      for (const operation of tracker.rolledBack()) progressed = (await this.#release(operation, false)) || progressed;
      if (!progressed) return;
    }
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
      } catch (error) {
        this.#unfenced.add(owner);
        const streams = this.#streamsOf(owner);
        if (streams.length > 0) this.#fail(streams, error);
        else this.#ctx.logger.error({ error: serializeError(error) }, `Reading the write position of ${owner} for operation fences failed`);
      }
    }
    return fenced;
  }

  /**
   * Extends the scans of the owners' streams to a complete page, without projecting; returns the streams not parked whose
   * read-ahead reached a held row, which must be re-run to park there.
   */
  async #readAhead(owners: ReadonlySet<string>): Promise<Stream[]> {
    const dirty: Stream[] = [];
    for (const stream of this.#streams.values()) {
      if (stream.failed || stream.scanEnd === undefined || !owners.has(stream.owner)) continue;
      const classify = this.#classifier(stream.owner);
      let reachedHold = false;
      try {
        for (let after = stream.scanEnd; ; ) {
          const page = await this.#readPage(stream, after);
          reachedHold ||= stream.parkedAt === undefined && page.rows.some((row) => classify(row) === 'hold');
          if (page.complete) break;
          after = page.cursor;
        }
      } catch (error) {
        this.#fail([stream], error);
        continue;
      }
      if (reachedHold) dirty.push(stream);
    }
    return dirty;
  }

  /**
   * Applies a ready operation's parts, or passes over a rolled-back one's, in one legacy transaction with every part's
   * checkpoint, then releases it and resumes its streams; false when a part's stream has stopped or the batch failed.
   */
  async #release(operation: TrackedOperation, apply: boolean): Promise<boolean> {
    const streams = operation.parts.map((part) => this.#streamOf(part.owner, part.tenantId));
    if (streams.some((stream) => stream === undefined || stream.failed)) return false;
    const parts = operation.parts.map(
      (part, index): BatchPart => ({
        stream: streams[index] as Stream,
        rows: apply ? part.rows : [],
        endCursor: part.streamState.endCursor,
        appliedHorizon: part.streamState.appliedHorizon,
      }),
    );
    try {
      await this.#project(parts);
    } catch (error) {
      this.#fail(parts.map((part) => part.stream), error);
      return false;
    }
    if (!apply) this.#result.skipped += operation.rows.length;
    for (const id of operation.operationIds) this.#deps.tracker.release(id);
    for (const part of parts) part.stream.parkedAt = undefined;
    for (const part of parts) await this.#runStreamSafely(part.stream);
    return true;
  }

  /**
   * One batch: file-store operations first, since the bridge may read `tfiles` rows this batch's transaction would lock,
   * and the other owners' parts its split-table rows may merge; then every change in `(xid, seq)` order and every
   * part's checkpoint, with the site refreshes and cache purges it owes, in one SQL Server transaction; then the hooks,
   * checkpoint mirrors, owed effects and reverse watermarks.
   */
  async #project(parts: readonly BatchPart[]): Promise<void> {
    const { hooks } = this.#deps;
    const decoded: DecodedPart[] = [];
    for (const part of parts) decoded.push(await this.#decode(part));
    const changes = decoded.flatMap((part) => part.changes).sort(byPosition);
    const fileOps = planFileOps(decoded.flatMap((part) => part.fileRows).sort(byPosition), this.#tenantSites);

    await callHook(() => hooks?.beforeBatch?.());
    if (fileOps.length > 0) {
      const files = await executeFileOps(this.#ctx, fileOps);
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
    const batchId = randomUUID();
    const write = async (tx: Transaction): Promise<CheckpointRow[]> => {
      for (const change of changes) await applyLegacyChange(tx, change, this.#applyOptions(change, catalogs, others));
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
      part.stream.pendingEffects = stored[index]?.pendingEffects ?? [];
    }
    this.#result.batches += 1;
    this.#result.rowsApplied += changes.length;
    this.#result.skipped += decoded.reduce((sum, part) => sum + part.targetOnly, 0);

    for (const part of decoded) {
      await callHook(() => hooks?.afterLegacyCommit?.({ owner: part.stream.owner, tenantId: part.stream.tenantId, batchId }));
    }
    for (const row of stored) await this.#mirror(row);
    await this.#afterCommit(decoded, stored);
    if (guardError !== undefined) throw guardError;
  }

  /** Splits a part's rows into legacy changes and file-store rows; rows whose table has no legacy form count as target-only. */
  async #decode(part: BatchPart): Promise<DecodedPart> {
    const { owner, tenantId } = part.stream;
    const changes: LegacyChange[] = [];
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
      else changes.push(change);
    }
    return { ...part, changes, fileRows, targetOnly };
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

  #applyOptions(change: LegacyChange, catalogs: ReadonlyMap<string, TableCatalog>, others: OtherParts): ApplyLegacyOptions {
    const { catalog } = this.#ctx;
    const target = catalog.unitsForLegacyTable(change.legacyTable).find((entry) => entry.unit === change.unit);
    if (target === undefined) throw new Error(`Unit ${change.unit} takes no rows of legacy table ${change.legacyTable}`);
    return {
      // Read for every physical table of the batch before the transaction opened.
      tableCatalog: catalogs.get(change.physicalTable.qualified.toLowerCase()) as TableCatalog,
      target,
      split: catalog.isSplit(change.legacyTable),
      ownedColumns: target.ownedColumns,
      keyColumns: catalog.keyColumnsOf(change.legacyTable),
      fetchOtherParts: (merged) => Promise.resolve(others.fetch(merged)),
    };
  }

  /**
   * Commits the batch, through the start-up guard when rows would match Masa's start-up predicate. The guarded batch is
   * rolled back first and re-applied by the guard's commit, so no projector lock is held while the freeze drains legacy
   * requests. A guard failure after its commit is returned, so the post-commit steps still run.
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

  /** Copies a committed checkpoint into `migration.projector_cursor`, the reporting mirror, in its own transaction. */
  async #mirror(row: CheckpointRow): Promise<void> {
    await this.#ctx.db.withMetadata(async (tx) => {
      const table = qualified(tx.schema, MIRROR_TABLE);
      await tx.query(
        `INSERT INTO ${table} (owner, tenant_id, cursor, applied_horizon, batches, updated_at)
         VALUES ($1, $2::uuid, $3, $4::numeric, 1, $5::timestamp(3))
         ON CONFLICT (owner, tenant_id) DO UPDATE
           SET cursor = EXCLUDED.cursor, applied_horizon = EXCLUDED.applied_horizon,
               batches = ${table}.batches + 1, updated_at = EXCLUDED.updated_at`,
        [row.owner, row.tenantId, cursorOfCheckpoint(row), row.appliedHorizon, this.#ctx.clock.now()],
      );
    });
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
    }
  }

  /** A stream this cycle does not read, standing for a checkpoint so that its failure is reported. */
  #unstreamed(row: CheckpointRow): Stream {
    const checkpoint = cursorOfCheckpoint(row);
    // Checkpoints are read for data owners only.
    const owner = row.owner as DataOwner;
    return { owner, tenantId: row.tenantId, checkpoint, scanEnd: undefined, parkedAt: undefined, failed: false, pendingEffects: row.pendingEffects };
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

function emptyResult(): CycleResult {
  return { leader: false, ran: false, batches: 0, rowsApplied: 0, skipped: 0, held: 0, files: { put: 0, deleted: 0 }, errors: [] };
}

/**
 * One projector cycle under the `migration`-schema advisory lock, held for the cycle: nothing runs unless some unit is
 * `target`-authoritative; then every (owner, tenant) stream resumes from its SQL Server checkpoint.
 * Stream failures are returned in `errors`; a hook's throw rejects the cycle.
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

/** Creates the projector loop; its operation tracker lives as long as the loop, so a new loop starts with none parked. */
export function createProjectorLoop(ctx: ProjectorContext, options: ProjectorLoopOptions): ProjectorLoop {
  const tracker = new OperationTracker();
  let tenants: readonly string[] | null = null;
  let inflight: Promise<CycleResult> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const runOnce = (): Promise<CycleResult> => {
    if (inflight === undefined) {
      const cycle = runProjectorCycle(ctx, {
        hooks: options.hooks,
        startupGuard: options.startupGuard,
        tracker,
        onTenants: (next) => {
          tenants = next;
        },
      });
      inflight = cycle.finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };

  const schedule = (): void => {
    if (!running || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce()
        .catch((error: unknown) => {
          ctx.logger.error({ error: serializeError(error) }, 'Reverse projector cycle failed');
        })
        .finally(schedule);
    }, ctx.config.projection.idlePollMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inflight?.catch(() => undefined);
    },
    runOnce,
    lastTenants: () => tenants,
  };
}
