/** Migration transfer of legacy file-store objects into `content-files`, their manifest export and the route's authorisation, over the recording database and memory storage. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, type ObjectManifestEntry } from '@opt2/platform/migration-kit';
import { contentFileKey } from '@opt2/platform/storage';
import { TENANT_A, TENANT_B, TENANT_LIST, TENANT_UMBRELLA, type TenantFixture } from '@opt2/platform/testing';
import { TFILES_TENANT_SOURCE } from '../../src/migration/mappings/files.js';
import {
  CONTENT_FILES_BUCKET,
  createExportObjects,
  storeMigrationObject,
  type FileVariant,
  type MigrationObjectRequest,
  type StoreObjectDeps,
} from '../../src/migration/objects.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { FILE, FILE_OBJECT, type FileRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, createMemoryStorage, createRecordingDb, type MemoryStorage, type RecordingDb, type TestApp } from '../helpers/app.js';
import { FILE_BYTES, IDS, contentSeed, fileRow, seedMemoryStorage, seedRecordingDb, type TenantSeed } from '../helpers/seed.js';
import { contentHeaders, serviceHeaders } from '../helpers/tokens.js';

type Row = Record<string, unknown>;

const OBJECTS_URL = '/internal/v1/migration/objects';

/** Files this suite adds to the seed: a png and an flv of tenant-a, and a png of the umbrella file pool. */
const FILES = Object.freeze({
  png: fileRow({ fileid: 'A3000000-0000-0000-00000000000000A1', filename: 'logo.png', contenttype: 'image', contentsubtype: 'png', fileext: 'png' }),
  pooledPng: fileRow({
    tenant_id: TENANT_UMBRELLA.tenantId,
    siteid: TENANT_UMBRELLA.siteId,
    fileid: 'A3000000-0000-0000-00000000000000A2',
    filename: 'banner.png',
    contenttype: 'image',
    contentsubtype: 'png',
    fileext: 'png',
  }),
  flv: fileRow({ fileid: 'A3000000-0000-0000-00000000000000A3', filename: 'intro.flv', contenttype: 'video', contentsubtype: 'x-flv', fileext: 'flv' }),
});

/** A file id no `content.file` row of any tenant has. */
const ORPHAN_FILE_ID = 'A3000000-0000-0000-00000000000000F0';

const SEEDS: readonly TenantSeed[] = [
  ...contentSeed(),
  { tenant: TENANT_A, rows: [{ table: FILE, row: FILES.png }, { table: FILE, row: FILES.flv }] },
  { tenant: TENANT_UMBRELLA, rows: [{ table: FILE, row: FILES.pooledPng }] },
];

/** The fixture `TFILES_TENANT_SOURCE` resolves a `tfiles` row to: that of its `siteID`, the pool site for a pooled file. */
function tenantOf(file: FileRow): TenantFixture {
  if (TFILES_TENANT_SOURCE.kind !== 'site') throw new TypeError('tfiles rows take their tenant from a site column');
  const siteId = (file as Row)[TFILES_TENANT_SOURCE.column.toLowerCase()];
  const tenant = TENANT_LIST.find((fixture) => fixture.siteId === siteId);
  if (tenant === undefined) throw new TypeError(`no tenant fixture has site ${String(siteId)}`);
  return tenant;
}

/** The transfer of `bytes` as one stored object, its SHA-256 computed as the migration service computes it. */
function request(fields: Omit<MigrationObjectRequest, 'sha256'>): MigrationObjectRequest {
  return { ...fields, sha256: sha256Hex(fields.bytes) };
}

/** The transfer of `bytes` as variant `variant` of `file`, under the file's tenant; extension and content type default to the file's. */
function transfer(file: FileRow, variant: FileVariant, bytes: Buffer, ext = String(file.fileext), contentType = `${file.contenttype}/${file.contentsubtype}`) {
  return request({ tenantId: tenantOf(file).tenantId, fileId: file.fileid, variant, ext, contentType, bytes });
}

/** The modelled `content.file_object` rows, each visible only in its own tenant as forced RLS keeps them. */
interface ObjectTables {
  row(tenantId: string, key: string): Row | undefined;
}

