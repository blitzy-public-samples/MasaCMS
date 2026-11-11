// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import {
  CanonicalEncodingError,
  MIGRATION_PATH_PREFIX,
  encodeRow,
  formatCanonicalTimestamp,
  type ApplyRequest,
  type ApplyResponse,
  type CanonicalColumn,
  type CanonicalType,
} from '@opt2/platform/migration-kit';
import type { ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { sha256Hex, toHex } from './bytes.js';
import { siteForProgram, type SeedConfig } from './config.js';
import type { Dataset } from './dataset.js';
import { failureText, idText, kindOf, nameText, printable } from './errors.js';
import {
  FIXTURE_TABLE_SPECS,
  fixtureKey,
  fixtureKeys,
  specForKey,
  type FixtureRow,
  type FixtureTableSpec,
  type FixtureValue,
  type OwningService,
} from './fixture-tables.js';
import { stableId } from './ids.js';

/** Sends one service call; the platform service client satisfies it. */
export interface DirectClient {
  request<T>(req: ServiceRequest): Promise<ServiceResponse<T>>;
}

/** Inputs of `runDirect`; `log` receives one line per seeded table. */
export interface DirectOptions {
  client: DirectClient;
  config: SeedConfig;
  log: (line: string) => void;
}

/** One apply batch: at most `chunkRows` rows of one fixture table and site, under that site's tenant. */
export interface DirectBatch {
  service: OwningService;
  /** Dataset key, `synthetic.<table>` or `Program_<id>.<table>`. */
  legacyTable: string;
  siteID: string;
  tenantId: string;
  chunkIndex: number;
  batchId: string;
  rows: FixtureRow[];
}

/** Totals of a direct run; `byService` counts rows sent per owning service. */
export interface DirectResult {
  batches: number;
  rows: number;
  byService: Record<string, number>;
}

const APPLY_PATH = `${MIGRATION_PATH_PREFIX}/apply`;
const APPLY_ORIGIN = 'backfill';
const AUDIT_TABLE = 'audit_entry';
const GENESIS_HASH = Buffer.alloc(32);
const COLUMN_SPEC = /^([A-Za-z_]\w*)(?::([sitb]|d(\d+)))?$/;
const MACHINE_CODE = /^[A-Za-z][\w.-]{0,63}$/;

/** Columns of `list` (`name` or `name:<tag>`, `d<scale>` for decimals; untagged is `s`), frozen. */
function parseColumns(table: string, list: string): readonly CanonicalColumn[] {
  return Object.freeze(
    list.split(' ').map((entry): CanonicalColumn => {
      const match = COLUMN_SPEC.exec(entry);
      if (match === null) throw new SyntaxError(`Fixture column ${table}.${entry} is not name[:tag]`);
      const [, name = '', tag = 's', scale] = match;
      return Object.freeze(scale === undefined ? { name, type: tag as CanonicalType } : { name, type: 'd', scale: Number(scale) });
    }),
  );
}

/** Canonical columns of every fixture table in its `legacy-fixtures/sql` DDL catalog order; the DDL holds the only other copy of these types, and an owner's apply rejects any mismatch. */
export const FIXTURE_COLUMNS: Readonly<Record<string, readonly CanonicalColumn[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries({
      person_archive: 'archive_id person_id siteID effective_from:t archived_at:t archived_by_id archived_by',
      timesheet: 'timesheet_id person_id siteID period_start:t period_end:t due_date:t created:t lastUpdate:t lastUpdateByID',
      timesheet_day: 'day_id timesheet_id work_date:t hours:d4 state lastUpdate:t lastUpdateByID',
      approval_action: 'action_id day_id action role from_state to_state actor_user_id comment created:t',
      blackout: 'blackout_id day_id person_id archive_id reason created:t',
      finance_record: 'record_id siteID title amount:d4 period state version:i created:t createdByID lastUpdate:t lastUpdateByID',
      finance_record_version: 'version_id record_id version:i state title amount:d4 period action actor_user_id created:t',
      finance_attachment: 'attachment_id record_id file_name content_type size_bytes:i sha256 content:b created:t createdByID',
      survey: 'survey_id siteID title status created:t createdByID lastUpdate:t lastUpdateByID launched_at:t',
      survey_schedule: 'schedule_id survey_id launch_at:t schedule_version:i task_name task_token_hash created:t',
      survey_reminder: 'reminder_id survey_id offset_minutes:i remind_at:t task_name task_token_hash sent_at:t',
      survey_target: 'target_id survey_id siteID group_name created:t',
      survey_response: 'response_id survey_id siteID respondentSiteID respondent_user_id answers created:t',
      export_definition: 'definition_id siteID name source columns',
      export_job:
        'job_id siteID definition_id format state requested_by_id created:t started_at:t finished_at:t error file_name content_type output:b output_sha256',
      message_template: 'template_id siteID name subject body_text body_html created:t lastUpdate:t',
      message: 'message_id siteID template_id to_address from_address subject body_text body_html state created:t sent_at:t',
      delivery_status: 'status_id message_id status detail mailpit_id recorded_at:t',
      signature_request: 'request_id siteID document_name document_sha256 document:b signer_user_id state created:t createdByID',
      signature: 'signature_id request_id typed_name signer_user_id signed_at:t',
      audit_entry: 'entry_id request_id seq:i action actor_user_id detail at:t prev_hash:b entry_hash:b',
    }).map(([table, list]): [string, readonly CanonicalColumn[]] => [table, parseColumns(table, list)]),
  ),
);

