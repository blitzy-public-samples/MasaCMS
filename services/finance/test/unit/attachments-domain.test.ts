// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance attachment domain against a throwaway `finance` schema and the local storage adapter, with sendFile headers recorded from the ACF oracle. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LegacyApiError, isCfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { UnitNotAuthoritativeError, closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { StorageObjectNotFoundError, createLocalStorageAdapter, type LocalStorageAdapter, type StoragePort } from '@opt2/platform/storage';
import { tenantDbFromPool, tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, testVerifier, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  fixtureFileHeaders,
  getAttachment,
  listAttachments,
  signedDownloadUrl,
  streamLegacy,
  uploadAttachment,
  type AttachmentUpload,
} from '../../src/domain/attachments.js';
import { createRecord, type FinanceActor, type FinanceDomainDeps } from '../../src/domain/records.js';
import { createFinanceRepository } from '../../src/repo/repository.js';
import { ATTACHMENT_BUCKET, UNITS, type FinanceAttachmentRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const HMAC_KEY = 'finance-attachments-domain-test-hmac-key';
const SITE_A = 'attachments-a';
const SITE_B = 'attachments-b';
const ACTOR_A: FinanceActor = { userId: '11111111-2222-3333-4444555566667777', siteId: SITE_A };
const ACTOR_B: FinanceActor = { userId: '22222222-2222-3333-4444555566667777', siteId: SITE_B };
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const FIRST_PAGE = { pageIndex: 1, itemsPerPage: 50 };
const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x0d, 0x7f, 0x80]);

// Content-Disposition values envelope.cfc sendFile answered on ACF 2023 for these file names.
const ORACLE_DISPOSITIONS: ReadonlyArray<readonly [fileName: string, disposition: string]> = [
  ['scan.pdf', 'attachment; filename="scan.pdf"'],
  ['a"b\\c.txt', 'attachment; filename="a\\"b\\\\c.txt"'],
  ['Résumé €.pdf', `attachment; filename="R_sum_ _.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E2%82%AC.pdf`],
  ['a😀.txt', `attachment; filename="a_.txt"; filename*=UTF-8''a%F0%9F%98%80.txt`],
  ["é!#$&+^_`|~-'*%().x", `attachment; filename="_!#$&+^_\`|~-'*%().x"; filename*=UTF-8''%C3%A9!#$&+^_\`|~-%27%2A%25%28%29.x`],
  ['é"\\.x', `attachment; filename="_\\"\\\\.x"; filename*=UTF-8''%C3%A9%22%5C.x`],
  ['a\u0080b', `attachment; filename="a_b"; filename*=UTF-8''a%C2%80b`],
];

// Content-Type bytes the oracle sent (hex) for these stored types; it writes the low byte of each UTF-16 unit.
const ORACLE_CONTENT_TYPES: ReadonlyArray<readonly [contentType: string, wireHex: string]> = [
  ['application/pdf; charset=utf-8', Buffer.from('application/pdf; charset=utf-8').toString('hex')],
  ['text/x-é', '746578742f782de9'],
  ['text/x-€', '746578742f782dac'],
  ['text/x\tA', '746578742f780941'],
  ['text/x-\u00ff', '746578742f782dff'],
];

