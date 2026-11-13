/** The members CSV over a throwaway `identity` schema: exact legacy bytes, S2 filtering, batch streaming with one photo lookup per batch, its failure answers and a client disconnect. */
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { MEMBER_BATCH_SIZE, type GroupDeps } from '../../src/domain/groups.js';
import { createIdentityEvents } from '../../src/events/publish.js';
import { createContentClient } from '../../src/legacy/content-client.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';
import { registerAdminGroupRoutes } from '../../src/routes/admin-groups.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as Parameters<typeof assertResponseMatchesOpenApi>[0];
const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0, 123));
const SITE = 'tenant-a';
const UMBRELLA = 'umbrella';
const ADMIN_USER = 'A0000000-0000-0000-0000000000000001';
const EDITOR_USER = 'A0000000-0000-0000-0000000000000002';
const STORED_PHOTO = 'F0000000-0000-0000-0000000000000001';
const BULK_MEMBERS = 2 * MEMBER_BATCH_SIZE + 1;
const UNAVAILABLE = { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } };
const HEADER =
  '"COMPANY","CONTACTFORM","CREATED","DESCRIPTION","EMAIL","FNAME","GROUPID","GROUPNAME","IMNAME","IMSERVICE","INACTIVE",' +
  '"INTERESTS","ISPUBLIC","JOBTITLE","KEEPPRIVATE","LASTLOGIN","LASTUPDATE","LASTUPDATEBY","LASTUPDATEBYID","LNAME",' +
  '"MOBILEPHONE","NOTES","PASSWORDCREATED","PERM","PHOTOFILEEXT","PHOTOFILEID","REMOTEID","S2","SITEID","SUBSCRIBE",' +
  '"SUBTYPE","TABLIST","TAGS","TYPE","USERID","USERNAME","WEBSITE"\n';

