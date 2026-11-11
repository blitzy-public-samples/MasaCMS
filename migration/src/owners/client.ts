/** Client of the owners' internal migration, object, site-monitor and scheduled-task endpoints: the package's only route to target data. */
import { Buffer } from 'node:buffer';
import {
  GATE_WAIT_MS,
  MIGRATION_PATH_PREFIX,
  WRITE_POSITION_HEADER_LC,
  parseWritePosition,
  type ApplyRequest,
  type ApplyResponse,
  type ChangesResponse,
  type ExportResponse,
  type GateRequest,
  type GateResponse,
  type PositionResponse,
  type WatermarkDirection,
  type WatermarkInput,
  type WatermarkRecord,
  type WritePositions,
} from '@opt2/platform/migration-kit';
import { SERVICE_CALL_TIMEOUT_MS, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { callQueueControl, type QueueControlOp, type QueueControlResult } from '@opt2/platform/tasks';
import type { components, paths } from '../generated/clients/strategies-content.js';
import type { DataOwner, UnitCatalog } from './units.js';

const APPLY_PATH = `${MIGRATION_PATH_PREFIX}/apply`;
const EXPORT_PATH = `${MIGRATION_PATH_PREFIX}/export`;
const CHANGES_PATH = `${MIGRATION_PATH_PREFIX}/changes`;
const POSITION_PATH = `${MIGRATION_PATH_PREFIX}/position`;
const WATERMARK_PATH = `${MIGRATION_PATH_PREFIX}/watermark`;
const GATE_PATH = `${MIGRATION_PATH_PREFIX}/gate`;
const OBJECTS_PATH = '/internal/v1/migration/objects' satisfies keyof paths;
const SITEMONITOR_STATE_PATH = '/internal/v1/sitemonitor/state';
const ADOPT_TASKS_PATH = '/internal/v1/migration/adopt-scheduled-tasks';
const CANCEL_ADOPTED_TASKS_PATH = '/internal/v1/migration/cancel-adopted-scheduled-tasks';

const CONTENT: DataOwner = 'strategies-content';
const PROGRAMS_SITES: DataOwner = 'programs-sites';
const COMMUNICATIONS: DataOwner = 'communications';

/** Error code of the owner's 409 answer to a refused gate compare-and-set. */
const GATE_CONFLICT_CODE = 'gate-conflict';

/** strategies-content `FileObject`: the stored key, size and SHA-256; `created` is false when the same hash was already stored. */
export type FileObject = components['schemas']['FileObject'];

/** Query of strategies-content's object upload: tenant, legacy `fileID`, variant suffix, extension, content type and body SHA-256. */
export type PutObjectParams = paths[typeof OBJECTS_PATH]['post']['parameters']['query'];

/** An apply answer with the write positions its response header reported. */
export type ApplyResult = ApplyResponse & { writePositions: WritePositions };

/** A stored object with the write positions its response header reported. */
export type PutObjectResult = FileObject & { writePositions: WritePositions };

/** Query of one export page of a unit in one tenant; owners export by unit, and each table of a page names its legacy table. */
export interface ExportParams {
  unit: string;
  tenantId: string;
  /** One program of a unit folded from `Program_<id>` tables. */
  programId?: number;
  /** `next` of the previous page; absent for the first page, which carries the object manifest or, for an owner paging it, its first page. */
  after?: string;
  limit?: number;
}

/** Query of one change-feed page; `after` is cursor text, `CURSOR_START` before the first row. */
export interface ChangesParams {
  tenantId: string;
  after: string;
  limit?: number;
}

/** Query of a position read: which tenants' inboxes hold `eventIds`, and the published events of `publishedTopics`. */
export interface PositionParams {
  eventIds?: readonly string[];
  publishedTopics?: readonly string[];
}

/** A watermark to store: a `POST /watermark` body, or a stored record whose null sequence or LSN is sent as absent. */
export type WatermarkWrite = WatermarkInput | WatermarkRecord;

/** programs-sites `SiteMonitorState`: the orchestrator cursor in legacy wall-clock form, null before the first run or seed. */
export interface SiteMonitorState {
  lastMonitored: string | null;
  updatedAt: string | null;
}

/** programs-sites `SiteMonitorStateInput`: the cursor to seed. */
export interface SiteMonitorStateInput {
  lastMonitored: string;
}

/** One fixture survey ACF task of communications' `AdoptScheduledTasksRequest`; `scheduleTime` is legacy wall-clock time. */
export interface AdoptScheduledTask {
  name: string;
  siteId: string;
  scheduleTime: string;
  scheduleVersion: number;
}

/** communications `AdoptScheduledTasksRequest`: the tasks as captured before their deletion. */
export interface AdoptScheduledTasksRequest {
  tasks: AdoptScheduledTask[];
}

/** communications `AdoptScheduledTasksResult`: tasks newly adopted, already present by name, and scheduled immediately for a past time. */
export interface AdoptScheduledTasksResult {
  adopted: number;
  existing: number;
  scheduledImmediately: number;
}

/** communications `CancelAdoptedTasksRequest`; every adopted task is cancelled when `names` is absent. */
export interface CancelAdoptedTasksRequest {
  names?: string[];
}

/** communications `CancelAdoptedTasksResult`. */
export interface CancelAdoptedTasksResult {
  cancelled: number;
}

/** Endpoints of the data owners, each called with the client's own invocation identity and never a user token. */
export interface OwnersClient {
  /** Applies one batch; a repeated `batchId` answers `duplicate: true`. */
  apply(owner: DataOwner, req: ApplyRequest): Promise<ApplyResult>;
  /** One export page. */
  export(owner: DataOwner, params: ExportParams): Promise<ExportResponse>;
  /** Every export page from `params.after` on, in order, each fetched only when the previous one has been consumed. */
  exportPages(owner: DataOwner, params: ExportParams): AsyncIterable<ExportResponse>;
  /** One commit-safe change-feed page: the `ChangesPage` fields with legacy projections and operation statuses. */
  changes(owner: DataOwner, params: ChangesParams): Promise<ChangesResponse>;
  /** Current write position and drain counts, with the receipts and published events `params` asks for. */
  position(owner: DataOwner, params?: PositionParams): Promise<PositionResponse>;
  /** @returns the watermark of `legacyTable` and `direction`, or null when the owner has none. */
  watermark(owner: DataOwner, legacyTable: string, direction: WatermarkDirection): Promise<WatermarkRecord | null>;
  /** Stores a watermark and returns it as stored. */
  putWatermark(owner: DataOwner, record: WatermarkWrite): Promise<WatermarkRecord>;
  /** Closes, re-phases, opens or reads unit gates. @throws GateConflict when the owner refuses the holder compare-and-set. */
  gate(owner: DataOwner, req: GateRequest): Promise<GateResponse>;
  /** Stores one legacy file-store object in strategies-content's `content-files`. */
  putObject(params: PutObjectParams, bytes: Uint8Array): Promise<PutObjectResult>;
  /** Reads programs-sites' site-monitor cursor. */
  siteMonitorState(): Promise<SiteMonitorState>;
  /** Seeds programs-sites' site-monitor cursor. */
  putSiteMonitorState(input: SiteMonitorStateInput): Promise<SiteMonitorState>;
  /** Adopts fixture survey ACF tasks as communications' Cloud Tasks, idempotent by name. */
  adoptScheduledTasks(req: AdoptScheduledTasksRequest): Promise<AdoptScheduledTasksResult>;
  /** Cancels communications' adopted tasks. */
  cancelAdoptedScheduledTasks(req: CancelAdoptedTasksRequest): Promise<CancelAdoptedTasksResult>;
  /** Pauses, resumes or ensures the chain of one queue on the service that creates it. */
  queueControl(service: DataOwner, queue: string, op: QueueControlOp): Promise<QueueControlResult>;
}

/** Inputs of {@link createOwnersClient}. */
export interface CreateOwnersClientOptions {
  /** A service client whose caller holds `platform.migration`. */
  client: ServiceClient;
  /** Units and owners of the ownership file; the endpoints called here need none of its facts. */
  catalog: UnitCatalog;
}

/** An owner answered with a non-2xx status; `body` is the decoded answer. */
export class OwnerCallError extends Error {
  override readonly name: string = 'OwnerCallError';
  readonly owner: DataOwner;
  readonly method: ServiceRequest['method'];
  readonly path: string;
  readonly status: number;
  readonly body: unknown;

  constructor(
    owner: DataOwner,
    method: ServiceRequest['method'],
    path: string,
    status: number,
    body: unknown,
    message = `Owner ${owner} answered ${method} ${path} with HTTP ${String(status)}`,
  ) {
    super(message);
    this.owner = owner;
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/** The owner refused a gate compare-and-set: `units` are closed by another holder, or not held by this one. */
export class GateConflict extends OwnerCallError {
  override readonly name: string = 'GateConflict';
  readonly units: string[];

  constructor(owner: DataOwner, body: { error: string; units: string[] }) {
    super(owner, 'POST', GATE_PATH, 409, body, `Owner ${owner} refused the gate compare-and-set for ${body.units.join(', ')}`);
    this.units = body.units;
  }
}

interface CallOptions {
  query?: ServiceRequest['query'];
  json?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
  timeoutMs?: ServiceRequest['timeoutMs'];
}

/** Bound of a gate call: the owner's gate wait plus the call bound when closing or re-phasing, else the client's default. */
function gateCallTimeoutMs(req: GateRequest): number | undefined {
  if (req.op === 'close') return (req.timeoutMs ?? GATE_WAIT_MS) + SERVICE_CALL_TIMEOUT_MS;
  return req.op === 'phase' ? GATE_WAIT_MS + SERVICE_CALL_TIMEOUT_MS : undefined;
}

function isGateConflictBody(body: unknown): body is { error: string; units: string[] } {
  const candidate = body as { error?: unknown; units?: unknown } | null | undefined;
  return candidate?.error === GATE_CONFLICT_CODE && Array.isArray(candidate.units);
}

function failure(owner: DataOwner, method: ServiceRequest['method'], path: string, response: ServiceResponse): OwnerCallError {
  if (path === GATE_PATH && response.status === 409 && isGateConflictBody(response.body)) return new GateConflict(owner, response.body);
  return new OwnerCallError(owner, method, path, response.status, response.body);
}

/** Positions of every `X-Opt2-Write-Position` header, whatever the case of its name; empty when there is none. */
function writePositionsOf(headers: ServiceResponse['headers']): WritePositions {
  const values = Object.entries(headers).flatMap(([name, value]) => (name.toLowerCase() === WRITE_POSITION_HEADER_LC ? [value].flat() : []));
  return parseWritePosition(values);
}

function decimal(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/** Creates the owners client over `options.client`; it keeps no state of its own. */
export function createOwnersClient(options: CreateOwnersClientOptions): OwnersClient {
  const { client } = options;

  async function call<T>(owner: DataOwner, method: ServiceRequest['method'], path: string, opts: CallOptions = {}): Promise<ServiceResponse<T>> {
    // These routes accept only the calling workload's invocation identity, so a request context's user token is never forwarded.
    const response = await client.request<T>({ ...opts, service: owner, method, path, userToken: null });
    if (response.status >= 200 && response.status <= 299) return response;
    throw failure(owner, method, path, response);
  }

  async function exportPage(owner: DataOwner, params: ExportParams): Promise<ExportResponse> {
    const query = {
      unit: params.unit,
      tenantId: params.tenantId,
      programId: decimal(params.programId),
      after: params.after,
      limit: decimal(params.limit),
    };
    return (await call<ExportResponse>(owner, 'GET', EXPORT_PATH, { query })).body;
  }

  async function* exportPages(owner: DataOwner, params: ExportParams): AsyncGenerator<ExportResponse, void, undefined> {
    let after = params.after;
    for (;;) {
      const page = await exportPage(owner, { ...params, after });
      yield page;
      if (page.next === null) return;
      after = page.next;
    }
  }

  return {
    async apply(owner, req) {
      const response = await call<ApplyResponse>(owner, 'POST', APPLY_PATH, { json: req });
      return { ...response.body, writePositions: writePositionsOf(response.headers) };
    },

    export: exportPage,

    exportPages,

    async changes(owner, params) {
      const query = { tenantId: params.tenantId, after: params.after, limit: decimal(params.limit) };
      return (await call<ChangesResponse>(owner, 'GET', CHANGES_PATH, { query })).body;
    },

    async position(owner, params = {}) {
      const query = { eventIds: params.eventIds?.join(','), publishedTopics: params.publishedTopics?.join(',') };
      return (await call<PositionResponse>(owner, 'GET', POSITION_PATH, { query })).body;
    },

    async watermark(owner, legacyTable, direction) {
      // The owner answers a list; one (legacy table, direction) pair holds at most one watermark.
      const response = await call<WatermarkRecord[]>(owner, 'GET', WATERMARK_PATH, { query: { legacyTable, direction } });
      return response.body[0] ?? null;
    },

    async putWatermark(owner, record) {
      // The owner's body schema takes an unknown sequence or LSN as absent, never null; JSON drops undefined members.
      const json: WatermarkInput = { ...record, snapshotSeq: record.snapshotSeq ?? undefined, backupLsn: record.backupLsn ?? undefined };
      return (await call<WatermarkRecord>(owner, 'POST', WATERMARK_PATH, { json })).body;
    },

    async gate(owner, req) {
      return (await call<GateResponse>(owner, 'POST', GATE_PATH, { json: req, timeoutMs: gateCallTimeoutMs(req) })).body;
    },

    async putObject(params, bytes) {
      const response = await call<FileObject>(CONTENT, 'POST', OBJECTS_PATH, {
        query: params,
        body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        headers: { 'content-type': 'application/octet-stream' },
      });
      return { ...response.body, writePositions: writePositionsOf(response.headers) };
    },

    async siteMonitorState() {
      return (await call<SiteMonitorState>(PROGRAMS_SITES, 'GET', SITEMONITOR_STATE_PATH)).body;
    },

    async putSiteMonitorState(input) {
      return (await call<SiteMonitorState>(PROGRAMS_SITES, 'PUT', SITEMONITOR_STATE_PATH, { json: input })).body;
    },

    async adoptScheduledTasks(req) {
      return (await call<AdoptScheduledTasksResult>(COMMUNICATIONS, 'POST', ADOPT_TASKS_PATH, { json: req })).body;
    },

    async cancelAdoptedScheduledTasks(req) {
      return (await call<CancelAdoptedTasksResult>(COMMUNICATIONS, 'POST', CANCEL_ADOPTED_TASKS_PATH, { json: req })).body;
    },

    queueControl(service, queue, op) {
      return callQueueControl(client, { service, queue, op });
    },
  };
}