describe('fixtureFileHeaders', () => {
  it.each(ORACLE_DISPOSITIONS)('answers %j with the oracle Content-Disposition', (fileName, disposition) => {
    expect(fixtureFileHeaders({ fileName, contentType: 'text/plain', size: 3 })).toEqual({
      'Content-Disposition': disposition,
      'Content-Length': '3',
      'Content-Type': 'text/plain',
    });
  });

  it.each(['a\tb', 'a\u0000b', 'a\nb', 'a\u007Fb'])('answers server_error for the control character in %j', (fileName) => {
    expect(() => fixtureFileHeaders({ fileName, contentType: 'text/plain', size: 1 })).toThrow(
      expect.objectContaining({ name: 'LegacyApiError', type: 'server_error' }),
    );
  });

  it.each([
    ['text/x-€', 'text/x-\u00ac'],
    ['text/x\u0001A\u007F', 'text/x A '],
    ['text/x-\u0100', 'text/x- '],
  ])('writes content type %j as the latin1 string %j', (contentType, wire) => {
    expect(fixtureFileHeaders({ fileName: 'x', contentType, size: 0 })['Content-Type']).toBe(wire);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('finance attachment domain against PostgreSQL', () => {
  const tenantA = tenantIdForSite(SITE_A);
  const tenantB = tenantIdForSite(SITE_B);
  let handle: ThrowawaySchema;
  let stagingDb: TenantDb;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let deps: FinanceDomainDeps;
  let app: FastifyInstance;
  let served: FinanceAttachmentRow | undefined;

  /** Binds `tenantId` to `Program_<programId>`, as a migration apply does. */
  async function bind(tenantId: string, siteId: string, programId: number): Promise<void> {
    await handle.app.withTenant(tenantId, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.program_binding (tenant_id, site_id, legacy_program_id, updated_at) VALUES ($1, $2, $3, $4)`, [
        tenantId,
        siteId,
        programId,
        NOW,
      ]),
    );
  }

  /** Moves every finance gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'attachments-domain-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'attachments-domain-test', state });
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantA): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  async function newRecord(actor = ACTOR_A, tenant = tenantA): Promise<string> {
    const input = { title: 'Receipts', amount: 10000n, period: '2026-06' };
    const { record } = await inTenant((tx) => createRecord(tx, deps, input, actor), tenant);
    return record.record_id;
  }

  function upload(recordId: string, fields: Partial<AttachmentUpload> = {}, uploadDeps = deps): Promise<FinanceAttachmentRow> {
    const file: AttachmentUpload = { recordId, fileName: 'scan.PDF', contentType: 'application/pdf', bytes: BYTES, ...fields };
    return inTenant((tx) => uploadAttachment(tx, uploadDeps, file, ACTOR_A));
  }

  /** Status, raw header bytes as hex by lower-cased name, and body of a GET over a real socket. */
  function fetchRaw(url: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
              headers[String(res.rawHeaders[i]).toLowerCase()] = Buffer.from(String(res.rawHeaders[i + 1]), 'latin1').toString('hex');
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        })
        .on('error', reject);
    });
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'finance',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
    await bind(tenantA, SITE_A, 1);
    await bind(tenantB, SITE_B, 2);
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-finance-attachments-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => NOW.getTime() });
    app = await createService({
      name: 'finance',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8119',
        OPT2_SERVICE_NAME: 'finance',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('finance'),
      logger: createLogger({ service: 'finance', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    app.get('/test/attachment', { config: { opt2: { public: true, transport: 'service' } } }, (_request, reply) =>
      streamLegacy(reply, deps, served as FinanceAttachmentRow),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await setGates('open');
    const clock = fixedClock(NOW);
    deps = { repository: createFinanceRepository({ db: handle.app, stagingDb, storage, clock }), storage, clock };
  });

  it('stores the bytes under <tenant>/<attachment id>.<ext> and writes their size and SHA-256 with one changelog row', async () => {
    const recordId = await newRecord();
    const { row, changelog } = await inTenant(async (tx) => {
      const written = await uploadAttachment(tx, deps, { recordId, fileName: 'Scan.PDF', contentType: 'application/pdf', bytes: BYTES }, ACTOR_A);
      const { rows } = await tx.query<{ op: string; table: string; actor_user_id: string }>(
        `SELECT op, "table", actor_user_id FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
      );
      return { row: written, changelog: rows };
    });
    expect(isCfUuid(row.attachment_id)).toBe(true);
    expect(row).toMatchObject({
      tenant_id: tenantA,
      record_id: recordId,
      file_name: 'Scan.PDF',
      content_type: 'application/pdf',
      size_bytes: BYTES.length,
      sha256: createHash('sha256').update(BYTES).digest('hex'),
      object_key: `${tenantA}/${row.attachment_id}.pdf`,
      created: NOW,
      createdbyid: ACTOR_A.userId,
      legacy_program_id: 1,
    });
    expect(changelog).toEqual([{ op: 'insert', table: 'attachment', actor_user_id: ACTOR_A.userId }]);
    expect(await storage.head(ATTACHMENT_BUCKET, row.object_key)).toEqual({ size: BYTES.length, sha256: row.sha256, contentType: 'application/pdf' });
    expect(await storage.get(ATTACHMENT_BUCKET, row.object_key)).toEqual(BYTES);
  });

  it('throws notFound for an upload to a missing record', async () => {
    await expect(upload(MISSING_ID)).rejects.toMatchObject({ name: 'FinanceDomainError', type: 'notFound' });
  });

  it('stores no bytes when the repository rejects the row', async () => {
    const recordId = await newRecord();
    const putKeys: string[] = [];
    const watched: StoragePort = {
      ...storage,
      put: (bucket, key, body, opts) => {
        putKeys.push(key);
        return storage.put(bucket, key, body, opts);
      },
    };
    await setGates('legacy');
    await expect(upload(recordId, {}, { ...deps, storage: watched })).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(putKeys).toEqual([]);
  });

  it('rolls the row back when storing the bytes fails', async () => {
    const recordId = await newRecord();
    const failing: StoragePort = { ...storage, put: () => Promise.reject(new Error('bucket unavailable')) };
    await expect(upload(recordId, {}, { ...deps, storage: failing })).rejects.toThrow('bucket unavailable');
    expect(await inTenant((tx) => listAttachments(tx, recordId, FIRST_PAGE))).toEqual({ rows: [], total: 0 });
  });

  it('lists a record attachments by created, then id, a page at a time', async () => {
    const recordId = await newRecord();
    const rows: FinanceAttachmentRow[] = [];
    for (const fileName of ['b.txt', 'a.txt', 'c.txt']) rows.push(await upload(recordId, { fileName }));
    const ids = rows.map((row) => row.attachment_id).sort();
    const all = await inTenant((tx) => listAttachments(tx, recordId, FIRST_PAGE));
    expect(all.total).toBe(3);
    expect(all.rows.map((row) => row.attachment_id)).toEqual(ids);
    const second = await inTenant((tx) => listAttachments(tx, recordId, { pageIndex: 2, itemsPerPage: 2 }));
    expect(second).toEqual({ rows: [all.rows[2]], total: 3 });
  });

  it('reads an attachment of its record', async () => {
    const recordId = await newRecord();
    const row = await upload(recordId);
    expect(await inTenant((tx) => getAttachment(tx, recordId, row.attachment_id))).toEqual(row);
  });

  it('throws notFound for a missing record, another record or a missing attachment', async () => {
    const recordId = await newRecord();
    const other = await newRecord();
    const row = await upload(recordId);
    await expect(inTenant((tx) => listAttachments(tx, MISSING_ID, FIRST_PAGE))).rejects.toMatchObject({ type: 'notFound' });
    for (const [record, attachment] of [
      [MISSING_ID, row.attachment_id],
      [other, row.attachment_id],
      [recordId, MISSING_ID],
    ] as const) {
      await expect(inTenant((tx) => getAttachment(tx, record, attachment))).rejects.toMatchObject({ name: 'FinanceDomainError', type: 'notFound' });
    }
  });

  it('never shows tenant A attachments to tenant B', async () => {
    const recordId = await newRecord();
    const row = await upload(recordId);
    await expect(inTenant((tx) => listAttachments(tx, recordId, FIRST_PAGE), tenantB)).rejects.toMatchObject({ type: 'notFound' });
    await expect(inTenant((tx) => getAttachment(tx, recordId, row.attachment_id), tenantB)).rejects.toMatchObject({ type: 'notFound' });
    const recordB = await newRecord(ACTOR_B, tenantB);
    expect(await inTenant((tx) => listAttachments(tx, recordB, FIRST_PAGE), tenantB)).toEqual({ rows: [], total: 0 });
  });

  it('streams the stored bytes with the oracle sendFile header bytes and no ETag', async () => {
    const recordId = await newRecord();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    for (const [contentType, wireHex] of ORACLE_CONTENT_TYPES) {
      served = await upload(recordId, { fileName: 'Résumé €.pdf', contentType });
      const res = await fetchRaw(`${address}/test/attachment`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(wireHex);
      expect(Buffer.from(res.headers['content-disposition'] ?? '', 'hex').toString('latin1')).toBe(ORACLE_DISPOSITIONS[2]?.[1]);
      expect(res.headers['content-length']).toBe(Buffer.from(String(BYTES.length)).toString('hex'));
      expect(Buffer.from(res.headers.generator ?? '', 'hex').toString('latin1')).toBe('Masa CMS 7.6.1');
      expect(res.headers.etag).toBeUndefined();
      expect(res.body).toEqual(BYTES);
    }
  });

  it('throws StorageObjectNotFoundError for a missing object, and server_error for a control character before reading storage', async () => {
    const recordId = await newRecord();
    const row = await upload(recordId);
    await storage.delete(ATTACHMENT_BUCKET, row.object_key);
    const reply = { code: () => reply, headers: () => reply, send: () => reply } as never;
    await expect(streamLegacy(reply, deps, row)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    const unread: StoragePort = { ...storage, open: () => Promise.reject(new Error('storage read')) };
    await expect(streamLegacy(reply, { ...deps, storage: unread }, { ...row, file_name: 'a\tb' })).rejects.toBeInstanceOf(LegacyApiError);
  });

  it('signs a download URL that names the file, verifies and expires after 900 s', async () => {
    const recordId = await newRecord();
    const row = await upload(recordId, { fileName: 'report.pdf' });
    const signed = await signedDownloadUrl(deps, row);
    expect(signed.expiresAt).toBe(new Date(NOW.getTime() + 900_000).toISOString());
    expect(signed.url.startsWith(`/opt2/files/${ATTACHMENT_BUCKET}/${tenantA}/`)).toBe(true);
    expect(storage.verifySignedUrl(signed.url, NOW.getTime() + 900_000)).toEqual({
      ok: true,
      bucket: ATTACHMENT_BUCKET,
      key: row.object_key,
      expires: Math.floor(NOW.getTime() / 1000) + 900,
      disposition: 'attachment; filename="report.pdf"',
    });
    expect(storage.verifySignedUrl(signed.url, NOW.getTime() + 901_000)).toEqual({ ok: false, reason: 'expired' });
  });
});
