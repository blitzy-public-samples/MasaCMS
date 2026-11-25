/** `/_api/render/*` and `/tasks/render/*` over memory storage and the recording pool: legacy's 200 byte stream, never a signed URL. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  legacyHeaders,
  unavailableResponseFor,
} from '@opt2/platform/legacy-compat';
import { contentFileKey, type ContentFileVariant } from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, assertResponseMatchesOpenApi, loadOpenApiDocument, poolTenantExpectation, type InjectResponse } from '@opt2/platform/testing';
import { renderRequestOf, type ParsedRenderRequest, type RenderQuery } from '../../src/routes/render.js';
import { buildTestApp, createMemoryStorage, createRecordingDb, type MemoryStorage, type RecordingDb, type TestApp } from '../helpers/app.js';
import { FILE_BYTES, IDS, fileObjectRow, fileRow, seedMemoryStorage, seedRecordingDb, umbrellaSeed } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;

const UMBRELLA = TENANT_UMBRELLA.tenantId;
const PNG = 'A3F00000-0000-0000-0000000000000001';
const UNKNOWN = 'A3F00000-0000-0000-0000000000000099';
const FILE_READ = / FROM "content"\."file" WHERE /;
const LEGACY = Object.fromEntries(Object.entries(legacyHeaders()).map(([name, value]) => [name.toLowerCase(), value]));

type Row = Record<string, unknown>;

const PNG_BYTES: Readonly<Record<'' | '_small' | '_medium', Buffer>> = Object.freeze({
  '': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x0d, 0x0a]),
  _small: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x73, 0x6d, 0x00, 0xfe]),
  _medium: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x6d, 0x64, 0x00, 0xfd, 0x0a]),
});

const PNG_ROW = fileRow({
  tenant_id: UMBRELLA,
  fileid: PNG,
  siteid: TENANT_UMBRELLA.siteId,
  filename: 'logo.png',
  filesize: PNG_BYTES[''].length,
  contenttype: 'image',
  contentsubtype: 'png',
  fileext: 'png',
});

/** The umbrella file pool's `tfiles` rows: the seeded files plus the local PNG. */
const FILE_ROWS: readonly Row[] = [
  ...umbrellaSeed()
    .rows.filter(({ table }) => table.table === 'file')
    .map(({ row }) => row),
  PNG_ROW,
];

/** `content-files` key of `fileId`'s `variant` object in the umbrella file pool. */
function keyOf(fileId: string, variant: ContentFileVariant, ext: string): string {
  return contentFileKey({ tenantId: UMBRELLA, fileId, variant, ext });
}

/** Bytes of a seeded umbrella object; throws for a key the seed never stored. */
function seeded(fileId: string, variant: ContentFileVariant, ext: string): Buffer {
  const object = FILE_BYTES[keyOf(fileId, variant, ext)];
  if (object === undefined) throw new Error(`no seeded object ${keyOf(fileId, variant, ext)}`);
  return object.bytes;
}

/** HTTP date of the stored row's `created`, as streamFile's Last-Modified carries it. */
function httpCreated(fileId: string): string {
  const created = FILE_ROWS.find((row) => row.fileid === fileId)?.created;
  if (!(created instanceof Date)) throw new Error(`no created date for ${fileId}`);
  return created.toUTCString();
}

/** Answers each `content.file` read with the row of the requested id in the transaction's tenant only. */
function answerFileReads(db: RecordingDb): void {
  db.respond(FILE_READ, (params, _sql, { tenantId }) =>
    FILE_ROWS.filter(
      (row) =>
        String(row.tenant_id).toLowerCase() === String(tenantId).toLowerCase() &&
        String(row.fileid).toUpperCase() === String(params[0]).toUpperCase(),
    ).map((row) => ({ ...row })),
  );
}

/** Asserts one render request signed and stored nothing and points neither its body nor its Location at /opt2/files/. */
function expectNoSigning(res: InjectResponse, calls: MemoryStorage['calls'], signedUrls: readonly string[]): void {
  expect(calls.filter(({ op }) => op === 'signedUrl' || op === 'put')).toEqual([]);
  expect(signedUrls).toEqual([]);
  expect(res.body).not.toContain('/opt2/files/');
  expect(String(res.headers.location ?? '')).not.toContain('/opt2/files/');
}