/** A `bpchar` id as the `legacy_char_ci` collation compares it: trailing spaces dropped, lower-cased. */
const legacyId = (id: unknown): string => String(id).replace(/ +$/, '').toLowerCase();

/** Object keys in byte order, the order of the manifest export's keyset. */
const byKey = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The value of `map` under `key`, created by `create` on first use. */
function entryOf<V>(map: Map<string, V>, key: string | null, create: () => V): V {
  let value = map.get(String(key));
  if (value === undefined) map.set(String(key), (value = create()));
  return value;
}

/**
 * Answers the file-row check, the manifest reads and writes and the export listing of the transfer from `seeds` and every
 * write since, as PostgreSQL would; the recording database's seeded reads ignore their WHERE clause.
 */
function modelObjectTables(db: RecordingDb, seeds: readonly TenantSeed[]): ObjectTables {
  const fileIds = new Map<string, Set<string>>();
  const objects = new Map<string, Map<string, Row>>();
  const idsOf = (tenantId: string | null): Set<string> => entryOf(fileIds, tenantId, () => new Set());
  const objectsOf = (tenantId: string | null): Map<string, Row> => entryOf(objects, tenantId, () => new Map());
  for (const { tenant, rows } of seeds) {
    for (const { table, row } of rows) {
      if (table === FILE) idsOf(tenant.tenantId).add(legacyId(row.fileid));
      if (table === FILE_OBJECT) objectsOf(tenant.tenantId).set(String(row.object_key), { ...row });
    }
  }

  db.respond(/^SELECT 1 FROM "content"\."file" WHERE /i, (params, _sql, { tenantId }) => (idsOf(tenantId).has(legacyId(params[0])) ? [{ '?column?': 1 }] : []));
  db.respond(/ FROM "content"\."file_object" WHERE (?:"tenant_id" = \$1 AND )?"object_key" = \$\d+(?: FOR UPDATE)?$/i, (params, _sql, { tenantId }) => {
    const row = objectsOf(tenantId).get(String(params.at(-1)));
    return row === undefined ? [] : [{ ...row }];
  });
  db.respond(/^INSERT INTO "content"\."file_object" /i, (params, sql, { tenantId }) => {
    const columns = (/\(([^)]+)\) VALUES/.exec(sql)?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
    const row: Row = Object.fromEntries(columns.map((column, i) => [column, params[i]]));
    const table = objectsOf(tenantId);
    if (table.has(String(row.object_key))) return [];
    table.set(String(row.object_key), row);
    return [{ ...row }];
  });
  db.respond(/^UPDATE "content"\."file_object" SET /i, (params, sql, { tenantId }) => {
    const row = objectsOf(tenantId).get(String(params.at(-1)));
    if (row === undefined) return [];
    for (const [, column = '', index] of (/ SET (.+) WHERE /.exec(sql)?.[1] ?? '').matchAll(/"(\w+)" = \$(\d+)/g)) {
      row[column] = params[Number(index) - 1];
    }
    return [{ ...row }];
  });
  db.respond(/^SELECT .+ FROM "content"\."file_object"(?: WHERE "object_key" > \$1)? ORDER BY "object_key" LIMIT \$\d$/i, (params, _sql, { tenantId }) => {
    const after = params.length === 2 ? String(params[0]) : undefined;
    return [...objectsOf(tenantId).values()]
      .filter((row) => after === undefined || byKey(String(row.object_key), after) > 0)
      .sort((a, b) => byKey(String(a.object_key), String(b.object_key)))
      .slice(0, Number(params.at(-1)));
  });

  return { row: (tenantId, key) => objects.get(tenantId)?.get(key) };
}

let db: RecordingDb;
let storage: MemoryStorage;
let tables: ObjectTables;
let deps: StoreObjectDeps;

beforeEach(() => {
  db = createRecordingDb();
  seedRecordingDb(db, SEEDS);
  tables = modelObjectTables(db, SEEDS);
  storage = createMemoryStorage();
  seedMemoryStorage(storage);
  deps = { db, repository: createContentRepository({ clock: TEST_CLOCK }), storage, clock: TEST_CLOCK };
});

