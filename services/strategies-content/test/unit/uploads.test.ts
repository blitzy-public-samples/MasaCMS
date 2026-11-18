/** EX-FILE-RENDITION upload rules: image uploads halted, restricted files refused, non-image uploads stored under the file pool tenant, in the domain and through the JSON API file save. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { contentFileKey } from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, assertResponseMatchesOpenApi, type TenantFixture } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor } from '../../src/domain/context.js';
import {
  IMAGE_UPLOAD_EXTS,
  ImageUploadHaltedError,
  isImageUploadExt,
  requestHasRestrictedFiles,
  storeUploadedFile,
  type UploadDeps,
  type UploadedFile,
} from '../../src/domain/files.js';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildTestApp, createMemoryStorage, createRecordingDb, type RecordedStatement, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, seedRecordingDb } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, contentHeaders, subjectSessionId, type TokenSubject } from '../helpers/tokens.js';
import { uploadedFile } from '../helpers/uploads.js';

type Json = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SITE = TENANT_A.siteId;
const FILE_SAVE_URL = `/_api/json/v1/${SITE}/file`;
const TOKEN = { csrf_token: 'T0KEN', csrf_token_expires: '260630235959000' } as const;

/** The actor of a token subject's verified claims. */
function actorOf(subject: TokenSubject): Actor {
  const { site, tid, roles, s2 } = SUBJECT_CLAIMS[subject];
  return actorFromClaims(
    { iss: 'opt2-local-identity', aud: 'opt2-local', sub: SUBJECT_USER_IDS[subject], sid: subjectSessionId(subject), tid, site, roles: [...roles], s2, epoch: 0, iat: 0, exp: 0 },
    'Admin User',
  );
}

/** The payload every test upload of `fileName` carries. */
const bytesOf = (fileName: string): Buffer => Buffer.from(`%PDF-1.4 bytes of ${fileName}`);

/** A posted `newfile` part of `fileName`. */
function upload(fileName: string, contentType = 'application/pdf'): UploadedFile {
  return uploadedFile({ fieldName: 'newfile', fileName, contentType }, bytesOf(fileName));
}

/** Recorded INSERTs into `content.<table>`. */
function insertsInto(db: RecordingDb, table: string): RecordedStatement[] {
  return db.writes().filter((statement) => statement.sql.startsWith(`INSERT INTO "content"."${table}" (`));
}

/** The row a recorded single-row `INSERT … (cols) VALUES ($1, …)` binds, by unquoted column. */
function boundRow(statement: RecordedStatement): Json {
  const columns = (/^INSERT INTO \S+ \(([^)]*)\) VALUES/.exec(statement.sql)?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
  return Object.fromEntries(columns.map((column, i) => [column, statement.params[i] ?? null]));
}

describe('image upload extensions', () => {
  it('names exactly the extensions Masa writes renditions for', () => {
    expect([...IMAGE_UPLOAD_EXTS]).toEqual(['png', 'gif', 'jpg', 'jpeg', 'flv']);
  });

  it.each([
    ...IMAGE_UPLOAD_EXTS.map((ext) => [ext, true] as const),
    ['PNG', true],
    ['Jpeg', true],
    ['pdf', false],
    ['docx', false],
    ['svg', false],
    ['webp', false],
    ['mp4', false],
    ['', false],
  ] as const)('isImageUploadExt(%j) is %s', (ext, expected) => {
    expect(isImageUploadExt(ext)).toBe(expected);
  });
});

describe('requestHasRestrictedFiles', () => {
  it.each([
    ['an empty allow list allows any file', ['setup.exe'], '', false],
    ['an extension outside the list is restricted', ['setup.exe'], 'pdf,docx', true],
    ['files whose extensions are all listed are allowed', ['a.pdf', 'b.docx'], 'pdf,docx', false],
    ['extensions match the list ignoring case', ['REPORT.PDF', 'Notes.DocX'], 'pdf,DOCX', false],
    ['one restricted file among allowed ones restricts the request', ['a.pdf', 'run.exe'], 'pdf,docx', true],
  ] as const)('%s', (_case, names, allowed, expected) => {
    expect(requestHasRestrictedFiles(names.map((fileName) => ({ fileName })), allowed)).toBe(expected);
  });
});

