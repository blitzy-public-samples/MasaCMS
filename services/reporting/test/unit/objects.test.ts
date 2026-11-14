// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job object manifest against a throwaway `reporting` schema and local storage, alone and through the migration export endpoint. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createLogger } from '@opt2/platform/logging';
import {
  MIGRATION_PATH_PREFIX,
  registerMigrationHandlers,
  registerWritePositionHeader,
  type ExportResponse,
  type MigrationHandlerOptions,
  type ObjectManifestEntry,
  type ObjectManifestPage,
} from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type StoragePort } from '@opt2/platform/storage';
import type { TenantTx } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  createThrowawaySchema,
  pgAvailable,
  testVerifier,
  type RoleSubject,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { exportDefinitionMapping } from '../../src/migration/mappings/export-definition.js';
import { sessionTrackingMapping } from '../../src/migration/mappings/tsessiontracking.js';
import { createExportObjects } from '../../src/migration/objects.js';
import { createReportingRepository, type ReportingRepository } from '../../src/repo/repository.js';
import {
  EXPORT_BUCKET,
  EXPORT_DEFINITION,
  EXPORT_JOB,
  OWNER,
  TSESSIONTRACKING,
  UNITS,
  exportObjectKey,
  type ExportFormat,
  type ExportState,
} from '../../src/repo/tables.js';

type ManifestScope = Parameters<NonNullable<MigrationHandlerOptions['exportObjects']>>[1];

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const EXPORT_PATH = `${MIGRATION_PATH_PREFIX}/export`;

/** A CF-format id whose first group is `<prefix><n>`; ids sort by prefix, then `n`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

/**
 * A seeded job of `format` (csv by default): `output` makes it `done` with an object key; without one it stays in `state`
 * (queued by default) with none; `absent` leaves its object unstored; `rowSha` replaces its stored SHA-256 column.
 */
interface SeedJob {
  id: string;
  format?: ExportFormat;
  state?: Exclude<ExportState, 'done'>;
  output?: Buffer;
  contentType?: string | null;
  absent?: boolean;
  rowSha?: string;
}

const A_JOBS: SeedJob[] = [
  { id: cfId('A', 1), output: Buffer.from('id,name\r\n1,"Ada, \u00e9"\r\n'), contentType: 'text/csv' },
  { id: cfId('A', 2), format: 'pdf', output: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]), contentType: null },
  { id: cfId('A', 3), output: Buffer.from('never stored'), contentType: 'text/csv', absent: true },
  { id: cfId('A', 4), state: 'queued' },
  {
    id: cfId('A', 5),
    format: 'xlsx',
    output: Buffer.from('PK\u0003\u0004 workbook'),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  { id: cfId('A', 6), output: Buffer.from('bytes as stored'), contentType: 'text/csv', rowSha: 'f'.repeat(64) },
  { id: cfId('A', 7), format: 'pdf', state: 'running' },
  { id: cfId('A', 8), format: 'xlsx', state: 'failed' },
];
const B_JOBS: SeedJob[] = [{ id: cfId('B', 1), format: 'pdf', output: Buffer.from('tenant b'), contentType: 'application/pdf' }];

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const keyOf = (tenantId: string, job: SeedJob): string => exportObjectKey(tenantId, job.id, job.format ?? 'csv');

/** The manifest entry of a seeded job's stored object. */
function entryOf(tenantId: string, job: SeedJob): ObjectManifestEntry {
  const output = job.output as Buffer;
  return {
    key: keyOf(tenantId, job),
    size: output.length,
    sha256: sha256(output),
    ...(job.contentType === null || job.contentType === undefined ? {} : { contentType: job.contentType }),
    legacyPath: `synthetic.export_job/${job.id}`,
  };
}

const A_MANIFEST = A_JOBS.filter((job) => job.output !== undefined && job.absent !== true).map((job) => entryOf(TENANT_A.tenantId, job));
const B_MANIFEST = B_JOBS.map((job) => entryOf(TENANT_B.tenantId, job));

let handle: ThrowawaySchema;
let stateDir: string;
let storage: StoragePort;
let repository: ReportingRepository;

/** Stores each job's object, unless absent, and inserts its row in the transaction tenant. */
async function seed(tx: TenantTx, siteId: string, jobs: readonly SeedJob[]): Promise<void> {
  for (const job of jobs) {
    const key = job.output === undefined ? null : keyOf(tx.tenantId, job);
    if (key !== null && job.absent !== true) {
      await storage.put(EXPORT_BUCKET, key, job.output as Buffer, { contentType: job.contentType ?? 'application/octet-stream' });
    }
    await tx.query(
      `INSERT INTO ${handle.schema}.export_job
         (tenant_id, job_id, siteid, definition_id, format, state, requested_by_id, created, content_type, object_key, output_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-06-30 10:00:00.000', $8, $9, $10)`,
      [
        tx.tenantId,
        job.id,
        siteId,
        cfId('D', 1),
        job.format ?? 'csv',
        key === null ? (job.state ?? 'queued') : 'done',
        cfId('E', 1),
        job.contentType ?? null,
        key,
        job.output === undefined ? null : (job.rowSha ?? sha256(job.output)),
      ],
    );
  }
}

