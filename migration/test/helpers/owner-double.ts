// In-process double of the owners' migration endpoints behind `OwnersClient`: per-owner recorded state, holder
// compare-and-set gates, scripted change feeds and positions, consumer effects and injected failures; it opens no sockets.
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CanonicalEncodingError,
  DEFAULT_CHANGES_LIMIT,
  DEFAULT_EXPORT_LIMIT,
  MAX_CHANGES_LIMIT,
  MAX_EXPORT_LIMIT,
  MIGRATION_PATH_PREFIX,
  InvalidCursorError,
  compareEncodings,
  decodeRow,
  encodeKey,
  encodeRow,
  formatCanonicalTimestamp,
  formatCursor,
  parseCursor,
  parseProgramTable,
  programTableName,
  sha256Hex,
  type ApplyRequest,
  type CanonicalColumn,
  type ChangeRow,
  type ChangesResponse,
  type ExportResponse,
  type ExportRow,
  type ExportTable,
  type GatePhase,
  type GateRequest,
  type GateResponse,
  type GateState,
  type InboxCounts,
  type LegacyChange,
  type ObjectManifestEntry,
  type OperationStatus,
  type PositionResponse,
  type ProjectedChangeRow,
  type PublishedEvent,
  type WatermarkDirection,
  type WatermarkRecord,
} from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, systemClock, type Clock, type ServiceRequest } from '@opt2/platform/service-kit';
import {
  QUEUE_CONTROL_PREFIX,
  isQueueName,
  queueDefinition,
  slotName,
  slotStartS,
  type QueueControlOp,
  type QueueControlResult,
} from '@opt2/platform/tasks';
import { tenantIdForSite } from '@opt2/platform/tenancy';

import {
  GateConflict,
  OwnerCallError,
  type AdoptScheduledTask,
  type AdoptScheduledTasksRequest,
  type AdoptScheduledTasksResult,
  type ApplyResult,
  type CancelAdoptedTasksRequest,
  type CancelAdoptedTasksResult,
  type ChangesParams,
  type DeleteObjectResult,
  type ExportParams,
  type OwnersClient,
  type PositionParams,
  type PutObjectParams,
  type PutObjectResult,
  type SiteMonitorState,
  type SiteMonitorStateInput,
  type WatermarkWrite,
} from '../../src/owners/index.js';
import { UnitCatalogError, UnknownLegacyTableError, type DataOwner, type LegacyTableTarget, type UnitCatalog } from '../../src/owners/units.js';

import type { CallLog } from './gateway-double.js';

const APPLY_PATH = `${MIGRATION_PATH_PREFIX}/apply`;
const EXPORT_PATH = `${MIGRATION_PATH_PREFIX}/export`;
const CHANGES_PATH = `${MIGRATION_PATH_PREFIX}/changes`;
const POSITION_PATH = `${MIGRATION_PATH_PREFIX}/position`;
const WATERMARK_PATH = `${MIGRATION_PATH_PREFIX}/watermark`;
const GATE_PATH = `${MIGRATION_PATH_PREFIX}/gate`;
const OBJECTS_PATH = '/internal/v1/migration/objects';
const SITEMONITOR_STATE_PATH = '/internal/v1/sitemonitor/state';
const ADOPT_TASKS_PATH = '/internal/v1/migration/adopt-scheduled-tasks';
const CANCEL_ADOPTED_TASKS_PATH = '/internal/v1/migration/cancel-adopted-scheduled-tasks';

const CONTENT = 'strategies-content';
const FINANCE = 'finance';
const PROGRAMS_SITES = 'programs-sites';
const COMMUNICATIONS = 'communications';

/** The legacy table whose strategies-content unit carries the `content-files` manifest. */
const FILES_TABLE = 'tfiles';

/** strategies-content's stored-object manifest unit, used when no catalog unit of the owner is fed by `tfiles`. */
const FILE_OBJECT_UNIT = 'content.file_object';

/** First xid a double hands out as a write position. */
const FIRST_XID = '100';

/** A unit's gate as the owner's `unit_gate` row holds it. */
export interface OwnerGate {
  unit: string;
  state: GateState;
  holderId: string | null;
  phase: GatePhase;
}

/** One scripted change-feed page of a tenant; `cursor` defaults to the last row's, `complete` to true, `operations` to `done`. */
export interface ScriptedChangesPage {
  /** Rows without `legacy` projections are answered with none. */
  rows: Array<ChangeRow & { legacy?: LegacyChange[] }>;
  cursor?: string;
  horizon: string;
  complete?: boolean;
  operations?: Record<string, OperationStatus>;
}

/** Fields of a scripted position answer; unset fields keep the double's defaults. */
export interface ScriptedPosition {
  /** Defaults to the latest xid handed out. */
  position?: string;
  unpublished?: number;
  held?: number;
  /** False answers `outbox: null`, as an owner without an outbox does. */
  outbox?: boolean;
  /** False answers `inbox: null`, as an owner without an inbox does. */
  inbox?: boolean;
}

/** A fixed position answer, or one computed from the 1-based call number. */
export type PositionScript = ScriptedPosition | ((call: number, state: OwnerDoubleState) => ScriptedPosition);

/** Injected outcome of the next (or every) call of a method. */
export type OwnerFailure = 'down' | 'refuse' | { delay: number } | 'lost-reply' | { once: Error };

/** A method of {@link OwnersClient}. */
export type OwnerMethod = keyof OwnersClient;

/** One target row an owner double holds, in legacy column form. */
export interface HeldRow {
  /** Lower-case tenant UUID. */
  tenantId: string;
  values: Record<string, unknown>;
  legacyProgramId?: number;
  /** Unit whose row an apply wrote; unset on a seeded row, which every unit whose predicate takes it holds. */
  unit?: string;
}

/** One stored object; `unit` is the unit whose first export page lists it in the manifest. */
export interface StoredObject extends ObjectManifestEntry {
  tenantId: string;
  unit: string;
  bytes: Buffer;
}

/** A fixture survey task communications adopted. */
export interface AdoptedTask extends AdoptScheduledTask {
  scheduledImmediately: boolean;
}

/** One queue-control call an owner double answered. */
export interface QueueControlRecord {
  service: string;
  queue: string;
  op: QueueControlOp;
}

/** One call an owner double received, failed ones included. */
export interface OwnerCall {
  method: OwnerMethod;
  args: unknown[];
}

/** An event's identity, recorded as an inbox receipt once the effect that consumes it runs. */
export interface EffectEvent {
  eventId: string;
  tenantId: string;
}

