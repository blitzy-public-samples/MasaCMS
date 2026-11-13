/** Signed `content-files` downloads: `signContentDownload`, `contentDisposition`, and both file routes over local and cloud storage ports. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  SIGNED_URL_TTL_S,
  createLocalStorageAdapter,
  type LocalStorageAdapter,
  type SignedUrlOptions,
  type StoragePort,
} from '@opt2/platform/storage';
import { TENANT_A, poolTenantExpectation, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { contentDisposition, registerFileRoutes, signContentDownload } from '../../src/routes/files.js';
import { SERVICE, createRecordingDb, testEnv, userHeaders, type RecordingDb } from '../helpers/app.js';

// Mid-second, so the reported expiry's truncation to the signed second is observable.
const NOW = new Date('2026-06-30T12:00:00.750Z');
const clock = fixedClock(NOW);
const FILE_ID = 'B1C2D3E4-0001-4A5B-8C7D9E0F1A2B3C4D';
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const FILE_POOL = poolTenantExpectation(TENANT_A, 'file');
const BYTES = Buffer.from('content file bytes');
const CLOUD_URL = 'https://storage.googleapis.com/content-files/signed';

let stateDir: string;
let local: LocalStorageAdapter;

/** A storage port of kind `cloud` that records each `signedUrl` call and holds every object. */
function cloudPort(signed: Array<[string, string, SignedUrlOptions | undefined]>): StoragePort {
  const head = { size: BYTES.length, sha256: '0'.repeat(64), contentType: 'application/pdf' };
  return {
    kind: 'cloud',
    put: async () => ({ size: BYTES.length, sha256: head.sha256 }),
    get: async () => BYTES,
    stream: async () => Readable.from([BYTES]),
    open: async () => ({ head, body: Readable.from([BYTES]) }),
    delete: async () => undefined,
    head: async () => head,
    signedUrl: async (bucket, key, opts) => {
      signed.push([bucket, key, opts]);
      return CLOUD_URL;
    },
  };
}

/** strategies-content with only the file routes, over `storage` and a recording pool answering the file read with `row`. */
async function buildApp(storage: StoragePort, row?: Record<string, unknown>): Promise<{ app: FastifyInstance; db: RecordingDb }> {
  const db = createRecordingDb();
  if (row !== undefined) db.respond(/ FROM "content"\."file" WHERE /, [row]);
  const app = await createService({
    name: SERVICE,
    version: '1.0.0',
    env: loadEnv(undefined, testEnv(stateDir)),
    clock,
    verifierOverride: testVerifier(SERVICE),
    pool: db,
    logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerFileRoutes(app, { domain: { db, repository: createContentRepository({ clock, schema: db.schema }) }, storage, clock });
  await app.ready();
  return { app, db };
}

/** A tenant-a site admin's request headers, as the gateway relays them. */
const admin = (): Promise<Record<string, string>> => userHeaders({ sub: USER_ID, site: TENANT_A.siteId, roles: [Roles.siteAdmin] });

const fileRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  fileid: FILE_ID,
  siteid: TENANT_A.siteId,
  filename: 'report.pdf',
  contenttype: 'application',
  contentsubtype: 'pdf',
  fileext: 'PDF',
  ...overrides,
});

const downloadUrl = (query = ''): string => `/v1/sites/${TENANT_A.siteId}/files/${FILE_ID}/download-url${query}`;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-files-routes-'));
  await writeTestSecrets(stateDir);
  local = await createLocalStorageAdapter({ stateDir, hmacKey: 'files-routes-test-key', now: () => NOW.getTime() });
});

afterAll(async () => {
  if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
});

describe('contentDisposition', () => {
  it.each<[Parameters<typeof contentDisposition>, string]>([
    [['inline', 'a.pdf', 'application/pdf'], 'inline;filename="a.pdf"'],
    [['inline', 'clip.mp4', 'video/mp4'], 'attachment;filename="clip.mp4"'],
    [['attachment', 'a.pdf'], 'attachment;filename="a.pdf"'],
  ])('builds %j as %s', (args, expected) => {
    expect(contentDisposition(...args)).toBe(expected);
  });
});