describe('storeUploadedFile', () => {
  const db = createRecordingDb();
  const storage = createMemoryStorage();
  const deps: UploadDeps = { db, repository: createContentRepository({ clock: TEST_CLOCK }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS, storage };

  beforeEach(() => {
    db.reset();
    seedRecordingDb(db);
    storage.objects.clear();
    storage.clear();
  });

  it.each<[string, TokenSubject, string, TenantFixture]>([
    ['tenant-a, whose file pool is umbrella', 's2', IDS.content.fileNode, TENANT_UMBRELLA],
    ['tenant-b, which pools nothing', 'other-tenant', IDS.content.bPage, TENANT_B],
  ])('stores a PDF of %s once in content-files under the file pool tenant, with its file row and only its original object row in that tenant', async (_case, subject, contentId, pool) => {
    const bytes = bytesOf('Quarterly Report.PDF');
    const file = upload('Quarterly Report.PDF');
    const stored = await storeUploadedFile(deps, actorOf(subject), { file, contentId });
    if (stored.kind !== 'stored') throw new Error(`expected a stored upload, got ${stored.kind}`);

    const key = contentFileKey({ tenantId: pool.tenantId, fileId: stored.fileid, variant: '', ext: 'pdf' });
    expect(key.split('/')[0]).toBe(pool.tenantId);
    expect(storage.calls).toEqual([
      { op: 'put', bucket: CONTENT_FILES_BUCKET, key, size: bytes.length, sha256: sha256Hex(bytes), contentType: 'application/pdf' },
    ]);

    expect(isCfUuid(stored.file.fileid)).toBe(true);
    expect(stored.filename).toBe('Quarterly Report.PDF');
    expect(stored.file).toMatchObject({
      fileid: stored.fileid,
      contentid: contentId,
      siteid: pool.siteId,
      filename: 'Quarterly Report.PDF',
      fileext: 'pdf',
      contenttype: 'application',
      contentsubtype: 'pdf',
      filesize: bytes.length,
      created: TEST_CLOCK.now(),
    });

    const files = insertsInto(db, 'file');
    const objects = insertsInto(db, 'file_object');
    expect(files.map((statement) => statement.tenantId)).toEqual([pool.tenantId]);
    expect(objects.map((statement) => statement.tenantId)).toEqual([pool.tenantId]);
    expect(files.map(boundRow)).toEqual([expect.objectContaining({ fileid: stored.fileid, siteid: pool.siteId, fileext: 'pdf', filesize: bytes.length })]);
    expect(objects.map(boundRow)).toEqual([
      expect.objectContaining({ file_id: stored.fileid, variant: '', ext: 'pdf', object_key: key, size: String(bytes.length), sha256: sha256Hex(bytes) }),
    ]);
  });

  it.each([...IMAGE_UPLOAD_EXTS, 'JPG'])('halts a .%s upload under EX-FILE-RENDITION before storing, writing or opening its part', async (ext) => {
    const file = upload(`photo.${ext}`, 'image/jpeg');
    const stream = vi.spyOn(file, 'stream');
    const error = await storeUploadedFile(deps, actorOf('s2'), { file, contentId: IDS.content.fileNode }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImageUploadHaltedError);
    expect(error).toMatchObject({ ext, message: expect.stringContaining('EX-FILE-RENDITION') });
    expect(stream).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([]);
    expect(db.writes()).toEqual([]);
  });
});

type Part = { name: string; value: string } | { name: string; filename: string; type: string; data: Buffer };

/** Text field parts of `values`, in order. */
const fields = (values: Readonly<Record<string, string>>): Part[] => Object.entries(values).map(([name, value]) => ({ name, value }));

/** A file part of `filename` under form field `name`. */
const filePart = (name: string, filename: string, type = 'application/pdf', data = bytesOf(filename)): Part => ({ name, filename, type, data });

/** A stored upload's payload: binary, several stream chunks long, with CR, LF and dashes inside. */
const GUIDE_HALF = Buffer.from(Uint8Array.from({ length: 160 * 1024 }, (_, i) => (i * 131 + (i >> 8)) & 0xff));
const GUIDE = Buffer.concat([Buffer.from('%PDF-1.4\n'), GUIDE_HALF, Buffer.from('\r\n--opt2\r\n'), GUIDE_HALF]);

/** A multipart/form-data payload of `parts` in order. */
function multipart(parts: readonly Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----opt2-uploads-test';
  const chunks = parts.flatMap((part) =>
    'data' in part
      ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`), part.data, Buffer.from('\r\n')]
      : [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`)],
  );
  return { payload: Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** The JSON API `file` save of `files`. */
const fileSave = (files: readonly Part[]): Part[] => [...fields(TOKEN), ...files];

describe('upload routes', () => {
  const db = createRecordingDb();
  const storage = createMemoryStorage();
  let t: TestApp;

  beforeAll(async () => {
    t = await buildTestApp({
      db,
      storage,
      clientHandlers: {
        identity: {
          'GET /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
        },
      },
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    db.reset();
    storage.objects.clear();
    storage.clear();
    t.client.clear();
    t.client.csrfValid = true;
  });

  /** Posts `parts` to `url` as tenant-a's S2 admin, relayed by the gateway. */
  async function post(url: string, parts: readonly Part[]) {
    const body = multipart(parts);
    return t.app.inject({ method: 'POST', url, headers: { ...(await contentHeaders('s2')), ...body.headers }, payload: body.payload });
  }

  /** Validates `res` against the contract operation of `url`. */
  function expectContract(url: string, res: Awaited<ReturnType<typeof post>>): void {
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: url.split('?')[0] ?? url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  }

  it.each<[string, Part[]]>([
    ['a .gif', [filePart('newfile', 'banner.gif', 'image/gif')]],
    ['a PDF beside a .gif', [filePart('newfile', 'a.pdf'), filePart('attachment', 'banner.gif', 'image/gif')]],
  ])('refuses a JSON API file save of %s with the contract 503 before any token use, storage put or write', async (_case, parts) => {
    const res = await post(FILE_SAVE_URL, fileSave(parts));
    expectContract(FILE_SAVE_URL, res);
    expect(res.statusCode).toBe(503);
    expect(t.client.csrfConsumes).toEqual([]);
    expect(storage.calls).toEqual([]);
    expect(db.writes()).toEqual([]);
  });

  it('stores a PDF through the JSON API file save once at its content-files key in the umbrella file pool, byte for byte as posted', async () => {
    const res = await post(FILE_SAVE_URL, fileSave([filePart('newfile', 'guide-2.pdf', 'application/pdf', GUIDE)]));
    const files = insertsInto(db, 'file');
    expect(files.map((statement) => statement.tenantId)).toEqual([TENANT_UMBRELLA.tenantId]);
    const fileId = String(boundRow(files[0] as RecordedStatement).fileid);
    expect(isCfUuid(fileId)).toBe(true);
    const key = contentFileKey({ tenantId: TENANT_UMBRELLA.tenantId, fileId, variant: '', ext: 'pdf' });
    const posted = { size: GUIDE.length, sha256: sha256Hex(GUIDE) };
    expect(storage.calls).toEqual([{ op: 'put', bucket: CONTENT_FILES_BUCKET, key, ...posted, contentType: 'application/pdf' }]);
    expect(storage.objects.get(key)?.bytes).toEqual(GUIDE);
    expect(files.map(boundRow)).toEqual([expect.objectContaining({ fileid: fileId, filesize: GUIDE.length })]);
    expect(insertsInto(db, 'staged_object').map(boundRow)).toEqual([expect.objectContaining({ object_key: key, kind: 'upload', ...posted })]);
    expect(insertsInto(db, 'file_object').map(boundRow)).toEqual([expect.objectContaining({ object_key: key, size: String(GUIDE.length), sha256: posted.sha256 })]);
    expectContract(FILE_SAVE_URL, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ data: { fileid: fileId } });
  });
});