/** `port` recording the key of every `head` call in `heads`. */
function countingStorage(port: StoragePort, heads: string[]): StoragePort {
  return {
    ...port,
    head: (bucket, key) => {
      heads.push(key);
      return port.head(bucket, key);
    },
  };
}

/** The callback's answer for `scope` in the scope tenant's transaction, read over `port`. */
function manifestFor(scope: ManifestScope, port: StoragePort = storage): Promise<ObjectManifestEntry[] | ObjectManifestPage> {
  return handle.app.withTenant(scope.tenantId, (tx) => createExportObjects({ storage: port, repository })(tx, scope));
}

/** The ROLE_SET subject called `name`. */
function roleSubject(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error(`no role subject ${name}`);
  return subject;
}

/** `result` as a manifest page; fails when it is a whole-manifest array. */
function pageOf(result: ObjectManifestEntry[] | ObjectManifestPage): ObjectManifestPage {
  expect(Array.isArray(result)).toBe(false);
  return result as ObjectManifestPage;
}

// pgAvailable rejects when PG_HOST is unset; no configured PostgreSQL skips the suite instead.
const pgReady = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!pgReady)('reporting export-job object manifest', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-objects-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'reporting-objects-test-hmac-key' });
    repository = createReportingRepository({ db: handle.app, storage, clock: fixedClock(Date.parse('2026-06-30T12:00:00Z')) });
    await handle.app.withTenant(TENANT_A.tenantId, (tx) => seed(tx, TENANT_A.siteId, A_JOBS));
    await handle.app.withTenant(TENANT_B.tenantId, (tx) => seed(tx, TENANT_B.siteId, B_JOBS));

    app = await createService({
      name: OWNER,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8116',
        OPT2_SERVICE_NAME: OWNER,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(OWNER),
      logger: createLogger({ service: OWNER, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository,
      mappings: [exportDefinitionMapping, sessionTrackingMapping],
      units: UNITS,
      db: handle.app,
      exportObjects: createExportObjects({ storage, repository }),
    });
    await app.ready();
    headers = await authHeadersFor(roleSubject('service:migration'), { audience: OWNER });
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  /** GETs one export page and checks it against `migrationExport` in the reporting contract. */
  async function exportPage(query: Record<string, string>, status = 200): Promise<ExportResponse> {
    const res = await app.inject({ method: 'GET', url: EXPORT_PATH, headers, query });
    expect(res.statusCode, res.body).toBe(status);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: EXPORT_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.payload });
    return res.json<ExportResponse>();
  }

  it('lists each stored output with its key, stored size and SHA-256, row content type and fixture row path, skipping absent objects', async () => {
    const page = pageOf(await manifestFor({ unit: EXPORT_JOB.unit, tenantId: TENANT_A.tenantId }));
    expect(page).toEqual({ objects: A_MANIFEST, next: null });
    // The stored bytes, not the row's output_sha256, are the evidence reconciliation compares.
    const replaced = A_JOBS[5] as SeedJob;
    expect(page.objects.find((entry) => entry.key === keyOf(TENANT_A.tenantId, replaced))?.sha256).not.toBe(replaced.rowSha);
    expect(page.objects.map((entry) => entry.key)).not.toContain(keyOf(TENANT_A.tenantId, A_JOBS[2] as SeedJob));
  });

  it('lists no queued, running or failed job, none of which stores an output', async () => {
    const unfinished = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query<{ job_id: string; state: string }>(
        `SELECT job_id, state FROM ${handle.schema}.export_job WHERE object_key IS NULL ORDER BY job_id COLLATE "C"`,
      ),
    );
    expect(unfinished.rows.map((row) => row.state)).toEqual(['queued', 'running', 'failed']);
    const page = pageOf(await manifestFor({ unit: EXPORT_JOB.unit, tenantId: TENANT_A.tenantId }));
    const listed = page.objects.map((entry) => entry.legacyPath);
    for (const row of unfinished.rows) expect(listed).not.toContain(`synthetic.export_job/${row.job_id}`);
  });

  it.each([
    { limit: 2, pages: [[0, 1], [2], [3]], nexts: [cfId('A', 2), cfId('A', 5), null], heads: [[1, 2], [3, 5], [6]] },
    { limit: 3, pages: [[0, 1], [2, 3]], nexts: [cfId('A', 3), null], heads: [[1, 2, 3], [5, 6]] },
  ])('pages the manifest $limit listed jobs at a time, one head per listed job, past absent objects', async ({ limit, pages, nexts, heads }) => {
    const got: ObjectManifestPage[] = [];
    const seen: string[][] = [];
    let after: string | null = null;
    do {
      const calls: string[] = [];
      const scope: ManifestScope = { unit: EXPORT_JOB.unit, tenantId: TENANT_A.tenantId, limit, ...(after === null ? {} : { after }) };
      got.push(pageOf(await manifestFor(scope, countingStorage(storage, calls))));
      seen.push(calls);
      after = got.at(-1)?.next ?? null;
    } while (after !== null && got.length < 5);
    expect(got.map((page) => page.objects)).toEqual(pages.map((indexes) => indexes.map((index) => A_MANIFEST[index])));
    expect(got.map((page) => page.next)).toEqual(nexts);
    expect(got.flatMap((page) => page.objects)).toEqual(A_MANIFEST);
    expect(seen).toEqual(heads.map((ns) => ns.map((n) => keyOf(TENANT_A.tenantId, A_JOBS[n - 1] as SeedJob))));
  });

  it.each([EXPORT_DEFINITION.unit, TSESSIONTRACKING.unit])('returns no objects for %s without reading storage', async (unit) => {
    const calls: string[] = [];
    expect(await manifestFor({ unit, tenantId: TENANT_A.tenantId, limit: 2 }, countingStorage(storage, calls))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('lists only the transaction tenant outputs', async () => {
    expect(pageOf(await manifestFor({ unit: EXPORT_JOB.unit, tenantId: TENANT_B.tenantId }))).toEqual({ objects: B_MANIFEST, next: null });
    const aKeys = pageOf(await manifestFor({ unit: EXPORT_JOB.unit, tenantId: TENANT_A.tenantId })).objects.map((entry) => entry.key);
    expect(aKeys).not.toContain(B_MANIFEST[0]?.key);
    expect(aKeys.every((key) => key.startsWith(`${TENANT_A.tenantId}/`))).toBe(true);
  });

  it('delivers the manifest page by page through the migration export endpoint until next is null', async () => {
    const pages: ExportResponse[] = [];
    let after: string | null = null;
    do {
      pages.push(await exportPage({ unit: EXPORT_JOB.unit, tenantId: TENANT_A.tenantId, limit: '2', ...(after === null ? {} : { after }) }));
      after = pages.at(-1)?.next ?? null;
    } while (after !== null && pages.length < 5);
    expect(pages.map((page) => page.tables)).toEqual([[], [], []]);
    expect(pages.map((page) => page.objects)).toEqual([A_MANIFEST.slice(0, 2), A_MANIFEST.slice(2, 3), A_MANIFEST.slice(3)]);
    expect(pages.map((page) => (page.next === null ? null : (JSON.parse(Buffer.from(page.next, 'base64url').toString('utf8')) as unknown)))).toEqual([
      { objects: cfId('A', 2) },
      { objects: cfId('A', 5) },
      null,
    ]);
  });

  it.each([EXPORT_DEFINITION.unit, TSESSIONTRACKING.unit])('exports %s with an empty manifest on its only page', async (unit) => {
    const page = await exportPage({ unit, siteId: TENANT_A.siteId });
    expect(page).toMatchObject({ unit, tenantId: TENANT_A.tenantId, next: null, objects: [] });
    expect(page.tables.map((table) => table.rows)).toEqual([[]]);
  });

  it('rejects a manifest cursor for a unit without a paged manifest as invalidParameters', async () => {
    const after = Buffer.from(JSON.stringify({ objects: cfId('A', 2) }), 'utf8').toString('base64url');
    await exportPage({ unit: EXPORT_DEFINITION.unit, tenantId: TENANT_A.tenantId, after }, 400);
  });

  it.each([
    { who: 'anonymous', status: 401 },
    { who: 'service:gateway', status: 403 },
    { who: 's2', status: 403 },
  ])('refuses the manifest to $who, which holds no platform.migration, with $status', async ({ who, status }) => {
    const res = await app.inject({
      method: 'GET',
      url: EXPORT_PATH,
      headers: await authHeadersFor(roleSubject(who), { audience: OWNER }),
      query: { unit: EXPORT_JOB.unit, tenantId: TENANT_A.tenantId },
    });
    expect(res.statusCode, res.body).toBe(status);
    for (const entry of A_MANIFEST) expect(res.body).not.toContain(entry.key);
  });
});