/** Recorded state and controls of one owner double. */
export interface OwnerDoubleState {
  readonly name: string;
  /** Applied (non-duplicate) batches, in arrival order. */
  readonly batches: ApplyRequest[];
  /** Batch receipts: lower-case tenant to its applied batch ids, as `migration_batch (tenant_id, batch_id)` holds them. */
  readonly appliedBatchIds: Map<string, Set<string>>;
  /** Held rows by lower-case legacy table name without `dbo.`; folded tables under their `Program_N.<table>` name. */
  readonly rows: Map<string, HeldRow[]>;
  /** Legacy columns of each table in catalog order, keyed like `rows`; an apply records its batch columns when unset. */
  readonly exportColumns: Map<string, CanonicalColumn[]>;
  /** Pages `changes` answers per tenant, shifted one per call. */
  readonly changesScript: Map<string, ScriptedChangesPage[]>;
  readonly changesCalls: ChangesParams[];
  positionScript: PositionScript | undefined;
  readonly positionCalls: number;
  /** Events this owner reports as published to a `publishedTopics` ask. */
  readonly published: PublishedEvent[];
  /** Inbox receipts: lower-case event id to the lower-case tenants that applied it. */
  readonly receipts: Map<string, Set<string>>;
  /** Watermarks keyed `<legacyTable>|<direction>`. */
  readonly watermarks: Map<string, WatermarkRecord>;
  readonly gates: Map<string, OwnerGate>;
  /** Stored objects by key, written once per SHA-256. */
  readonly objects: Map<string, StoredObject>;
  /** Units whose first export page carries the object manifest. */
  readonly manifestUnits: Set<string>;
  /** Finance attachment bytes keyed `<tenantId>/<attachmentId>`. */
  readonly attachments: Map<string, Buffer>;
  siteMonitorState: SiteMonitorState;
  readonly adoptedTasks: Map<string, AdoptedTask>;
  readonly cancelledTasks: string[];
  readonly queueControls: QueueControlRecord[];
  readonly pausedQueues: Set<string>;
  readonly calls: OwnerCall[];
  /** Next xid handed out as a write position, in decimal. */
  nextXid: string;
  /** `on-position` runs ready effects before every position answer, as push delivery between drain polls does. */
  effectDelivery: 'on-position' | 'manual';
  /** Effects registered and not yet run; at the wire their events have no inbox receipt yet. */
  readonly pendingReceipts: number;
  /** Declares or updates a unit's gate; a new gate starts `legacy`, `quiet`, without holder. */
  setGate(unit: string, partial?: Partial<Omit<OwnerGate, 'unit'>>): OwnerGate;
  /** Holds `rows` of `table` in `tenantId`; a `Program_<id>.<table>` name folds and tags each row with the program. */
  seedRows(table: string, tenantId: string, rows: readonly Record<string, unknown>[], columns?: readonly CanonicalColumn[]): void;
  /** Applies `failure` to the next call of `method`; queued failures apply in order. */
  failNext(method: OwnerMethod, failure: OwnerFailure): void;
  /** Applies `failure` to every call of `method` until cleared; `{once}` still applies once. */
  failAlways(method: OwnerMethod, failure: OwnerFailure): void;
  clearFailures(): void;
  /** Registers a consumer effect on `unit`; it runs only while the unit's gate is `open`, then records `event`'s receipt. */
  onEffect(unit: string, fn: (state: OwnerDoubleState) => void | Promise<void>, event?: EffectEvent): void;
  /** Runs every pending effect whose unit's gate is `open`, in registration order. @returns the number run. */
  drainEffects(): Promise<number>;
}

/** Owner doubles over one catalog and the client they answer. */
export interface OwnerDoubles {
  client: OwnersClient;
  /** @throws Error for a name that is not one of the doubles. */
  owner(name: string): OwnerDoubleState;
  owners(): string[];
}

/** Options of {@link createOwnerDoubles}. */
export interface OwnerDoublesOptions {
  /** Owners to double; every owner of the catalog's units by default. */
  owners?: string[];
  log?: CallLog;
  /** Wait of `{delay}` failures; real timers by default. */
  sleep?: (ms: number) => Promise<void>;
  /** Initial gates by unit; units outside the catalog go to the owner whose units share their schema. */
  gates?: Record<string, Partial<OwnerGate>>;
  /** Clock of site-monitor `updatedAt`, adoption times and queue slots. */
  clock?: Clock;
}

type HttpMethod = ServiceRequest['method'];
type CloseRequest = Extract<GateRequest, { op: 'close' }>;
type PhaseRequest = Extract<GateRequest, { op: 'phase' }>;
type OpenRequest = Extract<GateRequest, { op: 'open' }>;

/** HTTP method and path the real client sends each method's request with; queue control appends `/<queue>/<op>`. */
const ROUTES: Readonly<Record<OwnerMethod, readonly [HttpMethod, string]>> = {
  apply: ['POST', APPLY_PATH],
  export: ['GET', EXPORT_PATH],
  exportPages: ['GET', EXPORT_PATH],
  changes: ['GET', CHANGES_PATH],
  position: ['GET', POSITION_PATH],
  watermark: ['GET', WATERMARK_PATH],
  putWatermark: ['POST', WATERMARK_PATH],
  gate: ['POST', GATE_PATH],
  putObject: ['POST', OBJECTS_PATH],
  getObject: ['GET', OBJECTS_PATH],
  deleteObject: ['DELETE', OBJECTS_PATH],
  getAttachmentObject: ['GET', OBJECTS_PATH],
  siteMonitorState: ['GET', SITEMONITOR_STATE_PATH],
  putSiteMonitorState: ['PUT', SITEMONITOR_STATE_PATH],
  adoptScheduledTasks: ['POST', ADOPT_TASKS_PATH],
  cancelAdoptedScheduledTasks: ['POST', CANCEL_ADOPTED_TASKS_PATH],
  queueControl: ['POST', QUEUE_CONTROL_PREFIX],
};

/** A legacy-envelope error body, as the owners' 4xx and 5xx answers carry one. */
function legacyError(code: string, message: string): unknown {
  return { apiversion: 'v1', error: { code, message } };
}

/** The owner's 400 answer to a request it rejects. */
function invalid(owner: string, method: OwnerMethod, message: string): OwnerCallError {
  const [verb, path] = ROUTES[method];
  return new OwnerCallError(owner as DataOwner, verb, path, 400, legacyError('invalid_request', message));
}

/** The owner's 404 answer, for an unknown owner or a missing object. */
function notFound(owner: string, method: OwnerMethod): OwnerCallError {
  const [verb, path] = ROUTES[method];
  return new OwnerCallError(owner as DataOwner, verb, path, 404, legacyError('invalid_request', 'Not Found'));
}

/** `callQueueControl`'s error for a non-2xx queue-control answer. */
function queueControlError(service: string, queue: string, op: QueueControlOp, status: number): Error {
  return new Error(`Queue control ${op} of ${queue} on ${service} answered HTTP ${String(status)}`);
}

/** The error a call that never reached `owner`, or lost its reply, rejects with. */
function unreachable(owner: string, code: 'ECONNREFUSED' | 'ECONNRESET'): ServiceUnavailableError {
  return new ServiceUnavailableError(owner, Object.assign(new Error(code === 'ECONNREFUSED' ? 'connect ECONNREFUSED' : 'socket hang up'), { code }));
}

/** Lookup form of a legacy table name: no leading `dbo.`, lower case. */
function tableKey(table: string): string {
  return table.replace(/^dbo\./i, '').toLowerCase();
}

