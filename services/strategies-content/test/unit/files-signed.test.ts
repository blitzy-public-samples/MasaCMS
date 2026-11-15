/** Signed `content-files` downloads: 900 s issuance through the service, and local HMAC URLs served or refused exactly as `verifySignedUrl` decides. */
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  LOCAL_SIGNED_URL_PREFIX,
  SIGNED_URL_TTL_S,
  contentFileKey,
  createLocalStorageAdapter,
  signLocalUrl,
  verifySignedUrl,
  type BucketName,
  type LocalStorageAdapter,
  type LocalUrlVerification,
} from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, createCapturingPublisher, poolTenantExpectation, testVerifier } from '@opt2/platform/testing';
import { buildApp, contentEnvSchema } from '../../src/app.js';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import { signContentDownload } from '../../src/routes/files.js';
import {
  SERVICE,
  TEST_CLOCK,
  buildTestApp,
  createFakeTaskPort,
  createMemoryStorage,
  createRecordingDb,
  createTestStateDir,
  testEnv,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';
import { FILE_BYTES, IDS, seedMemoryStorage, umbrellaSeed, type SeedObject } from '../helpers/seed.js';
import { contentHeaders, type ContentSubject } from '../helpers/tokens.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const NOW_MS = TEST_CLOCK.now().getTime();
const NOW_S = Math.floor(NOW_MS / 1000);
// tenant-a reads its files in the umbrella pool, where the seed stores them.
const FILE_POOL = poolTenantExpectation(TENANT_A, 'file');
const PDF_KEY = contentFileKey({ tenantId: FILE_POOL, fileId: IDS.files.pdf, ext: 'pdf' });
const IMAGE_KEY = contentFileKey({ tenantId: FILE_POOL, fileId: IDS.files.image, ext: 'jpg' });
const MISSING_KEY = contentFileKey({ tenantId: FILE_POOL, fileId: 'A3000000-0000-0000-0000000000000099', ext: 'pdf' });
/** HMAC key of the disk adapter under test; not a secret. */
const HMAC_KEY = Buffer.from('opt2-strategies-content-files-signed-test-key', 'utf8');

/** The seeded `tfiles` rows of the umbrella file pool. */
const SEEDED_FILES = umbrellaSeed()
  .rows.filter(({ table }) => table.table === 'file')
  .map(({ row }) => row);

/** Answers each file read with the seeded row of the requested id in the transaction's tenant. */
function answerFileReads(db: RecordingDb): void {
  db.respond(/ FROM "content"\."file" WHERE /, (params, _sql, { tenantId }) =>
    SEEDED_FILES.filter((row) => row.fileid === params[0] && row.tenant_id === tenantId?.toLowerCase()),
  );
}

/** A local signed URL of `key` in `bucket`, expiring at `expires` (epoch seconds). */
function signed(key: string, expires = NOW_S + SIGNED_URL_TTL_S, bucket: BucketName = CONTENT_FILES_BUCKET): string {
  return signLocalUrl({ bucket, key, expires }, HMAC_KEY);
}

/** The seeded payload stored under `key`. */
function seeded(key: string): SeedObject {
  const object = FILE_BYTES[key];
  if (object === undefined) throw new TypeError(`No seeded object under ${key}`);
  return object;
}

describe('signContentDownload', () => {
  it('signs the object in content-files with expiresS 900 and reports expiresAt 900 s after now', async () => {
    const storage = createMemoryStorage();
    const signedUrl = vi.spyOn(storage, 'signedUrl');
    const download = await signContentDownload({ storage, clock: TEST_CLOCK }, { objectKey: PDF_KEY });
    expect(signedUrl).toHaveBeenCalledExactlyOnceWith(CONTENT_FILES_BUCKET, PDF_KEY, { expiresS: 900 });
    expect({ url: download.url, ttlMs: Date.parse(download.expiresAt) - NOW_MS }).toEqual({ url: storage.signedUrls[0], ttlMs: 900_000 });
  });
});

describe('getFileDownloadUrl', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await buildTestApp({ storage: createMemoryStorage() });
    seedMemoryStorage(t.storage);
    answerFileReads(t.db);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    t.storage.clear();
  });

  /** Requests the seeded PDF's download URL on `pathSite` as `subject`, its token minted for `tokenSite`; the response must match the contract. */
  async function issue(subject: ContentSubject, sites: { pathSite?: string; tokenSite?: string } = {}): Promise<{ status: number; body: unknown }> {
    const path = `/v1/sites/${sites.pathSite ?? TENANT_A.siteId}/files/${IDS.files.pdf}/download-url`;
    const headers = await contentHeaders(subject, sites.tokenSite === undefined ? {} : { site: sites.tokenSite });
    const res = await t.app.inject({ method: 'GET', url: path, headers });
    const body = assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path, status: res.statusCode, contentType: res.headers['content-type'], body: res.payload });
    return { status: res.statusCode, body };
  }

  it.each<ContentSubject>(['s2', 'site-admin', 'editor'])('issues %s a contract SignedUrl of the pooled object, signed once for 900 s', async (subject) => {
    const { status, body } = await issue(subject);
    expect({ status, body }).toEqual({
      status: 200,
      body: { url: t.storage.signedUrls[0], expiresAt: new Date(NOW_MS + SIGNED_URL_TTL_S * 1000).toISOString() },
    });
    expect(t.storage.calls.filter(({ op }) => op === 'signedUrl')).toEqual([{ op: 'signedUrl', bucket: CONTENT_FILES_BUCKET, key: PDF_KEY }]);
    const { url } = body as { url: string };
    expect(url.startsWith(`${LOCAL_SIGNED_URL_PREFIX}${CONTENT_FILES_BUCKET}/${PDF_KEY}?`)).toBe(true);
    expect(t.storage.verifySignedUrl(url)).toEqual({
      ok: true,
      bucket: CONTENT_FILES_BUCKET,
      key: PDF_KEY,
      expires: NOW_S + SIGNED_URL_TTL_S,
      disposition: 'attachment;filename="guide.pdf"',
    });
  });

  it.each<[string, number, ContentSubject, { pathSite?: string; tokenSite?: string }]>([
    ['an anonymous caller', 401, 'anonymous', {}],
    ['a member', 403, 'member', {}],
    ['a system user without Site Manager access', 403, 'system-user', {}],
    ['an approver without Site Manager access', 403, 'approver', {}],
    ['a tenant-b administrator naming tenant-a', 403, 'other-tenant', {}],
    ['a tenant-a site admin naming tenant-b', 403, 'site-admin', { pathSite: TENANT_B.siteId }],
    ['a site admin whose token names tenant-b', 403, 'site-admin', { tokenSite: TENANT_B.siteId }],
  ])('refuses %s with %i and signs nothing', async (_label, expected, subject, sites) => {
    const { status } = await issue(subject, sites);
    expect({ status, signed: t.storage.signedUrls }).toEqual({ status: expected, signed: [] });
  });
});

