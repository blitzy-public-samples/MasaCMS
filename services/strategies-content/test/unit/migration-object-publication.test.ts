/**
 * `storeMigrationObject` over a throwaway `content` schema and local storage: per-key serialization, backup and restore of
 * replaced versions after failed manifest writes, puts, commits and crashes, recovery of the ledger, and the same-hash no-op.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { closeGates, ensureUnitGates, openGates, type ObjectManifestEntry } from '@opt2/platform/migration-kit';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter, type ObjectHead, type StoragePort } from '@opt2/platform/storage';
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, testVerifier, writeTestSecrets, type ThrowawaySchema } from '@opt2/platform/testing';
import { StagedObjectMissingError, StagedObjectsPendingError, recoverStagedObjects, settleStagedObject, stageObject } from '../../src/migration/staged-objects.js';
import { hasStaleStagedObjects, type StagedObjectEntry } from '../../src/repo/files.js';
import { registerMigrationObjectRoutes } from '../../src/routes/migration-objects.js';
import {
  CONTENT_FILES_BUCKET,
  exportObjects,
  storeMigrationObject,
  type MigrationObjectRequest,
  type StoreObjectDeps,
  type StoredObjectResult,
} from '../../src/migration/objects.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';

const SERVICE = 'strategies-content';
const NOW = new Date('2026-06-30T12:00:00.000Z');
const PDF = 'application/pdf';
const LOCK_WAIT_MS = 5_000;

/** What `content.file_object` and `content-files` hold for one key, with the stage ids of its tenant's stored backups. */
interface KeyState {
  row: { sha256: string; size: number } | null;
  head: ObjectHead | null;
  bytes: Buffer | null;
  backups: string[];
}

const ABSENT: KeyState = { row: null, head: null, bytes: null, backups: [] };

let handle: ThrowawaySchema;
let stateDir: string;
let storage: LocalStorageAdapter;
let repository: ContentRepository;
let db: TenantDb;
let fileSeq = 0;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A CF-format file id no other case of this file uses. */
const nextFileId = (): string => `B1C2D3E4-${(++fileSeq).toString(16).toUpperCase().padStart(4, '0')}-4A5B-8C7D9E0F1A2B3C4D`;

const keyOf = (fileId: string): string => `${TENANT_A.tenantId}/${fileId}.pdf`;
const tenantOf = (key: string): string => key.slice(0, key.indexOf('/'));
const isBackup = (key: string): boolean => key.includes('/.staged/');

/** The transfer of `bytes` as the original of `fileId`. */
function request(fileId: string, bytes: Buffer, contentType = PDF): MigrationObjectRequest {
  return { tenantId: TENANT_A.tenantId, fileId, variant: '', ext: 'pdf', contentType, sha256: sha256(bytes), bytes };
}

/** `storeMigrationObject` as the `platform.migration` service calls it, so its manifest write carries the migration authority. */
function store(storeDeps: StoreObjectDeps, req: MigrationObjectRequest): Promise<StoredObjectResult> {
  return runWithRequestContext({ ...newRequestContext(), service: { name: 'migration', roles: [Roles.platformMigration] } }, () =>
    storeMigrationObject(storeDeps, req),
  );
}

/** The real collaborators, with `overrides` applied. */
function deps(overrides: Partial<StoreObjectDeps> = {}): StoreObjectDeps {
  return { db, repository, storage, clock: fixedClock(NOW), ...overrides };
}

/** The local adapter, recording each `put` and `delete` it receives in `writes` as `<op> backup` or `<op> object`. */
function recordingStorage(): { storage: StoragePort; writes: string[] } {
  const writes: string[] = [];
  const target = (key: string): string => (isBackup(key) ? 'backup' : 'object');
  return {
    writes,
    storage: {
      ...storage,
      put: (bucket, key, body, opts) => {
        writes.push(`put ${target(key)}`);
        return storage.put(bucket, key, body, opts);
      },
      delete: (bucket, key) => {
        writes.push(`delete ${target(key)}`);
        return storage.delete(bucket, key);
      },
    },
  };
}

/** `base` with the put of every non-backup key replaced by `put`. */
function objectPut(put: StoragePort['put'], base: StoragePort = storage): StoragePort {
  return { ...base, put: (bucket, key, body, opts) => (isBackup(key) ? base.put(bucket, key, body, opts) : put(bucket, key, body, opts)) };
}