/** Watermark lookup key; a `Program_<id>` name is normalised as the owner stores it. */
function watermarkKey(legacyTable: string, direction: WatermarkDirection): string {
  const program = parseProgramTable(legacyTable);
  const name = program === null ? legacyTable : programTableName(program.programId, program.table);
  return `${name}|${direction}`;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The stored value of each column, matched case-insensitively; null for a column the row lacks. */
function valuesOver(columns: readonly CanonicalColumn[], values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const byName = new Map(Object.keys(values).map((name) => [name.toLowerCase(), name]));
  return Object.fromEntries(
    columns.map((column) => {
      const source = byName.get(column.name.toLowerCase());
      return [column.name, source === undefined ? null : values[source]];
    }),
  );
}

/** Names of `keyNames` as `columns` spell them; undefined when one is missing. */
function columnNames(columns: readonly CanonicalColumn[], keyNames: readonly string[]): string[] | undefined {
  const names = keyNames.map((key) => columns.find((column) => column.name.toLowerCase() === key.toLowerCase())?.name);
  return names.every((name): name is string => name !== undefined) ? names : undefined;
}

/** Comparison text of a match value: trailing spaces dropped, lower case, as SQL Server compares text. */
function matchText(value: unknown): string {
  return String(value).replace(/ +$/, '').toLowerCase();
}

/** Row filter of a `<column> = <value>` ownership predicate, judged on a row lacking the column by its apply discriminator; any other predicate takes every row. */
function predicateFilter(
  target: LegacyTableTarget | undefined,
): (values: Readonly<Record<string, unknown>>, discriminator?: string | number) => boolean {
  const [, column, wanted] = /^(\w+)\s*=\s*'?([^'\s]+)'?$/.exec(target?.rowPredicate ?? '') ?? [];
  if (column === undefined || wanted === undefined) return () => true;
  return (values, discriminator) => {
    const present = Object.keys(values).some((name) => name.toLowerCase() === column.toLowerCase());
    const value = present ? valuesOver([{ name: column, type: 's' }], values)[column] : discriminator;
    return value !== null && value !== undefined && matchText(value) === matchText(wanted);
  };
}

/** Columns a unit exports from a legacy table: every column, or its key and owned columns in catalog order. */
function unitColumns(all: readonly CanonicalColumn[], target: LegacyTableTarget | undefined, keyNames: readonly string[]): CanonicalColumn[] {
  if (target === undefined || target.ownedColumns === 'whole-table') return all.map((column) => ({ ...column }));
  const wanted = new Set([...keyNames, ...target.keyColumns, ...target.ownedColumns].map((name) => name.toLowerCase()));
  return all.filter((column) => wanted.has(column.name.toLowerCase())).map((column) => ({ ...column }));
}

function encodeExportCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeExportCursor(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    const offset = (parsed as { offset?: unknown } | null)?.offset;
    return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : undefined;
  } catch {
    return undefined;
  }
}

/** True when cursor `(xid, seq)` of `row` is at or before `after`. */
function behind(row: Pick<ChangeRow, 'xid' | 'seq'>, after: { xid: bigint; seq: bigint }): boolean {
  const xid = BigInt(row.xid);
  return xid < after.xid || (xid === after.xid && BigInt(row.seq) <= after.seq);
}

interface PendingEffect {
  unit: string;
  run: (state: OwnerDoubleState) => void | Promise<void>;
  event?: EffectEvent;
}

interface DoubleContext {
  catalog: UnitCatalog;
  log: CallLog | undefined;
  clock: Clock;
}

/** One owner's recorded state, its controls and the request handlers the client routes to it. */
class OwnerDouble implements OwnerDoubleState {
  readonly name: string;
  readonly batches: ApplyRequest[] = [];
  readonly appliedBatchIds = new Map<string, Set<string>>();
  readonly rows = new Map<string, HeldRow[]>();
  readonly exportColumns = new Map<string, CanonicalColumn[]>();
  readonly changesScript = new Map<string, ScriptedChangesPage[]>();
  readonly changesCalls: ChangesParams[] = [];
  positionScript: PositionScript | undefined;
  readonly published: PublishedEvent[] = [];
  readonly receipts = new Map<string, Set<string>>();
  readonly watermarks = new Map<string, WatermarkRecord>();
  readonly gates = new Map<string, OwnerGate>();
  readonly objects = new Map<string, StoredObject>();
  readonly manifestUnits = new Set<string>();
  readonly attachments = new Map<string, Buffer>();
  siteMonitorState: SiteMonitorState = { lastMonitored: null, updatedAt: null };
  readonly adoptedTasks = new Map<string, AdoptedTask>();
  readonly cancelledTasks: string[] = [];
  readonly queueControls: QueueControlRecord[] = [];
  readonly pausedQueues = new Set<string>();
  readonly calls: OwnerCall[] = [];
  nextXid = FIRST_XID;
  effectDelivery: 'on-position' | 'manual' = 'on-position';

  readonly #ctx: DoubleContext;
  readonly #objectUnit: string;
  readonly #effects: PendingEffect[] = [];
  readonly #queued = new Map<OwnerMethod, OwnerFailure[]>();
  readonly #always = new Map<OwnerMethod, OwnerFailure>();
  readonly #horizons = new Map<string, string>();
  readonly #ensuredSlots = new Set<string>();
  #positionCalls = 0;