describe('getLocalContentFile over the local disk adapter', () => {
  let stateDir: string;
  let local: LocalStorageAdapter;
  let app: FastifyInstance;

  beforeAll(async () => {
    stateDir = await createTestStateDir();
    local = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => TEST_CLOCK.now().getTime() });
    for (const [key, { bytes, contentType }] of Object.entries(FILE_BYTES)) {
      await local.put(CONTENT_FILES_BUCKET, key, bytes, { contentType });
    }
    app = await buildApp({
      env: loadEnv(contentEnvSchema, testEnv(stateDir)),
      clock: TEST_CLOCK,
      verifierOverride: testVerifier(SERVICE),
      db: createRecordingDb(),
      taskPort: createFakeTaskPort(),
      publisher: createCapturingPublisher(),
      storage: local,
    });
    await app.ready();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(Object.keys(FILE_BYTES))('serves %s from a signLocalUrl URL with the stored bytes and content type', async (key) => {
    const res = await app.inject({ method: 'GET', url: signed(key) });
    const object = seeded(key);
    expect({ status: res.statusCode, type: res.headers['content-type'], bytes: res.rawPayload }).toEqual({
      status: 200,
      type: object.contentType,
      bytes: object.bytes,
    });
  });

  const valid = signed(PDF_KEY);
  const ok = (key: string, expires: number, bucket: BucketName = CONTENT_FILES_BUCKET): LocalUrlVerification => ({ ok: true, bucket, key, expires });
  const refused = (reason: Extract<LocalUrlVerification, { ok: false }>['reason']): LocalUrlVerification => ({ ok: false, reason });

  // Only content-files is routed here: the gateway sends every other bucket's URLs to that bucket's owner.
  it.each<[string, number, string, LocalUrlVerification]>([
    ['a URL expiring this second', 200, signed(PDF_KEY, NOW_S), ok(PDF_KEY, NOW_S)],
    ['an expired URL', 403, signed(PDF_KEY, NOW_S - 1), refused('expired')],
    ['a tampered signature', 403, valid.replace(/(sig=[0-9a-f]{63})([0-9a-f])/, (_m, head: string, last: string) => `${head}${last === '0' ? '1' : '0'}`), refused('bad-signature')],
    ['a later expiry under the original signature', 403, valid.replace(`expires=${NOW_S + SIGNED_URL_TTL_S}`, `expires=${NOW_S + 2 * SIGNED_URL_TTL_S}`), refused('bad-signature')],
    ['another stored key under the original signature', 403, valid.replace(PDF_KEY, IMAGE_KEY), refused('bad-signature')],
    ['a URL without expires', 403, valid.replace(/expires=\d+&/, ''), refused('malformed')],
    ['a URL without sig', 403, valid.replace(/&sig=[0-9a-f]+/, ''), refused('malformed')],
    ['a key escaping its bucket', 403, valid.replace(PDF_KEY, `${FILE_POOL}/..%2F..%2Fsecrets%2Fstorage-hmac-key`), refused('malformed')],
    ['a bucket name outside the four', 404, valid.replace(`/${CONTENT_FILES_BUCKET}/`, '/content-archive/'), refused('unknown-bucket')],
    ['a validly signed URL of another bucket', 404, signed(PDF_KEY, NOW_S + SIGNED_URL_TTL_S, 'finance-attachments'), ok(PDF_KEY, NOW_S + SIGNED_URL_TTL_S, 'finance-attachments')],
    ['a validly signed key outside the stored set', 404, signed(MISSING_KEY), ok(MISSING_KEY, NOW_S + SIGNED_URL_TTL_S)],
  ])('answers %s with %i, as verifySignedUrl decides', async (_label, status, url, verification) => {
    const res = await app.inject({ method: 'GET', url });
    expect({
      status: res.statusCode,
      verified: verifySignedUrl(url, TEST_CLOCK.now(), HMAC_KEY),
      adapter: local.verifySignedUrl(url),
    }).toEqual({ status, verified: verification, adapter: verification });
  });
});