/** strategies-content's photo lookup: records each call's ids, stores only STORED_PHOTO as a jpg, answers 503 on call `failAt` once `hold` settles, and any other call once `gate` settles. */
const content = { lookups: [] as string[][], failAt: 0, hold: Promise.resolve(), gate: Promise.resolve() };
const CONTENT_SERVICE: ServiceClient = {
  request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    const { fileIds } = req.json as { fileIds: string[] };
    content.lookups.push(fileIds);
    if (content.lookups.length === content.failAt) return content.hold.then(() => ({ status: 503, headers: {}, body: UNAVAILABLE as T }));
    const items = fileIds.filter((fileId) => fileId === STORED_PHOTO).map((fileId) => ({ fileId, fileExt: 'jpg' }));
    return content.gate.then(() => ({ status: 200, headers: {}, body: { items } as T }));
  },
  close: () => Promise.resolve(),
};

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema;
let repo: IdentityRepository;
let sequence = 0;
const ids = { exact: '', full: '', zed: '', bulk: '', empty: '', closed: '' };
const bulkPhotos: string[] = [];

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}0000000-0000-0000-${String(sequence).padStart(16, '0')}`;
}

function gated<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withGatedTenant(handle.app, tenantIdForSite(SITE), fn);
}

function groupInput(groupname: string): GroupInput {
  return {
    groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

/** Exact: a fully projected user and an S2 user; Bulk: BULK_MEMBERS users with distinct photos; Empty; Closed: one user under an open account operation. */
async function seed(): Promise<void> {
  const { schema } = handle;
  for (const [site, publicPool] of [[SITE, UMBRELLA], [UMBRELLA, UMBRELLA]] as const) {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), site, publicPool, tenantIdForSite(site), tenantIdForSite(publicPool), CLOCK.now()],
      ),
    );
  }
  ids.full = nextId('E');
  ids.zed = nextId('E');
  await gated(async (tx) => {
    for (const name of ['exact', 'bulk', 'empty', 'closed'] as const) ids[name] = (await repo.insertGroup(tx, groupInput(name), null)).userid;
    await repo.insertAccount(tx, { userid: ids.full, username: 'ufull', type: 2, s2: 0, perm: 1, inactive: 0, ispublic: 0, siteid: SITE, remoteid: 'R-1', tablist: 'Basic,Advanced' });
    await repo.writeCredential(tx, ids.full, { password: 'hash', passwordcreated: new Date(2026, 0, 2, 3, 4, 5, 670) });
    await repo.touchLastLogin(tx, ids.full, new Date(2026, 5, 29, 8, 0, 0, 3));
    await repo.upsertPersonContact(tx, {
      user_id: ids.full, site_id: SITE, email: 'fay@example.com', fname: 'Fay', lname: 'Full', company: 'A, B', subtype: 'Default', aggregate_version: 1,
      jobtitle: 'Analyst', mobilephone: '555-0100', website: 'https://fay.example.test', contactform: 'cf', subscribe: 1, notes: 'n', description: 'd',
      interests: 'i', keepprivate: 1, photofileid: STORED_PHOTO, imname: 'im', imservice: 'AIM', tags: 't', created: new Date(2025, 11, 31, 23, 59, 59, 997),
      lastupdate: new Date(2026, 5, 30, 12, 0, 0, 120), lastupdateby: 'Ada Admin', lastupdatebyid: ADMIN_USER,
    });
    await repo.insertAccount(tx, { userid: ids.zed, username: 'uzed', type: 2, s2: 1, perm: 0, inactive: 0, ispublic: 0, siteid: SITE, remoteid: '', tablist: '' });
    await repo.upsertPersonContact(tx, { user_id: ids.zed, site_id: SITE, email: null, fname: null, lname: 'Zed', company: null, subtype: null, aggregate_version: 1 });
    for (const member of [ids.zed, ids.full]) await repo.addMembership(tx, member, ids.exact);
    for (let n = 0; n < BULK_MEMBERS; n += 1) {
      const userId = nextId('E');
      bulkPhotos.push(nextId('F'));
      await repo.insertAccount(tx, { userid: userId, username: `b${String(n)}`, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE, remoteid: '', tablist: '' });
      await repo.upsertPersonContact(tx, {
        user_id: userId, site_id: SITE, email: null, fname: null, lname: `m${String(n).padStart(4, '0')}`, company: null, subtype: null, aggregate_version: 1,
        photofileid: bulkPhotos[n] ?? null,
      });
      await repo.addMembership(tx, userId, ids.bulk);
    }
    const closedUser = nextId('E');
    await repo.insertAccount(tx, { userid: closedUser, username: 'uclosed', type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE, remoteid: '', tablist: '' });
    await repo.addMembership(tx, closedUser, ids.closed);
    await repo.insertAccountOperation(tx, { user_id: closedUser, kind: 'update', state: 'committed' });
  });
}

beforeAll(async () => {
  if (!available) return;
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-admin-groups-csv-'));
  await writeTestSecrets(stateDir);
  handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
  repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
  await ensureUnitGates(handle.app, IDENTITY_UNITS);
  await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
  await seed();
  const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
  app = await createService({
    name: 'identity',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8111', OPT2_SERVICE_NAME: 'identity', OPT2_ENV: 'local', OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks', OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local', OPT2_STATE_DIR: stateDir, TZ: 'UTC',
    }),
    verifierOverride: testVerifier('identity'),
    logger,
  });
  const db = handle.app;
  const groups: GroupDeps = {
    db,
    repo,
    events: createIdentityEvents(repo),
    clock: CLOCK,
    settings: { password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 }, hashAlgorithm: 'CFMX_COMPAT' },
    sleep: () => Promise.resolve(),
  };
  const csrf = { db, repo, bridge: { markUsed: () => Promise.resolve({ applied: true }) }, clock: CLOCK, sleep: () => Promise.resolve() };
  await registerAdminGroupRoutes(app, { groups, content: createContentClient(CONTENT_SERVICE), sessions: { db, repo, clock: CLOCK }, csrf });
  await app.ready();
});

afterAll(async () => {
  if (!available) return;
  await app.opt2.shutdown();
  await handle.drop();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  content.lookups.length = 0;
  content.failAt = 0;
  content.hold = Promise.resolve();
  content.gate = Promise.resolve();
});

/** Headers of a gateway-relayed call for a `tenant-a` S2 admin, or for a non-S2 editor holding both module grants. */
async function headersAs(caller: 'admin' | 'editor'): Promise<Record<string, string>> {
  const roles = caller === 'admin' ? [Roles.s2, Roles.systemUser] : [Roles.systemUser, 'm:008', 'm:000'];
  const sub = caller === 'admin' ? ADMIN_USER : EDITOR_USER;
  return {
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}`,
    authorization: `Bearer ${await mintUserToken({ sub, site: SITE, roles })}`,
  };
}

