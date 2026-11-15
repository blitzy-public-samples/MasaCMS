/** EX-FILE-RENDITION upload rules: image uploads halted, restricted files refused, non-image uploads stored under the file pool tenant, in the domain and through carch.update and the JSON API file save. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

type Json = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SITE = TENANT_A.siteId;
const HOME = IDS.content.root;
const UPDATE_URL = `/v1/raw/carch/update?siteid=${SITE}`;
const FILE_SAVE_URL = `/_api/json/v1/${SITE}/file`;
const TOKEN = { csrf_token: 'T0KEN', csrf_token_expires: '260630235959000' } as const;
const RESTRICTED_FILES = 'The posted request contained restricted file types';

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
  return { fieldName: 'newfile', fileName, contentType, bytes: bytesOf(fileName) };
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
    const file = upload('Quarterly Report.PDF');
    const stored = await storeUploadedFile(deps, actorOf(subject), { file, contentId });
    if (stored.kind !== 'stored') throw new Error(`expected a stored upload, got ${stored.kind}`);

    const key = contentFileKey({ tenantId: pool.tenantId, fileId: stored.fileid, variant: '', ext: 'pdf' });
    expect(key.split('/')[0]).toBe(pool.tenantId);
    expect(storage.calls).toEqual([
      { op: 'put', bucket: CONTENT_FILES_BUCKET, key, size: file.bytes.length, sha256: sha256Hex(file.bytes), contentType: 'application/pdf' },
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
      filesize: file.bytes.length,
      created: TEST_CLOCK.now(),
    });

    const files = insertsInto(db, 'file');
    const objects = insertsInto(db, 'file_object');
    expect(files.map((statement) => statement.tenantId)).toEqual([pool.tenantId]);
    expect(objects.map((statement) => statement.tenantId)).toEqual([pool.tenantId]);
    expect(files.map(boundRow)).toEqual([expect.objectContaining({ fileid: stored.fileid, siteid: pool.siteId, fileext: 'pdf', filesize: file.bytes.length })]);
    expect(objects.map(boundRow)).toEqual([
      expect.objectContaining({ file_id: stored.fileid, variant: '', ext: 'pdf', object_key: key, size: String(file.bytes.length), sha256: sha256Hex(file.bytes) }),
    ]);
  });

  it.each([...IMAGE_UPLOAD_EXTS, 'JPG'])('halts a .%s upload under EX-FILE-RENDITION before storing or writing anything', async (ext) => {
    const error = await storeUploadedFile(deps, actorOf('s2'), { file: upload(`photo.${ext}`, 'image/jpeg'), contentId: IDS.content.fileNode }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ImageUploadHaltedError);
    expect(error).toMatchObject({ ext, message: expect.stringContaining('EX-FILE-RENDITION') });
    expect(storage.calls).toEqual([]);
    expect(db.writes()).toEqual([]);
  });
});

type Part = { name: string; value: string } | { name: string; filename: string; type: string; data: Buffer };

/** Text field parts of `values`, in order. */
const fields = (values: Readonly<Record<string, string>>): Part[] => Object.entries(values).map(([name, value]) => ({ name, value }));

/** A file part of `filename` under form field `name`. */
const filePart = (name: string, filename: string, type = 'application/pdf'): Part => ({ name, filename, type, data: bytesOf(filename) });

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

/** carch.update's add of a new File item under the home page, posting `file` as the edit form does. */
const fileAdd = (file: Part, form: Readonly<Record<string, string>> = {}): Part[] => [
  ...fields({ siteid: SITE, contentid: '', parentid: HOME, type: 'File', subtype: 'Default', title: 'Uploaded', action: 'add', approved: '1', ...TOKEN, ...form }),
  file,
];

/** carch.update's multi-file upload of `files` into the home page, the item body supplied as the uploader's extra params do. */
const multiFileUpload = (files: readonly Part[], body: string): Part[] => [
  ...fields({ siteid: SITE, parentid: HOME, action: 'multiFileUpload', subtype: 'Default', approved: '1', extraParams: JSON.stringify({ body }), ...TOKEN }),
  ...files,
];

/** The JSON API `file` save of `files`. */
const fileSave = (files: readonly Part[]): Part[] => [...fields(TOKEN), ...files];

/** The active home page of tenant-a. */
const homeRow = (): Json => ({
  tenant_id: TENANT_A.tenantId,
  contentid: HOME,
  contenthistid: IDS.hist.rootActive,
  siteid: SITE,
  parentid: IDS.rootParent,
  path: HOME,
  type: 'Page',
  subtype: 'Default',
  title: 'Home',
  menutitle: 'Home',
  filename: '',
  active: 1,
  approved: 1,
  display: 1,
  isnav: 1,
  inheritobjects: 'Inherit',
  moduleid: IDS.modules.content,
  lastupdate: new Date(2026, 5, 2, 14, 5, 6),
  changesetid: null,
  remoteurl: null,
});

/**
 * Answers carch.update's version reads over the home page and the versions it inserts, matching the ids bound as `$1`.
 * seedRecordingDb is not used here: it answers every content read with every row, so carch.update's crumb walk never ends.
 */