/** Recorded writes of the manifest table and the changelog, as `<verb> <table>`; publication intents and their changelog rows are left out. */
function manifestWrites(): string[] {
  return db
    .writes()
    .filter((write) => write.params[1] !== 'staged_object')
    .map((write) => /^(INSERT INTO|UPDATE|DELETE FROM) "content"\."(file_object|changelog)"/i.exec(write.sql))
    .flatMap((match) => (match === null ? [] : [`${match[1]?.split(' ')[0]} ${match[2]}`]));
}

/** Keys of every recorded `put`. */
const puts = (): string[] => storage.calls.filter((call) => call.op === 'put').map((call) => call.key);

describe('storeMigrationObject', () => {
  it.each(
    (['', '_source', '_small', '_medium'] as const).flatMap((variant) => [
      ['tenant-a', FILES.png, variant] as const,
      ['umbrella-pooled', FILES.pooledPng, variant] as const,
    ]),
  )('stores the %s png variant %j under its tfiles tenant with one manifest row', async (_label, file, variant) => {
    const bytes = Buffer.from(`legacy ${String(file.filename)}${variant} bytes`);
    const tenantId = tenantOf(file).tenantId;
    const key = contentFileKey({ tenantId, fileId: file.fileid, variant, ext: 'png' });

    const result = await storeMigrationObject(deps, transfer(file, variant, bytes));

    expect(result).toEqual({
      tenantId,
      key,
      fileId: file.fileid,
      variant,
      ext: 'png',
      size: bytes.length,
      sha256: sha256Hex(bytes),
      contentType: 'image/png',
      orphan: false,
      created: true,
    });
    expect(storage.calls.filter((call) => call.op === 'put')).toEqual([
      { op: 'put', bucket: CONTENT_FILES_BUCKET, key, size: bytes.length, sha256: sha256Hex(bytes), contentType: 'image/png' },
    ]);
    expect(storage.objects.get(key)?.bytes).toEqual(bytes);
    expect(tables.row(tenantId, key)).toEqual({
      tenant_id: tenantId,
      file_id: file.fileid,
      variant,
      ext: 'png',
      object_key: key,
      size: String(bytes.length),
      sha256: sha256Hex(bytes),
      content_type: 'image/png',
      orphan: false,
      created_at: TEST_CLOCK.now(),
    });
    expect(manifestWrites()).toEqual(['INSERT file_object', 'INSERT changelog']);
    for (const other of TENANT_LIST.filter((fixture) => fixture.tenantId !== tenantId)) {
      expect(tables.row(other.tenantId, key)).toBeUndefined();
    }
  });

  it.each(['_small', '_medium'] as const)('stores the flv %s rendition under its own jpg extension', async (variant) => {
    const bytes = Buffer.from(`legacy intro.flv ${variant} frame`);

    const result = await storeMigrationObject(deps, transfer(FILES.flv, variant, bytes, 'jpg', 'image/jpeg'));

    expect(result).toMatchObject({ key: `${TENANT_A.tenantId}/${FILES.flv.fileid}${variant}.jpg`, ext: 'jpg', orphan: false, created: true });
    expect(storage.objects.get(result.key)).toMatchObject({ bytes, contentType: 'image/jpeg' });
    expect(tables.row(TENANT_A.tenantId, result.key)).toMatchObject({ file_id: FILES.flv.fileid, variant, ext: 'jpg', sha256: sha256Hex(bytes) });
  });

  it.each<[string, () => Promise<MigrationObjectRequest>]>([
    [
      'an object this suite stored',
      async () => {
        const req = transfer(FILES.png, '_small', Buffer.from('legacy logo.png small rendition'));
        await storeMigrationObject(deps, req);
        return req;
      },
    ],
    [
      'a backfilled seed object',
      async () => {
        const key = contentFileKey({ tenantId: TENANT_UMBRELLA.tenantId, fileId: IDS.files.image, variant: '_medium', ext: 'jpg' });
        const seeded = FILE_BYTES[key];
        if (seeded === undefined) throw new Error(`the seed stores no object under ${key}`);
        return request({ tenantId: TENANT_UMBRELLA.tenantId, fileId: IDS.files.image, variant: '_medium', ext: 'jpg', contentType: seeded.contentType, bytes: seeded.bytes });
      },
    ],
  ])('answers a repeated transfer of %s as unchanged, without a put or a manifest write', async (_label, prepare) => {
    const req = await prepare();
    const key = contentFileKey(req);
    const recorded = { ...tables.row(req.tenantId, key) };
    db.clear();
    storage.clear();

    const result = await storeMigrationObject(deps, req);

    expect(result).toMatchObject({ tenantId: req.tenantId, key, size: req.bytes.length, sha256: req.sha256, orphan: false, created: false });
    expect(puts()).toEqual([]);
    expect(manifestWrites()).toEqual([]);
    expect(tables.row(req.tenantId, key)).toEqual(recorded);
    expect(storage.objects.get(key)?.bytes).toEqual(req.bytes);
  });

  it('replaces the stored bytes and updates the manifest row when the same key arrives with new bytes', async () => {
    const first = Buffer.from('legacy logo.png as first copied');
    const second = Buffer.from('legacy logo.png as re-uploaded later');
    const stored = await storeMigrationObject(deps, transfer(FILES.png, '', first));
    db.clear();
    storage.clear();

    const replaced = await storeMigrationObject(deps, transfer(FILES.png, '', second));

    expect(replaced).toMatchObject({ key: stored.key, size: second.length, sha256: sha256Hex(second), created: true });
    expect(storage.objects.get(stored.key)?.bytes).toEqual(second);
    expect(tables.row(TENANT_A.tenantId, stored.key)).toMatchObject({ size: String(second.length), sha256: sha256Hex(second) });
    expect(manifestWrites()).toEqual(['UPDATE file_object', 'INSERT changelog']);
    // The replaced version is backed up before the put and its backup deleted once the replacement commits.
    expect(puts()).toEqual([expect.stringMatching(new RegExp(`^${TENANT_A.tenantId}/\\.staged/`)), stored.key]);
    expect([...storage.objects.keys()].filter((key) => key.includes('/.staged/'))).toEqual([]);
  });

  it.each([
    ['no content.file row of any tenant', ORPHAN_FILE_ID],
    ['a content.file row of tenant-a only', FILES.png.fileid],
  ])('stores an object of a file id with %s under the umbrella tenant, flagged as an orphan', async (_label, fileId) => {
    const bytes = Buffer.from(`legacy orphan ${fileId}`);
    const key = `${TENANT_UMBRELLA.tenantId}/${fileId}.pdf`;

    const result = await storeMigrationObject(
      deps,
      request({ tenantId: TENANT_UMBRELLA.tenantId, fileId, variant: '', ext: 'pdf', contentType: 'application/pdf', bytes }),
    );

    expect(result).toMatchObject({ tenantId: TENANT_UMBRELLA.tenantId, key, orphan: true, created: true });
    expect(storage.objects.get(key)?.bytes).toEqual(bytes);
    expect(tables.row(TENANT_UMBRELLA.tenantId, key)).toMatchObject({ file_id: fileId, orphan: true });
  });
});