  constructor(name: string, ctx: DoubleContext) {
    this.name = name;
    this.#ctx = ctx;
    const units = ctx.catalog.unitsOfOwner(name);
    for (const unit of units) this.setGate(unit.id);
    this.#objectUnit = units.find((unit) => unit.legacyTables.some((table) => tableKey(table) === FILES_TABLE))?.id ?? FILE_OBJECT_UNIT;
    if (name === CONTENT) this.manifestUnits.add(this.#objectUnit);
  }

  get positionCalls(): number {
    return this.#positionCalls;
  }

  get pendingReceipts(): number {
    return this.#effects.length;
  }

  setGate(unit: string, partial: Partial<Omit<OwnerGate, 'unit'>> = {}): OwnerGate {
    const gate: OwnerGate = { state: 'legacy', holderId: null, phase: 'quiet', ...this.gates.get(unit), ...partial, unit };
    this.gates.set(unit, gate);
    return { ...gate };
  }

  seedRows(table: string, tenantId: string, rows: readonly Record<string, unknown>[], columns?: readonly CanonicalColumn[]): void {
    const fold = this.#ctx.catalog.foldProgramTable(table);
    const key = tableKey(fold.legacyTable);
    if (columns !== undefined) this.exportColumns.set(key, columns.map((column) => ({ ...column })));
    if (!this.exportColumns.has(key)) throw new Error(`Owner double ${this.name}: seed ${table} with columns or after an apply recorded them`);
    const held = this.#held(key);
    for (const values of rows) {
      held.push({ tenantId: tenantId.toLowerCase(), values: { ...values }, ...(fold.programId === null ? {} : { legacyProgramId: fold.programId }) });
    }
  }

  failNext(method: OwnerMethod, failure: OwnerFailure): void {
    this.#queued.set(method, [...(this.#queued.get(method) ?? []), failure]);
  }

  failAlways(method: OwnerMethod, failure: OwnerFailure): void {
    this.#always.set(method, failure);
  }

  clearFailures(): void {
    this.#queued.clear();
    this.#always.clear();
  }

  onEffect(unit: string, fn: (state: OwnerDoubleState) => void | Promise<void>, event?: EffectEvent): void {
    this.#effects.push(event === undefined ? { unit, run: fn } : { unit, run: fn, event: { ...event } });
  }

  async drainEffects(): Promise<number> {
    let ran = 0;
    for (const effect of [...this.#effects]) {
      if (this.gates.get(effect.unit)?.state !== 'open') continue;
      const index = this.#effects.indexOf(effect);
      if (index === -1) continue;
      // Taken out before it runs, so an overlapping drain never runs it twice; a failed effect stays pending.
      this.#effects.splice(index, 1);
      try {
        await effect.run(this);
      } catch (error) {
        this.#effects.splice(Math.min(index, this.#effects.length), 0, effect);
        throw error;
      }
      if (effect.event !== undefined) {
        const eventId = effect.event.eventId.toLowerCase();
        const tenants = this.receipts.get(eventId) ?? new Set<string>();
        tenants.add(effect.event.tenantId.toLowerCase());
        this.receipts.set(eventId, tenants);
      }
      this.log('effect', { unit: effect.unit, ...(effect.event === undefined ? {} : { eventId: effect.event.eventId }) });
      ran += 1;
    }
    return ran;
  }

  /** The failure the next call of `method` takes, if any; a `{once}` failure is used up. */
  takeFailure(method: OwnerMethod): OwnerFailure | undefined {
    const queued = this.#queued.get(method);
    if (queued !== undefined && queued.length > 0) return queued.shift();
    const always = this.#always.get(method);
    if (always !== undefined && typeof always === 'object' && 'once' in always) this.#always.delete(method);
    return always;
  }

  log(op: string, args?: unknown): void {
    this.#ctx.log?.append(`owner:${this.name}`, op, args);
  }

  /** Hands out the next xid as the position of a committed write. */
  #write(): string {
    const xid = this.nextXid;
    this.nextXid = (BigInt(xid) + 1n).toString();
    return xid;
  }

  #held(key: string): HeldRow[] {
    const held = this.rows.get(key) ?? [];
    this.rows.set(key, held);
    return held;
  }

