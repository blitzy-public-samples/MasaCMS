// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import {
  CanonicalEncodingError,
  encodeRow,
  postApply,
  type ApplyRequest,
  type ApplyResponse,
  type CanonicalColumn,
  type CanonicalType,
} from '@opt2/platform/migration-kit';
import type { ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import type { SeedConfig } from './config.js';
import type { Dataset } from './dataset.js';
import { failureText, idText, nameText, printable } from './errors.js';
import { fixtureKeys, specForKey, type FixtureRow, type FixtureTableSpec, type OwningService } from './fixture-tables.js';
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
  /** Dataset key, `synthetic.<table>`. */
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

const APPLY_ORIGIN = 'backfill';
const COLUMN_SPEC = /^([A-Za-z_]\w*)(?::([sit]|d(\d+)))?$/;
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
    }).map(([table, list]): [string, readonly CanonicalColumn[]] => [table, parseColumns(table, list)]),
  ),
);

/** Catalog columns of fixture table `table`; throws when the catalog has none. */
function columnsOf(table: string): readonly CanonicalColumn[] {
  const found = FIXTURE_COLUMNS[table];
  if (found === undefined) throw new RangeError(`No fixture column catalog for ${table}`);
  return found;
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

/** Tenant site of `row`, read from its spec's site column. */
function siteOf(key: string, spec: FixtureTableSpec, row: FixtureRow): string {
  const site = row[spec.siteColumn];
  if (typeof site !== 'string' || site === '') {
    throw printable(new Error(`direct: ${key} row ${spec.key}=${idText(row[spec.key])} has no resolvable site (column ${spec.siteColumn})`));
  }
  return site;
}

/** Throws unless the dataset holds exactly the configured fixture tables. */
function assertFixtureKeys(dataset: Dataset, keys: readonly string[]): void {
  const missing = keys.filter((key) => !Object.hasOwn(dataset.fixtures, key));
  const extra = Object.keys(dataset.fixtures).filter((key) => !keys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const extraKeys = extra.map(nameText).join(',') || '-';
    throw printable(new Error(`direct: dataset fixture tables differ from the configuration (missing ${missing.join(',') || '-'}; extra ${extraKeys})`));
  }
}

/** Apply batches of every non-empty fixture table, each (table, site) chunked by `config.chunkRows`. */
export function planDirectBatches(dataset: Dataset, config: SeedConfig): DirectBatch[] {
  const keys = fixtureKeys();
  assertFixtureKeys(dataset, keys);
  const batches: DirectBatch[] = [];
  for (const key of keys) {
    const rows = dataset.fixtures[key] ?? [];
    if (rows.length === 0) continue;
    const spec = specForKey(key);
    const catalog = columnsOf(spec.table);
    const bySite = new Map<string, FixtureRow[]>();
    for (const row of rows) {
      assertColumns(key, spec, catalog, row);
      const siteID = siteOf(key, spec, row);
      const group = bySite.get(siteID);
      if (group === undefined) bySite.set(siteID, [row]);
      else group.push(row);
    }
    for (const [siteID, siteRows] of bySite) {
      const tenantId = tenantIdForSite(siteID);
      for (let chunkIndex = 0; chunkIndex * config.chunkRows < siteRows.length; chunkIndex += 1) {
        const start = chunkIndex * config.chunkRows;
        const chunk = siteRows.slice(start, start + config.chunkRows);
        batches.push({
          service: spec.service,
          legacyTable: key,
          siteID,
          tenantId,
          chunkIndex,
          batchId: stableId(dataset.digest, key, siteID, start, chunk.length),
          rows: chunk,
        });
      }
    }
  }
  return batches;
}

/** Owning services of the configured fixture tables that hold rows in `dataset`, once each, in plan order. */
export function directServices(dataset: Dataset): OwningService[] {
  const owners = fixtureKeys()
    .filter((key) => (dataset.fixtures[key]?.length ?? 0) > 0)
    .map((key) => specForKey(key).service);
  return [...new Set(owners)];
}

/** `ApplyRequest` of `batch`: rows canonically encoded over the table's catalog columns, upserted as a backfill. */
export function applyRequestFor(batch: DirectBatch): ApplyRequest {
  const spec = specForKey(batch.legacyTable);
  const catalog = columnsOf(spec.table);
  return {
    batchId: batch.batchId,
    origin: APPLY_ORIGIN,
    legacyTable: batch.legacyTable,
    tenantId: batch.tenantId,
    columns: [...catalog],
    rows: batch.rows.map((row) => {
      try {
        return { op: 'upsert' as const, row: encodeRow(catalog, row) };
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
      response = await postApply(client, batch.service, json);
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
