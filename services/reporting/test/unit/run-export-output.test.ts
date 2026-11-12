// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export output through runExport against a throwaway `reporting` schema and the local storage adapter: streamed puts, recorded digests and failures. */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import type { ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter, type PutBody, type StoragePort } from '@opt2/platform/storage';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { runExport, type RunExportResult } from '../../src/domain/run-export.js';
import { createReportingRepository } from '../../src/repo/repository.js';
import { EXPORT_BUCKET, UNITS, type ExportFormat, type ExportJobRow } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const REQUESTER = '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A';
const COLUMNS = ['record_id', 'title', 'amount', 'created'];
const RECORD_COUNT = 2_500;
const PAGE_SIZE = 1_000;
const FORMATS: readonly ExportFormat[] = ['csv', 'xlsx', 'pdf'];
const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Finance record `i` of `siteId`, in the producer's value forms. */
function record(siteId: string, i: number) {
  return {
    record_id: `F1D51F56-09DF-B1D1-${i.toString(16).toUpperCase().padStart(16, '0')}`,
    siteid: siteId,
    title: `Travel 2026-06 #${String(i)}`,
    amount: '1250.5000',
    period: '2026-06',
    state: 'IN-PROGRESS',
    version: 1,
    created: `2026-06-02 09:15:00.${String(i % 1000).padStart(3, '0')}`,
    createdbyid: REQUESTER,
    lastupdate: '',
    lastupdatebyid: '',
  };
}

/** A finance producer of `count` records of `siteId` in 1000-record pages; `fail.page` answers `fail.failure` instead. */
function financeClient(
  siteId: string,
  fail?: { page: number; failure: ServiceResponse | Error },
  count = RECORD_COUNT,
): { client: ServiceClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      await nextTurn();
      const page = Number(req.query?.page);
      if (page === fail?.page) {
        if (fail.failure instanceof Error) throw fail.failure;
        return fail.failure as ServiceResponse<T>;
      }
      const from = (page - 1) * PAGE_SIZE;
      const data = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, count - from)) }, (_, k) => record(siteId, from + k));
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { data, total: count } as T };
    },
    async close() {},
  };
  return { client, calls };
}

const available = await pgAvailable();