describe('renderRequestOf', () => {
  const id = IDS.files.pdf;
  const file = (size: string, method = 'inline'): ParsedRenderRequest => ({ matched: true, kind: 'file', fileId: id, method, size });
  const sized = (kind: 'small' | 'medium'): ParsedRenderRequest => ({ matched: true, kind, fileId: id, method: 'inline', size: kind });

  it.each<[string, string, RenderQuery, ParsedRenderRequest]>([
    ['/_api/render/file/ as renderFile, sized by segment 3, inline by default', '/_api/render/file/', { fileid: id }, file('file')],
    ['/_api/render/small/ as renderSmall', '/_api/render/small/', { fileid: id }, sized('small')],
    ['/_api/render/medium/ as renderMedium', '/_api/render/medium/', { fileid: id }, sized('medium')],
    ['/tasks/render/small/ folded onto renderSmall', '/tasks/render/small/', { fileid: id }, sized('small')],
    ['a query size=medium over segment 3', '/_api/render/file/', { fileid: id, size: 'medium' }, sized('medium')],
    ['method=attachment passed through to renderFile', '/_api/render/file/', { fileid: id, method: 'attachment' }, file('file', 'attachment')],
    ['no fileid as unmatched', '/_api/render/file/', {}, { matched: false }],
  ])('parses %s [contentServer.cfc:655-668]', (_name, path, query, expected) => {
    expect(renderRequestOf(path, query)).toEqual(expected);
  });
});