const SPEC_BY_TABLE: ReadonlyMap<string, FixtureTableSpec> = new Map(FIXTURE_TABLE_SPECS.map((spec) => [spec.table, spec]));

/** Catalog columns of fixture table `table`; throws when the catalog has none. */
function columnsOf(table: string): readonly CanonicalColumn[] {
  const found = FIXTURE_COLUMNS[table];
  if (found === undefined) throw new RangeError(`No fixture column catalog for ${table}`);
  return found;
}

/** Text value of `column`; throws naming the table, the column and the kind of any other value. */
function textOf(key: string, row: FixtureRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw printable(new TypeError(`direct: ${key} row needs text ${column}, got ${kindOf(value)}`));
  return value;
}

/** `row` with the catalog columns first, in catalog order, and any other keys after them. */
function inCatalogOrder(catalog: readonly CanonicalColumn[], row: FixtureRow): FixtureRow {
  const ordered: FixtureRow = {};
  for (const { name } of catalog) {
    const value = row[name];
    if (value !== undefined) ordered[name] = value;
  }
  return Object.assign(ordered, row);
}

/** Audit rows of `key` with `seq`, `prev_hash` and `entry_hash` chained per request in array order, as hex. */
export function chainAuditEntries(key: string, rows: readonly FixtureRow[]): FixtureRow[] {
  const catalog = columnsOf(AUDIT_TABLE);
  const heads = new Map<string, { seq: number; hash: Buffer }>();
  return rows.map((row) => {
    const requestId = textOf(key, row, 'request_id');
    const head = heads.get(requestId);
    const seq = (head?.seq ?? 0) + 1;
    const prev = head?.hash ?? GENESIS_HASH;
    // usp_audit_append: SHA-256 over prev_hash and the UTF-16LE CONCAT of the entry, NULLs as '' and `at` at datetime precision.
    const canonical = [
      requestId,
      seq,
      textOf(key, row, 'action'),
      row.actor_user_id ?? '',
      row.detail ?? '',
      formatCanonicalTimestamp(textOf(key, row, 'at')),
    ].join('|');
    const entryHash = sha256Hex(Buffer.concat([prev, Buffer.from(canonical, 'utf16le')]));
    heads.set(requestId, { seq, hash: Buffer.from(entryHash, 'hex') });
    return inCatalogOrder(catalog, { ...row, seq, prev_hash: toHex(prev), entry_hash: entryHash });
  });
}