describe.skipIf(!available)('export output through runExport', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let local: LocalStorageAdapter;
  let sites = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'run-export-output-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'run-export-output-test', state: 'open' });
    stateDir = await mkdtemp(join(tmpdir(), 'reporting-export-output-'));
    local = await createLocalStorageAdapter({ stateDir, hmacKey: 'run-export-output-test-key' });
  });

  afterAll(async () => {
    await handle.drop();
    await rm(stateDir, { recursive: true, force: true });
  });

  interface QueuedJob {
    tenantId: string;
    siteId: string;
    jobId: string;
    format: ExportFormat;
  }

  /** A queued `format` job of a new site's finance-records definition of `columns`. */
  async function queuedJob(format: ExportFormat, columns = JSON.stringify(COLUMNS)): Promise<QueuedJob> {
    sites += 1;
    const siteId = `export-output-${String(sites)}`;
    const tenantId = tenantIdForSite(siteId);
    const definitionId = cfUuid();
    const jobId = cfUuid();
    await handle.app.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
         VALUES ($1, $2, $3, 'Finance records', 'finance.records', $4)`,
        [tenantId, definitionId, siteId, columns],
      );
      await tx.query(
        `INSERT INTO ${handle.schema}.export_job (tenant_id, job_id, siteid, definition_id, format, state, requested_by_id, created)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7)`,
        [tenantId, jobId, siteId, definitionId, format, REQUESTER, CLOCK.now()],
      );
    });
    return { tenantId, siteId, jobId, format };
  }

  function run(job: QueuedJob, storage: StoragePort, client: ServiceClient): Promise<RunExportResult> {
    const repository = createReportingRepository({ db: handle.app, storage, clock: CLOCK });
    return runExport(
      { db: handle.app, repository, storage, clock: CLOCK, client },
      { tenantId: job.tenantId, jobId: job.jobId, payload: { jobId: job.jobId, asOf: '2026-06-30', userToken: 'requester-token' } },
    );
  }

  async function storedRow(job: QueuedJob): Promise<ExportJobRow> {
    const { rows } = await handle.app.withTenant(job.tenantId, (tx) =>
      tx.query<ExportJobRow>(`SELECT * FROM ${handle.schema}.export_job WHERE tenant_id = $1 AND job_id = $2`, [job.tenantId, job.jobId]),
    );
    return rows[0] as ExportJobRow;
  }

  /** Files of `job` in the export bucket, partial writes included. */
  async function objectFiles(job: QueuedJob): Promise<string[]> {
    const files = await readdir(join(stateDir, 'storage', EXPORT_BUCKET), { recursive: true }).catch(() => []);
    return files.filter((file) => file.includes(job.jobId));
  }

  it.each(FORMATS)('streams every page of a %s export into storage under the SHA-256 the job records', async (format) => {
    const job = await queuedJob(format);
    const bodies: PutBody[] = [];
    const storage: StoragePort = {
      ...local,
      put: (bucket, key, body, opts) => {
        bodies.push(body);
        return local.put(bucket, key, body, opts);
      },
    };
    const { client, calls } = financeClient(job.siteId);

    await expect(run(job, storage, client)).resolves.toEqual({ outcome: 'done', state: 'done' });

    const row = await storedRow(job);
    expect(row).toMatchObject({ state: 'done', error: null, file_name: `export-${job.jobId}.${format}`, content_type: CONTENT_TYPES[format] });
    const bytes = await local.get(EXPORT_BUCKET, row.object_key ?? '');
    expect(row.output_sha256).toBe(sha256(bytes));
    expect(await local.head(EXPORT_BUCKET, row.object_key ?? '')).toEqual({ size: bytes.length, sha256: sha256(bytes), contentType: CONTENT_TYPES[format] });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBeInstanceOf(Readable);
    expect(calls.map((call) => call.query?.page)).toEqual(['1', '2', '3']);
    if (format === 'csv') expect(parse(bytes.toString('utf8'))).toHaveLength(RECORD_COUNT + 1);
  });

  it.each(FORMATS)('fails a %s export source-unavailable when a later page cannot be read, storing nothing', async (format) => {
    const job = await queuedJob(format);
    const { client } = financeClient(job.siteId, { page: 2, failure: { status: 503, headers: {}, body: undefined } });

    await expect(run(job, local, client)).resolves.toEqual({ outcome: 'failed', state: 'failed', error: 'source-unavailable' });

    expect(await storedRow(job)).toMatchObject({ state: 'failed', error: 'source-unavailable', object_key: null, output_sha256: null });
    expect(await objectFiles(job)).toEqual([]);
  });

  it.each<[string, StoragePort['put']]>([
    ['records a digest other than the streamed one', async (...args) => ({ ...(await local.put(...args)), sha256: '0'.repeat(64) })],
    [
      'stores the first chunk and resolves before the body ends',
      async (bucket, key, body, opts) => {
        let first: Buffer = Buffer.alloc(0);
        for await (const chunk of body as Readable) {
          first = chunk as Buffer;
          break;
        }
        return local.put(bucket, key, first, opts);
      },
    ],
  ])('fails the export export-failed when storage %s, removing the object', async (_case, put) => {
    const job = await queuedJob('csv');
    const storage: StoragePort = { ...local, put };

    await expect(run(job, storage, financeClient(job.siteId).client)).resolves.toEqual({ outcome: 'failed', state: 'failed', error: 'export-failed' });

    expect(await storedRow(job)).toMatchObject({ state: 'failed', error: 'export-failed', object_key: null, output_sha256: null });
    expect(await objectFiles(job)).toEqual([]);
  });

  it.each<[string, string]>([
    ['malformed JSON', '["record_id",'],
    ['not a list of column names', '{"record_id":true}'],
    ['a list naming a column finance records lack', '["record_id","no_such_column"]'],
  ])('fails the export export-failed after its one source read when the definition columns are %s, storing nothing', async (_case, columns) => {
    const job = await queuedJob('csv', columns);
    const { client, calls } = financeClient(job.siteId);

    await expect(run(job, local, client)).resolves.toEqual({ outcome: 'failed', state: 'failed', error: 'export-failed' });

    expect(calls.map((call) => call.query?.page)).toEqual(['1']);
    expect(await storedRow(job)).toMatchObject({ state: 'failed', error: 'export-failed', object_key: null, output_sha256: null });
    expect(await objectFiles(job)).toEqual([]);
  });

  it.each<[string, (body: PutBody, unavailable: Error) => Promise<never>]>([
    ['before reading the body', (_body, unavailable) => Promise.reject(unavailable)],
    [
      'after reading part of the body',
      async (body, unavailable) => {
        for await (const chunk of body as Readable) {
          void chunk;
          break;
        }
        throw unavailable;
      },
    ],
  ])('propagates a storage LegacyServiceUnavailableError raised %s and stops reading the source', async (_case, fail) => {
    const job = await queuedJob('csv');
    const unavailable = new LegacyServiceUnavailableError('Storage unavailable', 'auto', 'storage-unavailable');
    const storage: StoragePort = { ...local, put: (_bucket, _key, body) => fail(body, unavailable) };
    const pages = 20;
    const { client, calls } = financeClient(job.siteId, undefined, pages * PAGE_SIZE);

    await expect(run(job, storage, client)).rejects.toBe(unavailable);

    await sleep(50);
    expect(calls.length).toBeLessThan(pages);
    expect(await objectFiles(job)).toEqual([]);
  });
});