describe('createExportObjects', () => {
  /** One export page of `tenant`'s `content.file` manifest, read in that tenant. */
  const exportOf = (tenant: TenantFixture, scope: { unit?: string; after?: string; limit?: number } = {}) =>
    db.withTenant(tenant.tenantId, (tx) => createExportObjects({ storage })(tx, { unit: FILE.unit, tenantId: tenant.tenantId, ...scope }));

  /** The manifest entry of `bytes` stored under `key`, as the contract's `ObjectManifestEntry` has it: no file id, variant or orphan flag. */
  const entry = (key: string, bytes: Buffer, contentType: string): ObjectManifestEntry => ({ key, size: bytes.length, sha256: sha256Hex(bytes), contentType });

  /** The manifest of the umbrella seed, in object-key byte order. */
  const seededManifest = (): ObjectManifestEntry[] =>
    Object.entries(FILE_BYTES)
      .map(([key, object]) => entry(key, object.bytes, object.contentType))
      .sort((a, b) => byKey(a.key, b.key));

  it("lists each tenant's stored objects in object-key byte order with their contract manifest fields, and no other tenant's", async () => {
    const pooled = Buffer.from('legacy banner.png original');
    const original = Buffer.from('legacy logo.png original');
    const medium = Buffer.from('legacy intro.flv medium frame');
    await storeMigrationObject(deps, transfer(FILES.pooledPng, '', pooled));
    await storeMigrationObject(deps, transfer(FILES.flv, '_medium', medium, 'jpg', 'image/jpeg'));
    await storeMigrationObject(deps, transfer(FILES.png, '', original));

    expect(await exportOf(TENANT_UMBRELLA)).toEqual({
      objects: [...seededManifest(), entry(`${TENANT_UMBRELLA.tenantId}/${FILES.pooledPng.fileid}.png`, pooled, 'image/png')].sort((a, b) => byKey(a.key, b.key)),
      next: null,
    });
    expect(await exportOf(TENANT_A)).toEqual({
      objects: [
        entry(`${TENANT_A.tenantId}/${FILES.png.fileid}.png`, original, 'image/png'),
        entry(`${TENANT_A.tenantId}/${FILES.flv.fileid}_medium.jpg`, medium, 'image/jpeg'),
      ],
      next: null,
    });
    expect(await exportOf(TENANT_B)).toEqual({ objects: [], next: null });
  });

  it('pages the manifest by object key: a full page names its last key as next, and a short page ends it with null', async () => {
    const manifest = seededManifest();
    const pages: ObjectManifestEntry[][] = [];
    let after: string | undefined;
    for (;;) {
      const page = await exportOf(TENANT_UMBRELLA, { limit: 4, ...(after === undefined ? {} : { after }) });
      if (Array.isArray(page)) throw new TypeError('the content.file manifest is paged');
      pages.push(page.objects);
      expect(page.next).toBe(page.objects.length < 4 ? null : page.objects.at(-1)?.key);
      if (page.next === null) break;
      after = page.next;
    }

    expect(pages.map((page) => page.length)).toEqual([4, 4, manifest.length - 8]);
    expect(pages.flat()).toEqual(manifest);
  });

  it('lists no objects for a unit other than content.file', async () => {
    expect(await exportOf(TENANT_UMBRELLA, { unit: 'content.content' })).toEqual([]);
  });
});