function seedContentReads(db: RecordingDb): Json[] {
  const rows: Json[] = [homeRow()];
  const byIds =
    (column: 'contentid' | 'contenthistid', activeOnly: boolean) =>
    (params: readonly unknown[]): Json[] => {
      const ids = [params[0]].flat().map((id) => String(id).toLowerCase());
      return rows.filter((row) => (!activeOnly || row.active === 1) && ids.includes(String(row[column]).toLowerCase()));
    };
  db.respond(/^SELECT tcontent\.active, .* WHERE tcontent\.contentid = ANY/, byIds('contentid', true));
  db.respond(/^SELECT tcontent\.active, .* WHERE tcontent\.contenthistid = ANY/, byIds('contenthistid', false));
  db.respond(/tfiles\.fileext, tapprovalassignments\.chainid, tapprovalassignments\.exemptid FROM/, (params) =>
    byIds('contentid', true)(params).map((row) => ({ fileext: null, chainid: null, exemptid: null, ...row })),
  );
  db.respond(/^INSERT INTO "content"\."content" \(/, (params, sql) => {
    const row = { ...boundRow({ sql, params, tenantId: null }), tcontent_id: rows.length + 1 };
    rows.push(row);
    return [row];
  });
  return rows;
}

describe('upload routes', () => {
  const db = createRecordingDb();
  const storage = createMemoryStorage();
  let t: TestApp;
  let content: Json[] = [];

  beforeAll(async () => {
    t = await buildTestApp({
      db,
      storage,
      clientHandlers: {
        identity: {
          'GET /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
          'POST /v1/csrf/tokens': (req) => ({
            status: 200,
            headers: {},
            body: {
              tokens: (req.json as { contexts: string[] }).contexts.map((context) => ({ context, csrf_token: `ISSUED-${context}`, csrf_token_expires: TOKEN.csrf_token_expires })),
            },
          }),
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
    content = seedContentReads(db);
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

  // The `{upload=image}` variants are excluded from the contract and routed to legacy by the gateway; a direct call
  // reaching carch.update gets the service's unhandled-error answer.
  it.each<[string, Part[], unknown]>([
    ['adding a File with a .jpg', fileAdd(filePart('newfile', 'photo.jpg', 'image/jpeg')), expect.stringMatching(/^[0-9A-F-]{35}add$/)],
    [
      'a multi-file upload of a .png among PDFs',
      multiFileUpload([filePart('files', 'photo.png', 'image/png'), filePart('files', 'a.pdf'), filePart('files', 'b.pdf')], 'photo.png'),
      `${HOME}multifileupload`,
    ],
  ])('refuses carch.update %s at the upload, after its token is accepted, with the server_error answer and no storage put or write', async (_case, parts, context) => {
    const res = await post(UPDATE_URL, parts);
    expect(t.client.csrfConsumes.map((consume) => consume.context)).toEqual([context]);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } });
    expect(storage.calls).toEqual([]);
    expect(db.writes()).toEqual([]);
  });

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

  it('answers an ajax File add of a restricted .exe with the legacy requestHasRestrictedFiles error, writing nothing', async () => {
    const res = await post(UPDATE_URL, fileAdd(filePart('newfile', 'setup.exe', 'application/octet-stream'), { ajaxrequest: 'true' }));
    expectContract(UPDATE_URL, res);
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
    expect(res.body).toMatch(
      new RegExp(
        `^\\{success:false,\\n\\t\\terrors:\\{"requestHasRestrictedFiles":"${RESTRICTED_FILES}"\\},\\n\\t\\tcsrf_token: 'ISSUED-[0-9A-F-]{35}add',\\n\\t\\tcsrf_token_expires: '${TOKEN.csrf_token_expires}'\\n\\}$`,
      ),
    );
    expect(storage.calls).toEqual([]);
    expect(db.writes()).toEqual([]);
  });

  it.each<[string, string, Part[], (res: Awaited<ReturnType<typeof post>>, fileId: string) => void]>([
    [
      'carch.update adding a File',
      UPDATE_URL,
      fileAdd(filePart('newfile', 'guide-2.pdf')),
      (res, fileId) => {
        expectContract(UPDATE_URL, res);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toMatch(/muraAction=cArch\.list&/);
        expect(content.at(-1)).toMatchObject({ type: 'File', fileid: fileId, body: 'guide-2.pdf' });
      },
    ],
    [
      'carch.update multiFileUpload',
      UPDATE_URL,
      multiFileUpload([filePart('files', 'guide-2.pdf')], 'guide-2.pdf'),
      (res, fileId) => {
        expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/plain; charset=utf-8']);
        expect(JSON.parse(res.body)).toEqual({ files: [expect.objectContaining({ filename: 'guide-2.pdf', body: 'guide-2.pdf', size: bytesOf('guide-2.pdf').length })] });
        expect(content.at(-1)).toMatchObject({ type: 'File', fileid: fileId, body: 'guide-2.pdf' });
      },
    ],
    [
      'the JSON API file save',
      FILE_SAVE_URL,
      fileSave([filePart('newfile', 'guide-2.pdf')]),
      (res, fileId) => {
        expectContract(FILE_SAVE_URL, res);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ data: { fileid: fileId } });
      },
    ],
  ])('stores a PDF through %s once at its content-files key in the umbrella file pool', async (_case, url, parts, answers) => {
    const res = await post(url, parts);
    const files = insertsInto(db, 'file');
    expect(files.map((statement) => statement.tenantId)).toEqual([TENANT_UMBRELLA.tenantId]);
    const fileId = String(boundRow(files[0] as RecordedStatement).fileid);
    expect(isCfUuid(fileId)).toBe(true);
    const bytes = bytesOf('guide-2.pdf');
    expect(storage.calls).toEqual([
      {
        op: 'put',
        bucket: CONTENT_FILES_BUCKET,
        key: contentFileKey({ tenantId: TENANT_UMBRELLA.tenantId, fileId, variant: '', ext: 'pdf' }),
        size: bytes.length,
        sha256: sha256Hex(bytes),
        contentType: 'application/pdf',
      },
    ]);
    answers(res, fileId);
  });
});