describe('render routes over memory storage', () => {
  let t: TestApp;
  let storage: MemoryStorage;
  let db: RecordingDb;

  /** GETs `url`, holds it to {@link expectNoSigning}, and checks the answer against the contract operation it reaches. */
  async function get(url: string, headers: Record<string, string>): Promise<InjectResponse> {
    const calls = storage.calls.length;
    const signed = storage.signedUrls.length;
    const res = await t.app.inject({ method: 'GET', url, headers });
    expectNoSigning(res, storage.calls.slice(calls), storage.signedUrls.slice(signed));
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path: (url.split('?')[0] ?? url).replace(/\/$/, ''),
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  const member = (site: string = TENANT_A.siteId): Promise<Record<string, string>> => contentHeaders('member', { site });
  const anonymous = (): Promise<Record<string, string>> => contentHeaders('anonymous', { site: TENANT_A.siteId });

  /** Storage calls `fn` makes. */
  async function callsOf(fn: () => Promise<unknown>): Promise<MemoryStorage['calls']> {
    const before = storage.calls.length;
    await fn();
    return storage.calls.slice(before);
  }

  beforeAll(async () => {
    storage = createMemoryStorage();
    seedMemoryStorage(storage);
    for (const variant of ['', '_small', '_medium'] as const) {
      const object = fileObjectRow({ tenant_id: UMBRELLA, file_id: PNG, variant, ext: 'png', bytes: PNG_BYTES[variant] });
      storage.preload(object.object_key, PNG_BYTES[variant], 'image/png');
    }
    db = createRecordingDb();
    seedRecordingDb(db);
    answerFileReads(db);
    t = await buildTestApp({ storage, db });
  });

  afterAll(() => t?.close());

  it('streams the PDF object byte for byte with the legacy file headers [fileManager.cfc:905-938]', async () => {
    const bytes = seeded(IDS.files.pdf, '', 'pdf');
    const res = await get(`/_api/render/file/?fileid=${IDS.files.pdf}`, await member());
    const lastModified = httpCreated(IDS.files.pdf);
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);
    expect(res.headers).toMatchObject({
      'content-type': 'application/pdf; charset=UTF-8',
      'content-disposition': 'inline;filename="guide.pdf"',
      'content-length': String(bytes.length),
      'last-modified': [lastModified, lastModified],
      ...LEGACY,
    });
  });

  it.each<[string, () => string, string, () => Buffer]>([
    ['method=attachment as an attachment', () => `/_api/render/file/?fileid=${IDS.files.pdf}&method=attachment`, 'attachment;filename="guide.pdf"', () => seeded(IDS.files.pdf, '', 'pdf')],
    ['a video/mp4 file asked inline as an attachment', () => `/_api/render/file/?fileid=${IDS.files.video}&method=inline`, 'attachment;filename="clip.mp4"', () => seeded(IDS.files.video, '', 'mp4')],
    ['/_api/render/small/ of a PNG from its _small object', () => `/_api/render/small/?fileid=${PNG}`, 'inline;filename="logo.png"', () => PNG_BYTES._small],
    ['/_api/render/medium/ of a PNG from its _medium object', () => `/_api/render/medium/?fileid=${PNG}`, 'inline;filename="logo.png"', () => PNG_BYTES._medium],
    ['size=small on /_api/render/file/ of a PNG from <id>_small.png', () => `/_api/render/file/?fileid=${PNG}&size=small`, 'inline;filename="logo.png"', () => PNG_BYTES._small],
    ['/tasks/render/medium/ of the seeded JPEG from its _medium object', () => `/tasks/render/medium/?fileid=${IDS.files.image}`, 'inline;filename="photo.jpg"', () => seeded(IDS.files.image, '_medium', 'jpg')],
  ])('streams %s [fileManager.cfc:243-251,303,345,914-916]', async (_name, url, disposition, bytes) => {
    const res = await get(url(), await member());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(disposition);
    expect(res.headers['content-length']).toBe(String(bytes().length));
    expect(Buffer.compare(res.rawPayload, bytes())).toBe(0);
  });

  it.each<[string, ContentFileVariant]>([
    ['small', '_small'],
    ['medium', '_medium'],
  ])(
    'reads the flv %s rendition under its stored fileExt, so the .jpg thumbnail Masa wrote is never served and streamFile fails [fileDAO.cfc:180-186; fileManager.cfc:303,345]',
    async (size, variant) => {
      const flv = IDS.files.flv;
      expect(storage.objects.has(keyOf(flv, variant, 'jpg'))).toBe(true);
      let res: InjectResponse | undefined;
      const calls = await callsOf(async () => {
        res = await get(`/_api/render/${size}/?fileid=${flv}`, await member());
      });
      expect([res?.statusCode, res?.statusMessage, res?.headers['content-type'], res?.body]).toEqual([
        500,
        LEGACY_ERROR_STATUS_TEXT,
        LEGACY_HTML_CONTENT_TYPE,
        LEGACY_ERROR_PAGE_HTML,
      ]);
      expect(calls.map(({ op, key }) => `${op} ${key}`)).toEqual([`open ${keyOf(flv, variant, 'flv')}`]);
    },
  );

  it('serves /tasks/render/file/ with the same bytes and headers as /_api/render/file/ [contentServer.cfc:655-668]', async () => {
    const headers = await member();
    const api = await get(`/_api/render/file/?fileid=${IDS.files.pdf}`, headers);
    const tasks = await get(`/tasks/render/file/?fileid=${IDS.files.pdf}`, headers);
    expect(tasks.statusCode).toBe(200);
    expect(Buffer.compare(tasks.rawPayload, api.rawPayload)).toBe(0);
    for (const name of ['content-type', 'content-disposition', 'content-length', 'last-modified']) {
      expect(tasks.headers[name]).toEqual(api.headers[name]);
    }
  });

  it('serves a tenant-a request from its umbrella file pool and finds nothing for tenant-b, which pools no files', async () => {
    expect(poolTenantExpectation(TENANT_A, 'file')).toBe(UMBRELLA);
    expect(poolTenantExpectation(TENANT_B, 'file')).toBe(TENANT_B.tenantId);
    const url = `/_api/render/file/?fileid=${IDS.files.pdf}`;
    const fileReadTenants = async (headers: Record<string, string>): Promise<{ res: InjectResponse; tenants: Array<string | null> }> => {
      const before = db.statements.length;
      const res = await get(url, headers);
      return { res, tenants: db.statements.slice(before).filter(({ sql }) => FILE_READ.test(sql)).map(({ tenantId }) => tenantId) };
    };

    const a = await fileReadTenants(await member());
    expect(a.res.statusCode).toBe(200);
    expect(Buffer.compare(a.res.rawPayload, seeded(IDS.files.pdf, '', 'pdf'))).toBe(0);
    expect(a.tenants).toEqual([UMBRELLA]);

    const b = await fileReadTenants(await member(TENANT_B.siteId));
    expect([b.res.statusCode, b.res.statusMessage, b.res.headers['content-type'], b.res.body]).toEqual([404, 'Content Not Found', LEGACY_HTML_CONTENT_TYPE, '']);
    expect(b.tenants).toEqual([TENANT_B.tenantId]);
  });

  it.each<[string, number]>([
    ['one second after', 1_000],
    ['equal to', 0],
    ['one second before', -1_000],
  ])(
    'answers 200 with the full bytes to an If-Modified-Since %s the file date, as ACF 2023 never exposes it to streamFile [fileManager.cfc:920-925]',
    async (_name, offsetMs) => {
      const created = new Date(httpCreated(IDS.files.pdf));
      const res = await get(`/_api/render/file/?fileid=${IDS.files.pdf}`, {
        ...(await member()),
        'if-modified-since': new Date(created.getTime() + offsetMs).toUTCString(),
      });
      expect(res.statusCode).toBe(200);
      expect(Buffer.compare(res.rawPayload, seeded(IDS.files.pdf, '', 'pdf'))).toBe(0);
    },
  );

  it.each<[string, string]>([
    ['fileid=not-a-uuid on file', '/_api/render/file/?fileid=not-a-uuid'],
    ['fileid=not-a-uuid on small', '/_api/render/small/?fileid=not-a-uuid'],
    ['fileid=not-a-uuid on medium', '/_api/render/medium/?fileid=not-a-uuid'],
    ['size=x.y on file', `/_api/render/file/?fileid=${IDS.files.pdf}&size=x.y`],
  ])('answers %s with render404 before any read, needing no user token [fileManager.cfc:209-211,280-282,322-324]', async (_name, url) => {
    let res: InjectResponse | undefined;
    const calls = await callsOf(async () => {
      res = await get(url, await anonymous());
    });
    expect([res?.statusCode, res?.statusMessage, res?.headers['content-type'], res?.body]).toEqual([404, 'Content Not Found', LEGACY_HTML_CONTENT_TYPE, '']);
    expect(calls).toEqual([]);
  });

  it('answers an unknown UUID with render404 after the file pool read [fileManager.cfc:234-236]', async () => {
    const res = await get(`/_api/render/file/?fileid=${UNKNOWN}`, await member());
    expect([res.statusCode, res.statusMessage, res.headers['content-type'], res.body]).toEqual([404, 'Content Not Found', LEGACY_HTML_CONTENT_TYPE, '']);
  });

  it('fails closed with the legacy-shaped 503 for an image rendition never stored, generating no bytes [fileManager.cfc:243-247]', async () => {
    const missing = keyOf(PNG, '_thumb', 'png');
    let res: InjectResponse | undefined;
    const calls = await callsOf(async () => {
      res = await get(`/_api/render/file/?fileid=${PNG}&size=thumb`, await member());
    });
    const expected = unavailableResponseFor('api');
    expect(res?.statusCode).toBe(503);
    expect(res?.body).toBe(expected.body);
    expect(calls).toEqual([{ op: 'head', bucket: 'content-files', key: missing }]);
    expect(storage.objects.has(missing)).toBe(false);
  });

  it.each<[string, () => string, number]>([
    ['/_api/render/file/', () => `/_api/render/file/?fileid=${IDS.files.pdf}`, 200],
    ['method=attachment', () => `/_api/render/file/?fileid=${IDS.files.pdf}&method=attachment`, 200],
    ['/_api/render/small/', () => `/_api/render/small/?fileid=${PNG}`, 200],
    ['/_api/render/medium/', () => `/_api/render/medium/?fileid=${PNG}`, 200],
    ['/tasks/render/file/', () => `/tasks/render/file/?fileid=${IDS.files.pdf}`, 200],
    ['/tasks/render/medium/', () => `/tasks/render/medium/?fileid=${IDS.files.image}`, 200],
    ['an unknown UUID', () => `/_api/render/file/?fileid=${UNKNOWN}`, 404],
    ['a rendition never stored', () => `/_api/render/file/?fileid=${PNG}&size=thumb`, 503],
  ])('never signs a URL nor points a body or Location at /opt2/files/ for %s', async (_name, url, status) => {
    const calls = storage.calls.length;
    const signed = storage.signedUrls.length;
    const res = await get(url(), await member());
    expect(res.statusCode).toBe(status);
    expectNoSigning(res, storage.calls.slice(calls), storage.signedUrls.slice(signed));
  });
});