describe(`POST ${OBJECTS_URL}`, () => {
  let built: TestApp;

  beforeEach(async () => {
    built = await buildTestApp({ db, storage });
    db.clear();
    storage.clear();
  });

  afterEach(() => built.close());

  /** Posts `req` as the migration service sends it: the object fields in the query and the bytes as the raw body. */
  const post = (headers: Record<string, string>, req: MigrationObjectRequest) =>
    built.app.inject({
      method: 'POST',
      url: OBJECTS_URL,
      query: { tenantId: req.tenantId, fileId: req.fileId, variant: req.variant, ext: req.ext, contentType: req.contentType, sha256: req.sha256 },
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: req.bytes,
    });

  it.each<[string, () => void]>([
    ['with every gate open', () => undefined],
    ['while content.file is closed for a write-window import', () => db.setGate(FILE.unit, 'closed', 'importing')],
  ])('stores the body for the platform.migration service %s and answers the contract FileObject', async (_label, arrange) => {
    arrange();
    const req = transfer(FILES.png, '_source', Buffer.from('legacy logo.png source upload'));
    const key = contentFileKey(req);

    const res = await post(await serviceHeaders('platform.migration'), req);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key, size: req.bytes.length, sha256: req.sha256, created: true });
    expect(storage.objects.get(key)?.bytes).toEqual(req.bytes);
    expect(tables.row(TENANT_A.tenantId, key)).toMatchObject({ sha256: req.sha256, orphan: false });
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', async () => ({}), 401],
    ['the platform.operator service', () => serviceHeaders('platform.operator'), 403],
    ['the programs-sites service', () => serviceHeaders('service:programs-sites'), 403],
    ['an S2 user relayed by the gateway', () => contentHeaders('s2'), 403],
  ])('refuses %s before anything is stored', async (_label, headersOf, status) => {
    const req = transfer(FILES.png, '_small', Buffer.from('legacy logo.png small rendition'));

    const res = await post(await headersOf(), req);

    expect(res.statusCode).toBe(status);
    expect(storage.calls).toEqual([]);
    expect(db.writes()).toEqual([]);
    expect(tables.row(TENANT_A.tenantId, contentFileKey(req))).toBeUndefined();
  });
});