describe('signContentDownload', () => {
  const key = `${FILE_POOL}/${FILE_ID}.pdf`;

  it.each<[string, { fileName?: string; disposition?: string }, string | undefined]>([
    ['no disposition', {}, undefined],
    ['a file name, as an attachment', { fileName: 'a.pdf' }, 'attachment;filename="a.pdf"'],
    ['an explicit disposition over the file name', { fileName: 'a.pdf', disposition: 'inline;filename="b.pdf"' }, 'inline;filename="b.pdf"'],
  ])('signs %s for 900 s, reporting the signed second as expiresAt', async (_label, args, disposition) => {
    const signed = await signContentDownload({ storage: local, clock }, { objectKey: key, ...args });
    const verified = local.verifySignedUrl(signed.url);
    expect(verified).toEqual({
      ok: true,
      bucket: CONTENT_FILES_BUCKET,
      key,
      expires: Math.floor(NOW.getTime() / 1000) + SIGNED_URL_TTL_S,
      ...(disposition === undefined ? {} : { disposition }),
    });
    expect(signed.expiresAt).toBe('2026-06-30T12:15:00.000Z');
  });
});

describe('file routes over local storage', () => {
  let app: FastifyInstance;
  let db: RecordingDb;

  beforeAll(async () => {
    ({ app, db } = await buildApp(local, fileRow({ filename: 'résumé.pdf' })));
    await local.put(CONTENT_FILES_BUCKET, `${FILE_POOL}/${FILE_ID}.pdf`, BYTES, { contentType: 'application/pdf' });
    await local.put(CONTENT_FILES_BUCKET, `${FILE_POOL}/${FILE_ID}_small.pdf`, BYTES, { contentType: 'application/pdf' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each<[string, string, string, string]>([
    ['the original by default', '', `${FILE_ID}.pdf`, 'attachment;filename="résumé.pdf"'],
    ['a stored rendition inline', '?variant=_small&method=inline', `${FILE_ID}_small.pdf`, 'inline;filename="résumé.pdf"'],
  ])('issues and serves %s from the token tenant’s file pool', async (_label, query, objectName, disposition) => {
    const issued = await app.inject({ method: 'GET', url: downloadUrl(query), headers: await admin() });
    expect(issued.statusCode).toBe(200);
    const { url } = issued.json() as { url: string };
    expect(url.split('?')[0]).toBe(`/opt2/files/content-files/${FILE_POOL}/${objectName}`);
    expect(new Set(db.statements.flatMap((s) => (s.tenantId === null ? [] : [s.tenantId])))).toEqual(new Set([FILE_POOL]));

    const served = await app.inject({ method: 'GET', url });
    expect({
      status: served.statusCode,
      length: served.headers['content-length'],
      disposition: Buffer.from(String(served.headers['content-disposition']), 'latin1').toString('utf8'),
      bytes: served.rawPayload,
    }).toEqual({ status: 200, length: String(BYTES.length), disposition, bytes: BYTES });
  });

  it('answers a signed URL of another bucket with the legacy 404', async () => {
    const url = await local.signedUrl('finance-attachments', `${FILE_POOL}/${FILE_ID}.pdf`);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
  });

  it('answers a storage failure other than a missing object with the legacy 500', async () => {
    const failing: LocalStorageAdapter = { ...local, open: () => Promise.reject(new Error('disk unreadable')) };
    const built = await buildApp(failing);
    try {
      const res = await built.app.inject({ method: 'GET', url: await local.signedUrl(CONTENT_FILES_BUCKET, `${FILE_POOL}/${FILE_ID}.pdf`) });
      expect({ status: res.statusCode, code: (res.json() as { error: { code: string } }).error.code }).toEqual({ status: 500, code: 'server_error' });
    } finally {
      await built.app.close();
    }
  });
});

describe('file routes over cloud storage', () => {
  const signed: Array<[string, string, SignedUrlOptions | undefined]> = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildApp(cloudPort(signed), fileRow({ contenttype: 'video', contentsubtype: 'mp4', fileext: 'mp4' })));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('issues the cloud adapter’s URL, a video forced to download', async () => {
    const res = await app.inject({ method: 'GET', url: downloadUrl('?method=inline'), headers: await admin() });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: { url: CLOUD_URL, expiresAt: '2026-06-30T12:15:00.000Z' },
    });
    expect(signed).toEqual([
      [CONTENT_FILES_BUCKET, `${FILE_POOL}/${FILE_ID}.mp4`, { expiresS: SIGNED_URL_TTL_S, disposition: 'attachment;filename="report.pdf"' }],
    ]);
  });

  it('answers the local object route with the legacy 404', async () => {
    const res = await app.inject({ method: 'GET', url: await local.signedUrl(CONTENT_FILES_BUCKET, `${FILE_POOL}/${FILE_ID}.pdf`) });
    expect(res.statusCode).toBe(404);
  });
});