/** Throws naming the table and row unless `row` holds exactly the catalog columns. */
function assertColumns(key: string, spec: FixtureTableSpec, catalog: readonly CanonicalColumn[], row: FixtureRow): void {
  const names = new Set(catalog.map(({ name }) => name));
  const missing = catalog.filter(({ name }) => !Object.hasOwn(row, name)).map(({ name }) => name);
  const extra = Object.keys(row).filter((name) => !names.has(name));
  if (missing.length > 0 || extra.length > 0) {
    const extraNames = extra.map(nameText).join(',') || '-';
    throw printable(
      new Error(`direct: ${key} row ${spec.key}=${idText(row[spec.key])} does not match its DDL columns (missing ${missing.join(',') || '-'}; extra ${extraNames})`),
    );
  }
}

/** Site of `row` by its spec's rule; `sites` holds the sites of rows already planned, per dataset key and row key. */
function siteOf(
  key: string,
  spec: FixtureTableSpec,
  programId: number | null,
  row: FixtureRow,
  config: SeedConfig,
  sites: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string {
  const rule = spec.site;
  let site: FixtureValue | undefined;
  let source: string;
  if (rule.kind === 'column') {
    site = row[rule.column];
    source = `column ${rule.column}`;
  } else if (rule.kind === 'program') {
    site = programId === null ? undefined : siteForProgram(config, programId);
    source = `program ${String(programId)}`;
  } else {
    const parent = SPEC_BY_TABLE.get(rule.table);
    const parentKey = parent === undefined ? rule.table : fixtureKey(parent, parent.scope === 'program' ? (programId ?? undefined) : undefined);
    const foreign = row[rule.foreignKey];
    site = foreign === null || foreign === undefined ? undefined : sites.get(parentKey)?.get(String(foreign));
    source = `parent ${parentKey}.${rule.foreignKey}=${idText(foreign)}`;
  }
  if (typeof site !== 'string' || site === '') {
    throw printable(new Error(`direct: ${key} row ${spec.key}=${idText(row[spec.key])} has no resolvable site (${source})`));
  }
  return site;
}

/** Throws unless the dataset holds exactly the fixture tables `config` declares. */
function assertFixtureKeys(dataset: Dataset, keys: readonly string[]): void {
  const missing = keys.filter((key) => !Object.hasOwn(dataset.fixtures, key));
  const extra = Object.keys(dataset.fixtures).filter((key) => !keys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const extraKeys = extra.map(nameText).join(',') || '-';
    throw printable(new Error(`direct: dataset fixture tables differ from the configuration (missing ${missing.join(',') || '-'}; extra ${extraKeys})`));
  }
}

/** Apply batches of every non-empty fixture table, parents first, each (table, site) chunked by `config.chunkRows`. */
export function planDirectBatches(dataset: Dataset, config: SeedConfig): DirectBatch[] {
  const keys = fixtureKeys(config);
  assertFixtureKeys(dataset, keys);
  const sites = new Map<string, Map<string, string>>();
  const batches: DirectBatch[] = [];
  for (const key of keys) {
    const source = dataset.fixtures[key] ?? [];
    if (source.length === 0) continue;
    const { spec, programId } = specForKey(key);
    const catalog = columnsOf(spec.table);
    const rows = spec.table === AUDIT_TABLE ? chainAuditEntries(key, source) : source;
    const resolved = new Map<string, string>();
    const bySite = new Map<string, FixtureRow[]>();
    for (const row of rows) {
      assertColumns(key, spec, catalog, row);
      const siteID = siteOf(key, spec, programId, row, config, sites);
      resolved.set(String(row[spec.key]), siteID);
      const group = bySite.get(siteID);
      if (group === undefined) bySite.set(siteID, [row]);
      else group.push(row);
    }
    sites.set(key, resolved);
    for (const [siteID, siteRows] of bySite) {
      const tenantId = tenantIdForSite(siteID);
      for (let chunkIndex = 0; chunkIndex * config.chunkRows < siteRows.length; chunkIndex += 1) {
        const start = chunkIndex * config.chunkRows;
        batches.push({
          service: spec.service,
          legacyTable: key,
          siteID,
          tenantId,
          chunkIndex,
          batchId: stableId(dataset.digest, key, siteID, chunkIndex),
          rows: siteRows.slice(start, start + config.chunkRows),
        });
      }
    }
  }
  return batches;
}

/** Owning services of the configured fixture tables that hold rows in `dataset`, once each, in plan order. */
export function directServices(dataset: Dataset, config: SeedConfig): OwningService[] {
  const owners = fixtureKeys(config)
    .filter((key) => (dataset.fixtures[key]?.length ?? 0) > 0)
    .map((key) => specForKey(key).spec.service);
  return [...new Set(owners)];
}

/** `ApplyRequest` of `batch`: rows canonically encoded over the table's catalog columns, upserted as a backfill. */
export function applyRequestFor(batch: DirectBatch): ApplyRequest {
  const { spec } = specForKey(batch.legacyTable);
  const catalog = columnsOf(spec.table);
  const binary = catalog.filter(({ type }) => type === 'b').map(({ name }) => name);
  return {
    batchId: batch.batchId,
    origin: APPLY_ORIGIN,
    legacyTable: batch.legacyTable,
    tenantId: batch.tenantId,
    columns: [...catalog],
    rows: batch.rows.map((row) => {
      // Fixture binaries are bare lowercase hex; the canonical encoder takes them \x-prefixed and validates the digits.
      const input: Record<string, unknown> = { ...row };
      for (const name of binary) if (typeof row[name] === 'string') input[name] = `\\x${row[name]}`;
      try {
        return { op: 'upsert' as const, row: encodeRow(catalog, input) };
      } catch (err) {
        // Encoding errors name types and columns, never values; anything else is reduced to its class.
        const reason = err instanceof CanonicalEncodingError ? err.message : failureText(err);
        throw printable(new Error(`direct: ${batch.legacyTable} row ${spec.key}=${idText(row[spec.key])} does not encode: ${reason}`, { cause: err }));
      }
    }),
  };
}

/** Machine `code` of a legacy error envelope body, never its message; undefined for any other body or code. */
function legacyErrorOf(body: unknown): string | undefined {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && MACHINE_CODE.test(code) ? code : undefined;
}

/** Batch identity as failure messages name it. */
function describeBatch(batch: DirectBatch): string {
  return `${batch.service} ${batch.legacyTable} site=${batch.siteID} chunk=${batch.chunkIndex} batch=${batch.batchId}`;
}

/** Sends every planned batch to its owner's migration apply endpoint, in plan order; throws on the first failure. */
export async function runDirect(dataset: Dataset, options: DirectOptions): Promise<DirectResult> {
  const { client, config, log } = options;
  // Every batch is encoded before the first is sent, so a row that cannot encode stops the run before any write.
  const planned = planDirectBatches(dataset, config).map((batch) => ({ batch, json: applyRequestFor(batch) }));
  const result: DirectResult = { batches: 0, rows: 0, byService: {} };
  let tableRows = 0;
  let tableBatches = 0;
  for (const [index, { batch, json }] of planned.entries()) {
    let response: ServiceResponse<ApplyResponse>;
    try {
      response = await client.request<ApplyResponse>({ service: batch.service, method: 'POST', path: APPLY_PATH, json, userToken: null });
    } catch (err) {
      throw printable(new Error(`direct: ${describeBatch(batch)} failed: ${failureText(err)}`, { cause: err }));
    }
    if (response.status < 200 || response.status > 299) {
      const legacyError = legacyErrorOf(response.body);
      throw printable(new Error(`direct: ${describeBatch(batch)} answered ${response.status}${legacyError === undefined ? '' : ` (${legacyError})`}`));
    }
    result.batches += 1;
    result.rows += batch.rows.length;
    result.byService[batch.service] = (result.byService[batch.service] ?? 0) + batch.rows.length;
    tableRows += batch.rows.length;
    tableBatches += 1;
    if (planned[index + 1]?.batch.legacyTable !== batch.legacyTable) {
      log(`direct ${batch.service} ${batch.legacyTable} rows=${tableRows} batches=${tableBatches}`);
      tableRows = 0;
      tableBatches = 0;
    }
  }
  return result;
}