/** GETs a group's members CSV whole and checks the answer against the contract. */
async function download(groupId: string, caller: 'admin' | 'editor' = 'admin') {
  const url = `/v1/groups/${groupId}/members.csv`;
  const res = await app.inject({ method: 'GET', url, headers: await headersAs(caller) });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** GETs a group's members CSV as a stream, its body left unread. */
async function streamed(groupId: string) {
  return app.inject({ method: 'GET', url: `/v1/groups/${groupId}/members.csv`, headers: await headersAs('admin'), payloadAsStream: true });
}

/** Clients of the app role's pool checked out, as an open pager transaction holds one. */
function checkedOut(): number {
  return handle.appPool.totalCount - handle.appPool.idleCount;
}

/** Resolves once `done` holds, polling every 10 ms; false when `ms` pass first. */
async function settles(done: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) return false;
    await delay(10);
  }
  return true;
}

/** Reads a response stream to its end or error, keeping each chunk's text as it was written; `onFirst` runs after the first chunk. */
function readChunks(stream: NodeJS.ReadableStream, onFirst: () => void = () => undefined): Promise<{ chunks: string[]; error: unknown }> {
  const chunks: string[] = [];
  return new Promise((resolve) => {
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'));
      if (chunks.length === 1) onFirst();
    });
    stream.on('end', () => {
      resolve({ chunks, error: null });
    });
    stream.on('error', (error: unknown) => {
      resolve({ chunks, error });
    });
  });
}