  /** The batch tenant named by exactly one of `tenantId` and `siteId`, lower case. */
  #tenantOf(input: { tenantId?: string | undefined; siteId?: string | undefined }): string {
    if (input.tenantId !== undefined && input.siteId === undefined) return input.tenantId.toLowerCase();
    if (input.siteId !== undefined && input.tenantId === undefined) return tenantIdForSite(input.siteId);
    throw invalid(this.name, 'apply', 'exactly one of tenantId and siteId is required');
  }

  /** Legacy key columns of `table` as `columns` spell them; `[]` for a keyless table. @throws OwnerCallError 400 for a table this owner does not map. */
  #applyKey(table: string, columns: readonly CanonicalColumn[]): string[] {
    let keyNames: readonly string[];
    try {
      if (!this.#ctx.catalog.ownersForLegacyTable(table).includes(this.name as DataOwner)) throw new UnknownLegacyTableError(table);
      keyNames = this.#ctx.catalog.keyColumnsOf(table);
    } catch (error) {
      if (error instanceof UnknownLegacyTableError || error instanceof UnitCatalogError) throw invalid(this.name, 'apply', `${this.name} maps no legacy table ${table}`);
      throw error;
    }
    const names = columnNames(columns, keyNames);
    if (names === undefined) throw invalid(this.name, 'apply', `columns lack the key of ${table}`);
    return names;
  }

  /** A watermark as the owner stores it. @throws OwnerCallError 400 when `finishedAt` is no wall-clock timestamp. */
  #watermarkOf(method: 'apply' | 'putWatermark', record: WatermarkWrite): WatermarkRecord {
    const key = watermarkKey(record.legacyTable, record.direction);
    return {
      legacyTable: key.slice(0, key.lastIndexOf('|')),
      direction: record.direction,
      snapshotSeq: record.snapshotSeq ?? null,
      backupLsn: record.backupLsn ?? null,
      finishedAt: this.#wallClock(method, record.finishedAt),
    };
  }

  #wallClock(method: 'apply' | 'putWatermark' | 'putSiteMonitorState' | 'adoptScheduledTasks', text: string): string {
    try {
      return formatCanonicalTimestamp(text);
    } catch (error) {
      if (error instanceof CanonicalEncodingError) throw invalid(this.name, method, `${text} is not a wall-clock timestamp without a zone`);
      throw error;
    }
  }

  /** Targets of `mapped`, the owner's of `table`, a batch writes: those `units` name, else all. @throws OwnerCallError 400 for a unit not mapped. */
  #writableTargets(table: string, mapped: readonly LegacyTableTarget[], units: readonly string[] | undefined): readonly LegacyTableTarget[] {
    const unmapped = units?.find((unit) => !mapped.some((target) => target.unit === unit));
    if (unmapped !== undefined) throw invalid(this.name, 'apply', `${this.name} maps ${table} to no unit ${unmapped}`);
    return units === undefined ? mapped : mapped.filter((target) => units.includes(target.unit));
  }

  /**
   * Upserts, inserts or deletes one decoded row as `target`'s row in the scope of its tenant and program, writing only the
   * key and the target's owned columns; false when a delete found nothing. `mapped` are the owner's targets of the table.
   */
  #applyRow(
    held: HeldRow[],
    mapped: readonly LegacyTableTarget[],
    target: LegacyTableTarget,
    columns: readonly CanonicalColumn[],
    keyNames: readonly string[],
    op: string,
    values: Record<string, unknown>,
    scope: Pick<HeldRow, 'tenantId' | 'legacyProgramId'>,
  ): boolean {
    const written = unitColumns(columns, target, keyNames);
    const stored = (base: Readonly<Record<string, unknown>> = {}): HeldRow => ({
      tenantId: scope.tenantId,
      values: { ...base, ...valuesOver(written, values) },
      ...(scope.legacyProgramId === undefined ? {} : { legacyProgramId: scope.legacyProgramId }),
      unit: target.unit,
    });
    if (op === 'insert') {
      held.push(stored());
      return true;
    }
    const identity = (row: Readonly<Record<string, unknown>>): string =>
      keyNames.length === 0 ? encodeRow(written, valuesOver(written, row)) : encodeKey(written, keyNames, valuesOver(written, row));
    const wanted = identity(values);
    const takes = predicateFilter(target);
    let index = held.findIndex(
      (row) =>
        row.tenantId === scope.tenantId &&
        row.legacyProgramId === scope.legacyProgramId &&
        (row.unit === undefined ? takes(row.values) : row.unit === target.unit) &&
        identity(row.values) === wanted,
    );
    const seeded = held[index];
    if (seeded !== undefined && seeded.unit === undefined) {
      // One copy per unit that holds the seeded row, so this write leaves the other units' rows as they were.
      const copies = mapped
        .filter((candidate) => predicateFilter(candidate)(seeded.values))
        .map((candidate): HeldRow => ({ ...seeded, values: { ...seeded.values }, unit: candidate.unit }));
      held.splice(index, 1, ...copies);
      index += copies.findIndex((copy) => copy.unit === target.unit);
    }
    const current = held[index];
    if (op === 'delete') {
      if (current === undefined) return false;
      held.splice(index, 1);
      return true;
    }
    if (current === undefined) held.push(stored());
    else held[index] = stored(current.values);
    return true;
  }

  /**
   * `POST /apply`: checked as the owner checks it, then a new `(tenant, batchId)` receipt writes each row through the
   * selected units that take it, with one write position. A repeated receipt answers `duplicate`, with no counts or position,
   * before row ops and values are checked; a batch failing those checks stays unreceipted.
   */
  apply(req: ApplyRequest): ApplyResult {
    const tenantId = this.#tenantOf(req);
    const fold = this.#ctx.catalog.foldProgramTable(req.legacyTable);
    if (fold.programId !== null && req.legacyProgramId !== undefined && req.legacyProgramId !== fold.programId) {
      throw invalid(this.name, 'apply', 'legacyProgramId contradicts the Program_<id> table name');
    }
    const legacyProgramId = fold.programId ?? req.legacyProgramId;
    const keyNames = this.#applyKey(fold.legacyTable, req.columns);
    const mapped = this.#ctx.catalog.unitsForLegacyTable(fold.legacyTable).filter((target) => target.owner === this.name);
    const writable = this.#writableTargets(fold.legacyTable, mapped, req.units);
    const watermark = req.watermark === undefined ? undefined : this.#watermarkOf('apply', { ...req.watermark, legacyTable: req.legacyTable });
    const receipts = this.appliedBatchIds.get(tenantId) ?? new Set<string>();
    if (receipts.has(req.batchId)) return { batchId: req.batchId, duplicate: true, applied: 0, skipped: 0, writePositions: new Map() };
    const ops = keyNames.length === 0 ? ['insert', 'delete'] : ['upsert', 'delete'];
    const wrongOp = req.rows.find((input) => !ops.includes(input.op));
    if (wrongOp !== undefined) throw invalid(this.name, 'apply', `${fold.legacyTable} takes ${ops.join(' or ')} rows, not ${wrongOp.op}`);
    let decoded: Record<string, unknown>[];
    try {
      decoded = req.rows.map((input) => decodeRow(req.columns, input.row));
    } catch (error) {
      if (error instanceof CanonicalEncodingError) throw invalid(this.name, 'apply', error.message);
      throw error;
    }

    const key = tableKey(fold.legacyTable);
    if (!this.exportColumns.has(key)) this.exportColumns.set(key, req.columns.map((column) => ({ ...column })));
    const held = this.#held(key);
    const scope = { tenantId, legacyProgramId };
    const takers = writable.map((target) => ({ target, takes: predicateFilter(target) }));
    let applied = 0;
    req.rows.forEach((input, index) => {
      const values = decoded[index] ?? {};
      let wrote = false;
      for (const { target, takes } of takers) {
        if (!takes(values, input.discriminator)) continue;
        if (this.#applyRow(held, mapped, target, req.columns, keyNames, input.op, values, scope)) wrote = true;
      }
      if (wrote) applied += 1;
    });
    if (watermark !== undefined) this.watermarks.set(watermarkKey(watermark.legacyTable, watermark.direction), watermark);
    this.appliedBatchIds.set(tenantId, receipts.add(req.batchId));
    this.batches.push(structuredClone(req));
    return { batchId: req.batchId, duplicate: false, applied, skipped: req.rows.length - applied, writePositions: new Map([[this.name, this.#write()]]) };
  }

  /** The tables of a unit with the tenant's rows in export form, keyed or keyless order, filtered as `params` asks. */
  #exportSources(params: ExportParams, tenantId: string): { table: Omit<ExportTable, 'rows'>; rows: ExportRow[] }[] {
    const { catalog } = this.#ctx;
    const legacyTables = catalog.units().some((unit) => unit.id === params.unit) ? catalog.legacyTablesOf(params.unit) : [];
    const keys = params.keys === undefined ? undefined : new Set(params.keys);
    const terms = params.match === undefined ? undefined : Object.entries(params.match).map(([column, values]) => ({ column, wanted: new Set(values.map(matchText)) }));
    return legacyTables.map((legacyTable) => {
      const target = catalog.unitsForLegacyTable(legacyTable).find((candidate) => candidate.unit === params.unit);
      const keyNames = catalog.keyColumnsOf(legacyTable);
      const columns = unitColumns(this.exportColumns.get(tableKey(legacyTable)) ?? [], target, keyNames);
      const keyColumns = keyNames.length === 0 ? [] : columnNames(columns, keyNames);
      const accepts = predicateFilter(target);
      const held = (this.rows.get(tableKey(legacyTable)) ?? []).filter(
        (row) =>
          row.tenantId === tenantId &&
          (params.programId === undefined || row.legacyProgramId === params.programId) &&
          (row.unit === undefined ? accepts(row.values) : row.unit === params.unit) &&
          (terms === undefined || matchesAny(row.values, terms)),
      );
      if (held.length > 0 && keyColumns === undefined) throw new Error(`Owner double ${this.name}: export columns of ${legacyTable} lack its key`);
      const rows = held
        .map((row) => exportRowOf(columns, keyColumns ?? [], row))
        .filter((row) => keys === undefined || keys.has(row.key))
        .sort(compareExportRows);
      return { table: { unit: params.unit, legacyTable, targetTable: params.unit, keyless: keyNames.length === 0, columns }, rows };
    });
  }

  /** The object manifest of `unit` in `tenantId`, ordered by key. */
  #manifest(unit: string, tenantId: string): ObjectManifestEntry[] {
    return [...this.objects.values()]
      .filter((object) => object.unit === unit && object.tenantId === tenantId)
      .sort((a, b) => byCodeUnit(a.key, b.key))
      .map(({ key, size, sha256, contentType, legacyPath }) => ({
        key,
        size,
        sha256,
        ...(contentType === undefined ? {} : { contentType }),
        ...(legacyPath === undefined ? {} : { legacyPath }),
      }));
  }

  /** `GET /export`: one page of the unit's tables; the first unkeyed page of a manifest unit carries the object manifest. */
  exportPage(params: ExportParams): ExportResponse {
    if (!this.gates.has(params.unit)) throw invalid(this.name, 'export', `${this.name} declares no unit ${params.unit}`);
    const limit = params.limit ?? DEFAULT_EXPORT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPORT_LIMIT) throw invalid(this.name, 'export', `limit must be 1 to ${String(MAX_EXPORT_LIMIT)}`);
    const offset = params.after === undefined ? 0 : decodeExportCursor(params.after);
    if (offset === undefined) throw invalid(this.name, 'export', 'export cursor is malformed');
    const tenantId = params.tenantId.toLowerCase();
    let skip = offset;
    let room = limit;
    let total = 0;
    const tables = this.#exportSources(params, tenantId).map(({ table, rows }): ExportTable => {
      total += rows.length;
      const from = Math.min(skip, rows.length);
      skip -= from;
      const taken = rows.slice(from, from + room);
      room -= taken.length;
      return { ...table, rows: taken };
    });
    const end = offset + limit;
    const page: ExportResponse = { unit: params.unit, tenantId, tables, next: end < total ? encodeExportCursor(end) : null };
    if (offset === 0 && params.keys === undefined && this.manifestUnits.has(params.unit)) page.objects = this.#manifest(params.unit, tenantId);
    return page;
  }

  /** `GET /changes`: the tenant's next scripted page past `after`, or an empty complete page at the last horizon. */
  changes(params: ChangesParams): ChangesResponse {
    this.changesCalls.push({ ...params });
    let after: { xid: bigint; seq: bigint };
    try {
      after = parseCursor(params.after);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw invalid(this.name, 'changes', error.message);
      throw error;
    }
    const limit = params.limit ?? DEFAULT_CHANGES_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGES_LIMIT) throw invalid(this.name, 'changes', `limit must be 1 to ${String(MAX_CHANGES_LIMIT)}`);
    const tenantKey = params.tenantId.toLowerCase();
    const script = this.changesScript.get(params.tenantId) ?? this.changesScript.get(tenantKey);
    const page = script?.shift();
    if (script === undefined || page === undefined) {
      return { rows: [], cursor: params.after, horizon: this.#horizons.get(tenantKey) ?? this.nextXid, complete: true, operations: {} };
    }
    this.#horizons.set(tenantKey, page.horizon);
    const rows = page.rows.filter((row) => !behind(row, after)).map((row): ProjectedChangeRow => ({ ...row, legacy: row.legacy ?? [] }));
    const returned = rows.slice(0, limit);
    const truncated = rows.length > limit;
    if (truncated) script.unshift({ ...page, rows: rows.slice(limit) });
    const last = returned.at(-1);
    const lastCursor = last === undefined ? params.after : formatCursor({ xid: BigInt(last.xid), seq: BigInt(last.seq) });
    const operationIds = [...new Set(returned.flatMap((row) => (row.operationId === null ? [] : [row.operationId])))];
    return {
      rows: returned,
      cursor: truncated ? lastCursor : (page.cursor ?? lastCursor),
      horizon: page.horizon,
      complete: truncated ? false : (page.complete ?? true),
      operations: Object.fromEntries(operationIds.map((id): [string, OperationStatus] => [id, page.operations?.[id] ?? 'done'])),
    };
  }

  #inbox(eventIds: readonly string[] | undefined): InboxCounts {
    const total = [...this.receipts.values()].reduce((sum, tenants) => sum + tenants.size, 0);
    const counts: InboxCounts = { total, bySubscription: {} };
    if (eventIds !== undefined) {
      counts.receipts = Object.fromEntries(eventIds.map((id) => id.toLowerCase()).map((id) => [id, [...(this.receipts.get(id) ?? [])].sort(byCodeUnit)]));
    }
    return counts;
  }

  /** `GET /position`: ready effects run first under `on-position` delivery; the script overrides the counts. */
  async position(params: PositionParams = {}): Promise<PositionResponse> {
    this.#positionCalls += 1;
    if (this.effectDelivery === 'on-position') await this.drainEffects();
    const script = typeof this.positionScript === 'function' ? this.positionScript(this.#positionCalls, this) : (this.positionScript ?? {});
    const answer: PositionResponse = {
      owner: this.name,
      position: script.position ?? (BigInt(this.nextXid) - 1n).toString(),
      outbox: script.outbox === false ? null : { tenants: [], unpublished: script.unpublished ?? 0, held: script.held ?? 0 },
      inbox: script.inbox === false ? null : this.#inbox(params.eventIds),
    };
    if (params.publishedTopics !== undefined) {
      const topics = new Set(params.publishedTopics);
      answer.published = answer.outbox === null ? [] : this.published.filter((event) => topics.has(event.topic)).map((event) => ({ ...event }));
    }
    return answer;
  }

  /** `GET /watermark` of one legacy table and direction. */
  watermark(legacyTable: string, direction: WatermarkDirection): WatermarkRecord | null {
    const found = this.watermarks.get(watermarkKey(legacyTable, direction));
    return found === undefined ? null : { ...found };
  }

  /** `POST /watermark`. */
  putWatermark(record: WatermarkWrite): WatermarkRecord {
    const stored = this.#watermarkOf('putWatermark', record);
    this.watermarks.set(watermarkKey(stored.legacyTable, stored.direction), stored);
    return { ...stored };
  }


  #gatesOf(units: readonly string[]): OwnerGate[] {
    return [...units].sort(byCodeUnit).flatMap((unit) => {
      const gate = this.gates.get(unit);
      return gate === undefined ? [] : [{ ...gate }];
    });
  }

  #conflict(units: string[]): GateConflict {
    return new GateConflict(this.name as DataOwner, { error: 'gate-conflict', units });
  }

  /** Compare-and-set `open` (or `legacy` with `allowLegacy`) to `closed` for the holder; idempotent for the same holder. */
  #close(units: readonly string[], req: CloseRequest): OwnerGate[] {
    const closable: readonly GateState[] = req.allowLegacy === true ? ['open', 'legacy'] : ['open'];
    const refused = units.filter((unit) => {
      const gate = this.gates.get(unit);
      if (gate === undefined) return true;
      return gate.state === 'closed' ? gate.holderId !== req.holderId : !closable.includes(gate.state);
    });
    if (refused.length > 0) throw this.#conflict(refused);
    for (const unit of units) this.setGate(unit, { state: 'closed', holderId: req.holderId, phase: req.phase ?? 'quiet' });
    return this.#gatesOf(units);
  }

  /** Re-phases gates only when the holder holds every unit; otherwise changes nothing. */
  #phase(units: readonly string[], req: PhaseRequest): OwnerGate[] {
    const refused = units.filter((unit) => this.gates.get(unit)?.holderId !== req.holderId);
    if (refused.length > 0) throw this.#conflict(refused);
    for (const unit of units) this.setGate(unit, { phase: req.phase });
    return this.#gatesOf(units);
  }

  /** Reopens the holder's gates as `state`; units held by another holder stay and are refused after the others reopen. */
  #open(units: readonly string[], req: OpenRequest): OwnerGate[] {
    const state = req.state ?? 'open';
    for (const unit of units) {
      if (this.gates.get(unit)?.holderId === req.holderId) this.setGate(unit, { state, holderId: null, phase: 'quiet' });
    }
    const refused = units.filter((unit) => {
      const gate = this.gates.get(unit);
      return gate === undefined || gate.holderId !== null || gate.state !== state;
    });
    if (refused.length > 0) throw this.#conflict(refused);
    return this.#gatesOf(units);
  }

  /** `POST /gate`: close, phase, open or status of declared units, answered in unit order. */
  gate(req: GateRequest): GateResponse {
    const units = req.units === undefined ? [...this.gates.keys()] : [...new Set(req.units)];
    const foreign = units.filter((unit) => !this.gates.has(unit));
    if (foreign.length > 0) throw invalid(this.name, 'gate', `${this.name} declares no unit ${foreign.join(', ')}`);
    switch (req.op) {
      case 'close':
        return { units: this.#close(units, req) };
      case 'phase':
        return { units: this.#phase(units, req) };
      case 'open':
        return { units: this.#open(units, req) };
      case 'status':
        return { units: this.#gatesOf(units) };
    }
  }

  /** `POST /objects`: stores the bytes under `<tenantId>/<fileId><variant>.<ext>`, a no-op for the same SHA-256. */
  putObject(params: PutObjectParams, bytes: Uint8Array): PutObjectResult {
    const body = Buffer.from(bytes);
    if (sha256Hex(body) !== params.sha256) throw invalid(this.name, 'putObject', 'the body does not hash to sha256');
    const key = `${params.tenantId}/${params.fileId}${params.variant}.${params.ext.toLowerCase()}`;
    const held = this.objects.get(key);
    if (held !== undefined && held.sha256 === params.sha256) {
      return { key, size: held.size, sha256: held.sha256, created: false, writePositions: new Map() };
    }
    const stored: StoredObject = {
      key,
      size: body.length,
      sha256: params.sha256,
      contentType: params.contentType,
      tenantId: params.tenantId.toLowerCase(),
      unit: this.#objectUnit,
      bytes: body,
    };
    this.objects.set(key, stored);
    return { key, size: stored.size, sha256: stored.sha256, created: true, writePositions: new Map([[this.name, this.#write()]]) };
  }

  /** `GET /objects`: the stored bytes of `key`. */
  getObject(key: string): Readable {
    const held = this.objects.get(key);
    if (held === undefined) throw notFound(this.name, 'getObject');
    return Readable.from([Buffer.from(held.bytes)], { objectMode: false });
  }

  /** `DELETE /objects`: a repeat, or a key never stored, answers `deleted: false` without a write position. */
  deleteObject(key: string): DeleteObjectResult {
    if (!this.objects.delete(key)) return { key, deleted: false, writePositions: new Map() };
    return { key, deleted: true, writePositions: new Map([[this.name, this.#write()]]) };
  }

  /** Finance `GET /objects`: the stored bytes of one attachment. */
  getAttachmentObject(tenantId: string, attachmentId: string): Readable {
    const held = this.attachments.get(`${tenantId.toLowerCase()}/${attachmentId}`);
    if (held === undefined) throw notFound(this.name, 'getAttachmentObject');
    return Readable.from([Buffer.from(held)], { objectMode: false });
  }

  /** programs-sites `PUT /sitemonitor/state`: seeds the cursor and stamps `updatedAt` from the clock. */
  seedSiteMonitorState(input: SiteMonitorStateInput): SiteMonitorState {
    const lastMonitored = this.#wallClock('putSiteMonitorState', input.lastMonitored);
    this.siteMonitorState = { lastMonitored, updatedAt: formatCanonicalTimestamp(this.#ctx.clock.now()) };
    return { ...this.siteMonitorState };
  }

  /** communications adoption, idempotent by task name; a time at or before now is scheduled immediately. */
  adopt(req: AdoptScheduledTasksRequest): AdoptScheduledTasksResult {
    const now = formatCanonicalTimestamp(this.#ctx.clock.now());
    const times = req.tasks.map((task) => this.#wallClock('adoptScheduledTasks', task.scheduleTime));
    const result: AdoptScheduledTasksResult = { adopted: 0, existing: 0, scheduledImmediately: 0 };
    req.tasks.forEach((task, index) => {
      if (this.adoptedTasks.has(task.name)) {
        result.existing += 1;
        return;
      }
      const scheduledImmediately = (times[index] ?? now) <= now;
      this.adoptedTasks.set(task.name, { ...task, scheduledImmediately });
      result.adopted += 1;
      if (scheduledImmediately) result.scheduledImmediately += 1;
    });
    return result;
  }

  /** communications cancellation of the named adopted tasks, or of every one. */
  cancelAdopted(req: CancelAdoptedTasksRequest): CancelAdoptedTasksResult {
    let cancelled = 0;
    for (const name of req.names ?? [...this.adoptedTasks.keys()]) {
      if (!this.adoptedTasks.delete(name)) continue;
      this.cancelledTasks.push(name);
      cancelled += 1;
    }
    return { cancelled };
  }

  /** Queue control of a registry queue this service creates; `ensure` creates the current slot's chain task once. */
  queueControl(queue: string, op: QueueControlOp): QueueControlResult {
    const def = isQueueName(queue) ? queueDefinition(queue) : undefined;
    if (def === undefined || !def.creators.includes(this.name)) throw queueControlError(this.name, queue, op, 400);
    if (op === 'ensure') {
      if (def.recurring === undefined) throw queueControlError(this.name, queue, op, 400);
      this.queueControls.push({ service: this.name, queue, op });
      const name = slotName(queue, slotStartS(Math.floor(this.#ctx.clock.now().getTime() / 1000), def.recurring.intervalS));
      const created = !this.#ensuredSlots.has(name);
      this.#ensuredSlots.add(name);
      return { queue, service: this.name, ensured: { queue, name, created, reason: created ? 'created-current' : 'live' } };
    }
    this.queueControls.push({ service: this.name, queue, op });
    if (op === 'pause') {
      this.pausedQueues.add(queue);
      return { queue, service: this.name, paused: true, running: 0 };
    }
    this.pausedQueues.delete(queue);
    return { queue, service: this.name, paused: false };
  }
}

/** True when any term's column holds one of its values, compared as SQL Server compares text. */
function matchesAny(values: Readonly<Record<string, unknown>>, terms: readonly { column: string; wanted: ReadonlySet<string> }[]): boolean {
  return terms.some(({ column, wanted }) => {
    const value = valuesOver([{ name: column, type: 's' }], values)[column];
    return value !== null && value !== undefined && wanted.has(matchText(value));
  });
}

/** One held row in export form: its legacy encoding over `columns`, its key (the whole row when keyless) and hash. */
function exportRowOf(columns: readonly CanonicalColumn[], keyColumns: readonly string[], held: HeldRow): ExportRow {
  const values = valuesOver(columns, held.values);
  const encoded = encodeRow(columns, values);
  const row: ExportRow = { key: keyColumns.length === 0 ? encoded : encodeKey(columns, keyColumns, values), row: encoded, hash: sha256Hex(encoded) };
  if (held.legacyProgramId !== undefined) row.legacyProgramId = held.legacyProgramId;
  return row;
}

function compareExportRows(a: ExportRow, b: ExportRow): number {
  return compareEncodings(a.key, b.key) || (a.legacyProgramId ?? -1) - (b.legacyProgramId ?? -1) || compareEncodings(a.row, b.row);
}


/** The owner's 503 answer to a refused call. */
function refused(owner: string, method: OwnerMethod): OwnerCallError {
  const [verb, path] = ROUTES[method];
  return new OwnerCallError(owner as DataOwner, verb, path, 503, legacyError('server_error', 'Service Unavailable'));
}

/** Owner of `unit`: its catalog owner, else the owner whose units share its schema, else the doubled owner named after the schema. */
function gateOwner(catalog: UnitCatalog, unit: string, doubled: ReadonlyMap<string, OwnerDouble>): OwnerDouble | undefined {
  const schema = unit.slice(0, unit.indexOf('.'));
  const units = catalog.units();
  const owner = units.find((candidate) => candidate.id === unit)?.owner ?? units.find((candidate) => candidate.schema === schema)?.owner;
  return owner === undefined ? [...doubled.values()].find((double) => double.name.replace(/-/g, '_') === schema) : doubled.get(owner);
}

/** Creates owner doubles over `catalog` and the {@link OwnersClient} that answers from them; an unknown owner answers 404. */
export function createOwnerDoubles(catalog: UnitCatalog, opts: OwnerDoublesOptions = {}): OwnerDoubles {
  const ctx: DoubleContext = { catalog, log: opts.log, clock: opts.clock ?? systemClock };
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const names = opts.owners ?? [...new Set(catalog.units().map((unit) => unit.owner))];
  const doubles = new Map<string, OwnerDouble>(names.map((name) => [name, new OwnerDouble(name, ctx)]));
  for (const [unit, partial] of Object.entries(opts.gates ?? {})) {
    const holder = gateOwner(catalog, unit, doubles);
    if (holder === undefined) throw new Error(`Owner doubles: no doubled owner holds unit ${unit}`);
    holder.setGate(unit, partial);
  }

  function stateOf(owner: string, method: OwnerMethod): OwnerDouble {
    const state = doubles.get(owner);
    if (state === undefined) throw notFound(owner, method);
    return state;
  }

  /** Records the call, then answers it, or fails it as the next queued or standing failure of `method` says. */
  async function invoke<T>(
    state: OwnerDouble,
    method: OwnerMethod,
    args: unknown[],
    run: () => T | Promise<T>,
    options: { op?: string; refusal?: () => Error } = {},
  ): Promise<T> {
    state.calls.push({ method, args });
    state.log(options.op ?? method, args[0]);
    const failure = state.takeFailure(method);
    if (failure === undefined) return run();
    if (failure === 'down') throw unreachable(state.name, 'ECONNREFUSED');
    if (failure === 'refuse') throw options.refusal?.() ?? refused(state.name, method);
    if (failure === 'lost-reply') {
      await run();
      throw unreachable(state.name, 'ECONNRESET');
    }
    if ('delay' in failure) {
      await sleep(failure.delay);
      return run();
    }
    throw failure.once;
  }

  const client = {
    async apply(owner, req) {
      const state = stateOf(owner, 'apply');
      return invoke(state, 'apply', [req], () => state.apply(req));
    },

    async export(owner, params) {
      const state = stateOf(owner, 'export');
      return invoke(state, 'export', [params], () => state.exportPage(params));
    },

    async *exportPages(owner, params) {
      const state = stateOf(owner, 'exportPages');
      let after = params.after;
      for (;;) {
        const pageParams: ExportParams = { ...params, after };
        const page = await invoke(state, 'exportPages', [pageParams], () => state.exportPage(pageParams));
        yield page;
        if (page.next === null) return;
        after = page.next;
      }
    },

    async changes(owner, params) {
      const state = stateOf(owner, 'changes');
      return invoke(state, 'changes', [params], () => state.changes(params));
    },

    async position(owner, params = {}, options = {}) {
      const state = stateOf(owner, 'position');
      return invoke(state, 'position', [params, options], () => state.position(params));
    },

    async watermark(owner, legacyTable, direction) {
      const state = stateOf(owner, 'watermark');
      return invoke(state, 'watermark', [{ legacyTable, direction }], () => state.watermark(legacyTable, direction));
    },

    async putWatermark(owner, record) {
      const state = stateOf(owner, 'putWatermark');
      return invoke(state, 'putWatermark', [record], () => state.putWatermark(record));
    },

    async gate(owner, req, options = {}) {
      const state = stateOf(owner, 'gate');
      return invoke(state, 'gate', [req, options], () => state.gate(req), { op: `gate.${req.op}` });
    },

    async putObject(params, bytes) {
      const state = stateOf(CONTENT, 'putObject');
      return invoke(state, 'putObject', [params, bytes], () => state.putObject(params, bytes));
    },

    async getObject(key) {
      const state = stateOf(CONTENT, 'getObject');
      return invoke(state, 'getObject', [key], () => state.getObject(key));
    },

    async deleteObject(key) {
      const state = stateOf(CONTENT, 'deleteObject');
      return invoke(state, 'deleteObject', [key], () => state.deleteObject(key));
    },

    async getAttachmentObject(params) {
      const state = stateOf(FINANCE, 'getAttachmentObject');
      return invoke(state, 'getAttachmentObject', [params], () => state.getAttachmentObject(params.tenantId, params.attachmentId));
    },

    async siteMonitorState() {
      const state = stateOf(PROGRAMS_SITES, 'siteMonitorState');
      return invoke(state, 'siteMonitorState', [], () => ({ ...state.siteMonitorState }));
    },

    async putSiteMonitorState(input) {
      const state = stateOf(PROGRAMS_SITES, 'putSiteMonitorState');
      return invoke(state, 'putSiteMonitorState', [input], () => state.seedSiteMonitorState(input));
    },

    async adoptScheduledTasks(req) {
      const state = stateOf(COMMUNICATIONS, 'adoptScheduledTasks');
      return invoke(state, 'adoptScheduledTasks', [req], () => state.adopt(req));
    },

    async cancelAdoptedScheduledTasks(req) {
      const state = stateOf(COMMUNICATIONS, 'cancelAdoptedScheduledTasks');
      return invoke(state, 'cancelAdoptedScheduledTasks', [req], () => state.cancelAdopted(req));
    },

    async queueControl(service, queue, op) {
      const state = doubles.get(service);
      if (state === undefined) throw queueControlError(service, queue, op, 404);
      return invoke(state, 'queueControl', [{ queue, op }], () => state.queueControl(queue, op), {
        op: `queueControl.${op}`,
        refusal: () => queueControlError(service, queue, op, 503),
      });
    },
  } satisfies OwnersClient;

  return {
    client,
    owner(name) {
      const state = doubles.get(name);
      if (state === undefined) throw new Error(`No owner double named ${name}; doubled owners: ${[...doubles.keys()].join(', ')}`);
      return state;
    },
    owners: () => [...doubles.keys()],
  };
}