/** Stage ids of the backups stored under `tenantId`, read from the local adapter's directory. */
async function backupsOf(tenantId: string): Promise<string[]> {
  try {
    const names = await readdir(path.join(stateDir, 'storage', CONTENT_FILES_BUCKET, tenantId, '.staged'));
    return names.filter((name) => !name.startsWith('.')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** The committed manifest row and the stored object of `key`. */
async function stateOf(key: string): Promise<KeyState> {
  const { rows } = await handle.app.withTenant(tenantOf(key), (tx) =>
    tx.query<{ sha256: string; size: string }>(`SELECT sha256, size FROM ${handle.schema}.file_object WHERE object_key = $1`, [key]),
  );
  const head = await storage.head(CONTENT_FILES_BUCKET, key);
  return {
    row: rows[0] === undefined ? null : { sha256: rows[0].sha256, size: Number(rows[0].size) },
    head,
    bytes: head === null ? null : await storage.get(CONTENT_FILES_BUCKET, key),
    backups: await backupsOf(tenantOf(key)),
  };
}

/** The state of a key whose row and object both hold `bytes`, with no backup left. */
function published(bytes: Buffer, contentType = PDF): KeyState {
  return {
    row: { sha256: sha256(bytes), size: bytes.length },
    head: { sha256: sha256(bytes), size: bytes.length, contentType },
    bytes,
    backups: [],
  };
}

/** The manifest entry of a published PDF object. */
function manifestOf(key: string, bytes: Buffer): ObjectManifestEntry {
  return { key, size: bytes.length, sha256: sha256(bytes), contentType: PDF };
}

/** Resolves once a transaction waits for the publication lock of `key`; rejects after `LOCK_WAIT_MS`. */
async function lockAwaited(key: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const { rows } = await handle.adminPool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [`${handle.schema}.file_object:${key}`],
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No transaction waited for the publication lock of ${key}`);
}

async function stagedFor(key: string): Promise<StagedObjectEntry[]> {
  return db.withTenant(tenantOf(key), async (tx) =>
    (await tx.query<StagedObjectEntry>(`SELECT * FROM ${handle.schema}.staged_object WHERE object_key = $1`, [key])).rows,
  );
}

async function backdate(key: string): Promise<void> {
  await db.withTenant(tenantOf(key), (tx) => tx.query(
    `UPDATE ${handle.schema}.staged_object SET recorded_at = clock_timestamp() - interval '2 minutes' WHERE object_key = $1`, [key],
  ));
}

const manifest = (tenantId = TENANT_A.tenantId) => db.withTenant(tenantId, (tx) => exportObjects(tx, { unit: 'content.file', tenantId, limit: 1000 }));

/** The entries of `key` in its tenant's object manifest. */
async function listed(key: string): Promise<ObjectManifestEntry[]> {
  const exported = await manifest(tenantOf(key));
  return (Array.isArray(exported) ? exported : exported.objects).filter((entry) => entry.key === key);
}

async function intent(fileId: string, bytes: Buffer): Promise<StagedObjectEntry> {
  return stageObject(deps(), {
    tenant_id: TENANT_A.tenantId, kind: 'migration', object_key: keyOf(fileId), file_id: fileId,
    variant: '', ext: 'pdf', size: bytes.length, sha256: sha256(bytes), content_type: PDF,
  });
}

describe.skipIf(!(await pgAvailable()))('migration object publication', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await seedRegistry(handle.app);
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-object-publication-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'object-publication-test-key' });
    repository = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    db = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it.each([
    ['a new key', false],
    ['a key holding a published version', true],
  ])('serializes two concurrent publications of %s, so the later one owns both row and bytes', async (_label, existing) => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    const first = Buffer.from('first concurrent version');
    const second = Buffer.from('second concurrent version, longer');
    if (existing) await store(deps(), request(fileId, Buffer.from('published version')));

    const events: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = (): void => undefined;
    const firstPutStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const delayed: StoragePort = {
      ...storage,
      head: (bucket, objectKey) => {
        events.push('head');
        return storage.head(bucket, objectKey);
      },
      put: async (bucket, objectKey, body, opts) => {
        if (isBackup(objectKey)) {
          events.push('backup');
          return storage.put(bucket, objectKey, body, opts);
        }
        const which = body === first ? 'first' : 'second';
        events.push(`put ${which}`);
        if (which === 'first') {
          firstStarted();
          await firstHeld;
        }
        const put = await storage.put(bucket, objectKey, body, opts);
        events.push(`stored ${which}`);
        return put;
      },
    };

    const firstStore = store(deps({ storage: delayed }), request(fileId, first));
    await Promise.race([firstPutStarted, firstStore]);
    const secondStore = store(deps({ storage: delayed }), request(fileId, second));
    // The first put is released only once the second publication waits for the key, so neither can outlive a failed wait.
    const [results] = await Promise.all([Promise.all([firstStore, secondStore]), lockAwaited(key).finally(releaseFirst)]);
    expect(results.map((result) => [result.sha256, result.created])).toEqual([
      [sha256(first), true],
      [sha256(second), true],
    ]);
    // The second publication replaces the first's committed version, so it always backs that version up first.
    const backup = existing ? ['backup'] : [];
    expect(events).toEqual(['head', ...backup, 'put first', 'stored first', 'head', 'backup', 'put second', 'stored second']);
    expect(await stateOf(key)).toEqual(published(second));
  });

  it.each<[string, boolean, 'upsertFileObject' | 'put']>([
    ['the manifest upsert fails for a new key', false, 'upsertFileObject'],
    ['the manifest upsert fails over a published version', true, 'upsertFileObject'],
    ['the object put fails for a new key', false, 'put'],
    ['the object put fails over a published version', true, 'put'],
  ])('keeps the previous row and bytes, without a backup, when %s', async (_label, existing, failing) => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    const previous = Buffer.from('published version');
    if (existing) await store(deps(), request(fileId, previous));
    const failure = new Error(`${failing} failed`);
    const recorded = recordingStorage();
    const failingDeps =
      failing === 'put'
        ? deps({ storage: objectPut(() => Promise.reject(failure), recorded.storage) })
        : deps({ storage: recorded.storage, repository: { ...repository, files: { ...repository.files, upsertFileObject: () => Promise.reject(failure) } } });

    await expect(store(failingDeps, request(fileId, Buffer.from('replacement version')))).rejects.toBe(failure);
    expect(recorded.writes).toEqual(existing ? ['put backup', 'delete backup'] : []);
    expect(await stateOf(key)).toEqual(existing ? published(previous) : ABSENT);
    expect(await stagedFor(key)).toEqual([]);
  });

  it.each<[boolean, boolean, string[]]>([
    [false, false, ['put object', 'delete object']],
    [false, true, ['put object']],
    [true, false, ['put backup', 'put object', 'put object', 'delete backup']],
    [true, true, ['put backup', 'put object', 'delete backup']],
  ])('settles a failed COMMIT (previous version: %s, actually committed: %s) to the version that committed', async (existing, committed, writes) => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    const previous = Buffer.from('published plain-text version');
    const replacement = Buffer.from('replacement version');
    if (existing) await store(deps(), request(fileId, previous, 'text/plain'));
    const failure = new Error('connection lost at COMMIT');
    let calls = 0;
    const failingCommit: TenantDb = {
      ...db,
      withTenant: async (tenantId, fn) => {
        calls += 1;
        if (calls !== 3) return db.withTenant(tenantId, fn);
        await db.withTenant(tenantId, async (tx) => {
          await fn(tx);
          if (!committed) throw failure;
        });
        throw failure;
      },
    };
    const recorded = recordingStorage();

    await expect(store(deps({ db: failingCommit, storage: recorded.storage }), request(fileId, replacement))).rejects.toBe(failure);
    expect(recorded.writes).toEqual(writes);
    expect(await stateOf(key)).toEqual(committed ? published(replacement) : existing ? published(previous, 'text/plain') : ABSENT);
    expect(await stagedFor(key)).toEqual([]);
  });

  it.each([false, true])('recovers an ambiguous put after database loss (previous version: %s) to the recorded version without another transfer', async (existing) => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    const previous = Buffer.from('published version');
    const replacement = Buffer.from('replacement version');
    if (existing) await store(deps(), request(fileId, previous));
    const failure = new Error('storage response lost');
    let dead = false;
    const unavailable: TenantDb = {
      ...db,
      withTenant: (tenantId, fn) => dead ? Promise.reject(new Error('database unavailable')) : db.withTenant(tenantId, fn),
    };
    const ambiguous = objectPut(async (...args) => {
      await storage.put(...args);
      dead = true;
      throw failure;
    });

    await expect(store(deps({ db: unavailable, storage: ambiguous }), request(fileId, replacement))).rejects.toBe(failure);
    const staged = await stagedFor(key);
    expect(staged.map((entry) => entry.state)).toEqual(['staged']);
    expect(await stateOf(key)).toEqual({
      row: existing ? published(previous).row : null,
      head: published(replacement).head,
      bytes: replacement,
      backups: existing ? staged.map((entry) => entry.stage_id) : [],
    });
    await backdate(key);
    await expect(manifest()).rejects.toBeInstanceOf(StagedObjectsPendingError);
    const recorded = recordingStorage();
    expect(await recoverStagedObjects(deps({ storage: recorded.storage }), TENANT_A.tenantId, 0)).toBe(1);
    expect(recorded.writes).toEqual(existing ? ['put object', 'delete backup'] : ['delete object']);
    expect(await stagedFor(key)).toEqual([]);
    expect(await stateOf(key)).toEqual(existing ? published(previous) : ABSENT);
    expect(await listed(key)).toEqual(existing ? [manifestOf(key, previous)] : []);
  });

  it.each([false, true])('restores the recorded state after a put that replaced bytes then rejected (previous version: %s)', async (existing) => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    const previous = Buffer.from('old bytes');
    if (existing) await store(deps(), request(fileId, previous));
    const bytes = Buffer.from('ambiguous replacement');
    const failure = new Error('put acknowledgement lost');
    let lost = false;
    await expect(store(deps({ storage: objectPut(async (...args) => {
      const put = await storage.put(...args);
      if (lost) return put;
      lost = true;
      throw failure;
    }) }), request(fileId, bytes))).rejects.toBe(failure);
    expect(await stateOf(key)).toEqual(existing ? published(previous) : ABSENT);
    expect(await stagedFor(key)).toEqual([]);
  });

  it('keeps a committed replacement whose post-commit settle fails, leaving its backup to recovery', async () => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    await store(deps(), request(fileId, Buffer.from('published version')));
    const replacement = Buffer.from('committed replacement');
    let calls = 0;
    const settleLost: TenantDb = {
      ...db,
      withTenant: (tenantId, fn) => (++calls === 4 ? Promise.reject(new Error('database unavailable')) : db.withTenant(tenantId, fn)),
    };

    expect(await store(deps({ db: settleLost }), request(fileId, replacement))).toMatchObject({ sha256: sha256(replacement), created: true });
    const staged = await stagedFor(key);
    expect(staged.map((entry) => entry.state)).toEqual(['committed']);
    expect(await stateOf(key)).toEqual({ ...published(replacement), backups: staged.map((entry) => entry.stage_id) });
    await backdate(key);
    await expect(manifest()).rejects.toBeInstanceOf(StagedObjectsPendingError);
    const recorded = recordingStorage();
    expect(await recoverStagedObjects(deps({ storage: recorded.storage }), TENANT_A.tenantId, 0)).toBe(1);
    expect(recorded.writes).toEqual(['delete backup']);
    expect(await stagedFor(key)).toEqual([]);
    expect(await stateOf(key)).toEqual(published(replacement));
    expect(await listed(key)).toEqual([manifestOf(key, replacement)]);
  });

  it('does not touch storage if the staged intent disappeared before its claim', async () => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    let calls = 0;
    const removed: TenantDb = { ...db, withTenant: async (tenantId, fn) => {
      if (++calls === 3) await db.withTenant(tenantId, (tx) => tx.query(`DELETE FROM ${handle.schema}.staged_object WHERE object_key = $1`, [key]));
      return db.withTenant(tenantId, fn);
    } };
    const recorded = recordingStorage();
    await expect(store(deps({ db: removed, storage: recorded.storage }), request(fileId, Buffer.from('never written')))).rejects.toBeInstanceOf(StagedObjectMissingError);
    expect(recorded.writes).toEqual([]);
    expect(await stateOf(key)).toEqual(ABSENT);
  });

  it('restores a replacement whose settle was lost on Fastify readiness, and returns 503 while bytes match neither row nor backup', async () => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    const previous = Buffer.from('previous startup bytes');
    await store(deps(), request(fileId, previous));
    let dead = false;
    const unavailable: TenantDb = {
      ...db,
      withTenant: (tenantId, fn) => dead ? Promise.reject(new Error('database unavailable')) : db.withTenant(tenantId, fn),
    };
    const lost = objectPut(async (...args) => {
      await storage.put(...args);
      dead = true;
      throw new Error('storage response lost');
    });
    await expect(store(deps({ db: unavailable, storage: lost }), request(fileId, Buffer.from('interrupted startup replacement')))).rejects.toThrow(
      'storage response lost',
    );
    await backdate(key);
    await expect(manifest()).rejects.toBeInstanceOf(StagedObjectsPendingError);
    await writeTestSecrets(stateDir);
    const app = await createService({
      name: SERVICE, version: '1.0.0', pool: db, verifierOverride: testVerifier(SERVICE),
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
      env: loadEnv(undefined, {
        PORT: '8114', OPT2_SERVICE_NAME: SERVICE, OPT2_ENV: 'local', OPT2_STATE_DIR: stateDir,
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks', OPT2_TOKEN_ISSUER: 'opt2-local-identity', OPT2_TOKEN_AUDIENCE: 'opt2-local', TZ: 'UTC',
      }),
    });
    registerMigrationObjectRoutes(app, { domain: { db, repository }, storage, clock: fixedClock(NOW) });
    app.get('/manifest', { config: { opt2: { public: true } } }, () => manifest());
    try {
      await app.ready();
      expect(await stateOf(key)).toEqual(published(previous));
      expect(await stagedFor(key)).toEqual([]);
      expect((await app.inject('/manifest')).statusCode).toBe(200);

      const unknownId = nextFileId();
      const unknownKey = keyOf(unknownId);
      const recorded = Buffer.from('recorded bytes');
      await store(deps(), request(unknownId, recorded));
      const unknown = await intent(unknownId, Buffer.from('expected bytes'));
      await storage.put(CONTENT_FILES_BUCKET, unknownKey, Buffer.from('unrecognized bytes'), { contentType: PDF });
      await backdate(unknownKey);
      expect(await recoverStagedObjects(deps(), TENANT_A.tenantId, 0)).toBe(0);
      await expect(manifest()).rejects.toBeInstanceOf(StagedObjectsPendingError);
      expect((await app.inject('/manifest')).statusCode).toBe(503);
      // A later transfer of the recorded version repairs the key; the next pass then settles the intent.
      expect(await store(deps(), request(unknownId, recorded))).toMatchObject({ sha256: sha256(recorded), created: true });
      expect((await stagedFor(unknownKey)).map((entry) => entry.stage_id)).toEqual([unknown.stage_id]);
      expect(await recoverStagedObjects(deps(), TENANT_A.tenantId, 0)).toBe(1);
      expect(await stateOf(unknownKey)).toEqual(published(recorded));
      expect((await app.inject('/manifest')).statusCode).toBe(200);
    } finally {
      await app.opt2.shutdown();
    }
  });

  it.each(['migration', 'upload'] as const)('recovers after a real child-process crash in %s publication', async (mode) => {
    const fileId = nextFileId();
    const bytes = Buffer.from('durable bytes written just before exit');
    const previous = Buffer.from('committed before child');
    if (mode === 'migration') await store(deps(), request(fileId, previous));
    await ensureUnitGates(db, ['content.file']);
    await closeGates(db, { units: ['content.file'], holderId: 'crash-test', allowLegacy: true });
    await openGates(db, { units: ['content.file'], holderId: 'crash-test', state: 'open' });
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../helpers/object-publication-crash.ts', import.meta.url)),
      mode, handle.schema, handle.roles.app, stateDir, fileId, bytes.toString('base64')], { encoding: 'utf8', env: process.env, timeout: 30_000 });
    expect(child.status, child.stdout + child.stderr).toBe(86);
    const { key } = JSON.parse(child.stdout.trim()) as { key: string };
    expect(await storage.get(CONTENT_FILES_BUCKET, key)).toEqual(bytes);
    const staged = await stagedFor(key);
    expect(staged.map((entry) => entry.state)).toEqual(['staged']);
    expect(await backupsOf(tenantOf(key))).toEqual(mode === 'migration' ? staged.map((entry) => entry.stage_id) : []);
    await backdate(key);
    await expect(manifest(tenantOf(key))).rejects.toBeInstanceOf(StagedObjectsPendingError);
    expect(await recoverStagedObjects(deps(), tenantOf(key), 0)).toBe(1);
    expect(await stateOf(key)).toEqual(mode === 'migration' ? published(previous) : ABSENT);
    expect(await stagedFor(key)).toEqual([]);
    expect(await listed(key)).toEqual(mode === 'migration' ? [manifestOf(key, previous)] : []);
  });

  it('skips a live key lock and locked ledger rows, then settles them after release', async () => {
    const fileId = nextFileId();
    const staged = await intent(fileId, Buffer.from('not yet published'));
    await backdate(staged.object_key);
    await db.withTenant(TENANT_A.tenantId, async (tx) => {
      await repository.files.lockFileObjectKey(tx, staged.object_key);
      expect(await recoverStagedObjects(deps(), TENANT_A.tenantId, 0)).toBe(0);
    });
    await db.withTenant(TENANT_A.tenantId, async (tx) => {
      await tx.query(`SELECT 1 FROM ${handle.schema}.staged_object WHERE stage_id = $1 FOR UPDATE`, [staged.stage_id]);
      expect(await recoverStagedObjects(deps(), TENANT_A.tenantId, 0)).toBe(0);
    });
    expect(await recoverStagedObjects(deps(), TENANT_A.tenantId, 0)).toBe(1);
  });

  it('pages past unresolved entries, isolates tenants, and never logs ledger writes', async () => {
    const blockedId = nextFileId();
    const recorded = Buffer.from('recorded');
    await store(deps(), request(blockedId, recorded));
    const blocked = await intent(blockedId, Buffer.from('expected'));
    await storage.put(CONTENT_FILES_BUCKET, blocked.object_key, Buffer.from('unexpected'), { contentType: PDF });
    for (let i = 0; i < 101; i += 1) await intent(nextFileId(), Buffer.from('not published'));
    expect(await db.withTenant(TENANT_A.tenantId, (tx) => hasStaleStagedObjects(tx, 60_000))).toBe(false);
    expect(await db.withTenant('00000000-0000-4000-8000-000000000001', async (tx) =>
      (await tx.query(`SELECT * FROM ${handle.schema}.staged_object`)).rows)).toEqual([]);
    expect(await recoverStagedObjects(deps(), TENANT_A.tenantId, 0)).toBe(101);
    expect(await stagedFor(blocked.object_key)).toHaveLength(1);
    await storage.put(CONTENT_FILES_BUCKET, blocked.object_key, recorded, { contentType: PDF });
    await settleStagedObject(deps(), blocked);
    expect(await stagedFor(blocked.object_key)).toEqual([]);
    expect(await db.withTenant(TENANT_A.tenantId, async (tx) =>
      (await tx.query(`SELECT 1 FROM ${handle.schema}.changelog WHERE "table" = 'staged_object'`)).rows)).toEqual([]);
  });

  it.each<[string, (key: string) => Promise<void>, boolean]>([
    ['its stored bytes still match the row', async () => undefined, false],
    [
      'its stored bytes differ from the row',
      async (key) => {
        await storage.put(CONTENT_FILES_BUCKET, key, Buffer.from('bytes of an interrupted publication'), { contentType: PDF });
      },
      true,
    ],
    ['its stored object is missing', (key) => storage.delete(CONTENT_FILES_BUCKET, key), true],
  ])('answers a repeated transfer of the same hash when %s', async (_label, disturb, rewritten) => {
    const fileId = nextFileId();
    const key = keyOf(fileId);
    const bytes = Buffer.from('published version');
    const first = await store(deps(), request(fileId, bytes));
    await disturb(key);
    const recorded = recordingStorage();

    expect(await store(deps({ storage: recorded.storage }), request(fileId, bytes))).toEqual({ ...first, created: rewritten });
    expect(recorded.writes).toEqual(rewritten ? ['put object'] : []);
    expect(await stateOf(key)).toEqual(published(bytes));
  });
});