describe.skipIf(!available)('members CSV against PostgreSQL', () => {
  it('writes the exact legacy bytes and headers, S2 members only for an S2 caller', async () => {
    const full = [
      '"A, B "', '"cf "', '"2025-12-31 23:59:59.997 "', '"d "', '"fay@example.com "', '"Fay "', `"${ids.full} "`, '" "', '"im "', '"AIM "', '0 ',
      '"i "', '0 ', '"Analyst "', '1 ', '"2026-06-29 08:00:00.003 "', '"2026-06-30 12:00:00.12 "', '"Ada Admin "', `"${ADMIN_USER} "`, '"Full "',
      '"555-0100 "', '"n "', '"2026-01-02 03:04:05.67 "', '1 ', '"jpg "', `"${STORED_PHOTO} "`, '"R-1 "', '0 ', '"tenant-a "', '1 ',
      '"Default "', '"Basic,Advanced "', '"t "', '2 ', `"${ids.full} "`, '"ufull "', '"https://fay.example.test "',
    ].join(',');
    const zed = [
      '" "', '" "', '" "', '" "', '" "', '" "', `"${ids.zed} "`, '" "', '" "', '" "', '0 ',
      '" "', '0 ', '" "', '" "', '" "', '" "', '" "', '" "', '"Zed "',
      '" "', '" "', '" "', '0 ', '" "', '" "', '" "', '1 ', '"tenant-a "', '" "',
      '" "', '" "', '" "', '2 ', `"${ids.zed} "`, '"uzed "', '" "',
    ].join(',');

    const asAdmin = await download(ids.exact, 'admin');
    const asEditor = await download(ids.exact, 'editor');

    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.headers).toMatchObject({ 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': 'attachment;filename=users.csv' });
    expect(asAdmin.body).toBe(`${HEADER}${full}\n${zed}\n`);
    expect(asEditor.body).toBe(`${HEADER}${full}\n`);
    expect(content.lookups).toEqual([[STORED_PHOTO], [STORED_PHOTO]]);
  });

  it('answers a group without members with the header line alone and no photo lookup', async () => {
    const res = await download(ids.empty);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(HEADER);
    expect(content.lookups).toEqual([]);
  });

  it('streams a group over MEMBER_BATCH_SIZE one batch per chunk, each with one photo lookup made only as the body is read', async () => {
    const res = await streamed(ids.bulk);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': 'attachment;filename=users.csv' });
    expect(res.headers['content-length']).toBeUndefined();
    await delay(100);
    const unread = content.lookups.length;

    const { chunks, error } = await readChunks(res.stream());

    expect(error).toBeNull();
    expect(unread).toBeGreaterThanOrEqual(1);
    expect(unread).toBeLessThan(3);
    expect(content.lookups).toEqual([bulkPhotos.slice(0, MEMBER_BATCH_SIZE), bulkPhotos.slice(MEMBER_BATCH_SIZE, 2 * MEMBER_BATCH_SIZE), bulkPhotos.slice(2 * MEMBER_BATCH_SIZE)]);
    expect(chunks.map((chunk) => chunk.split('\n').length - 1)).toEqual([MEMBER_BATCH_SIZE + 1, MEMBER_BATCH_SIZE, 1]);
    const lines = chunks.join('').split('\n');
    expect(lines[0]).toBe(HEADER.slice(0, -1));
    expect(lines.slice(1, -1).map((line) => /"(b\d+) "/.exec(line)?.[1])).toEqual(Array.from({ length: BULK_MEMBERS }, (_, n) => `b${String(n)}`));
    expect(lines.at(-1)).toBe('');
  });

  it("answers the legacy 503 before any CSV when an open account operation keeps a member closed, or the first batch's photo lookup fails", async () => {
    const closed = await download(ids.closed);
    content.failAt = 1;
    const lookupDown = await download(ids.bulk);

    for (const res of [closed, lookupDown]) {
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.json()).toEqual(UNAVAILABLE);
    }
    expect(content.lookups).toEqual([bulkPhotos.slice(0, MEMBER_BATCH_SIZE)]);
  });

  it("aborts the body after the batch already sent when a later batch's photo lookup fails", async () => {
    let release = (): void => undefined;
    content.hold = new Promise((resolve) => {
      release = resolve;
    });
    content.failAt = 2;
    const res = await streamed(ids.bulk);

    const { chunks, error } = await readChunks(res.stream(), release);

    expect(res.statusCode).toBe(200);
    expect(error).toBeInstanceOf(Error);
    expect(chunks.map((chunk) => chunk.split('\n').length - 1)).toEqual([MEMBER_BATCH_SIZE + 1]);
    expect(content.lookups).toHaveLength(2);
  });

  it('ends the pager transaction when the client disconnects before the body is first read', async () => {
    let open = (): void => undefined;
    content.gate = new Promise((resolve) => {
      open = resolve;
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const baseline = checkedOut();
    const accepted = once(app.server, 'connection') as Promise<[Socket]>;
    const client = http.get({ host: '127.0.0.1', port, path: `/v1/groups/${ids.bulk}/members.csv`, headers: await headersAs('admin') });
    client.on('error', () => undefined);
    const [socket] = await accepted;
    expect(await settles(() => content.lookups.length === 1)).toBe(true);
    const held = checkedOut();

    client.destroy();
    await once(socket, 'close');
    open();

    expect(held).toBe(baseline + 1);
    expect(await settles(() => checkedOut() === baseline)).toBe(true);
    expect(content.lookups).toHaveLength(1);
  });
});
