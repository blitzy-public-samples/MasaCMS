/** `lookupFileExtensions` over a throwaway `content` schema: pool reach, id matching, auth denials, body validation and window read gates. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { GATE_WAIT_MS, closeGates, ensureUnitGates, openGates, setGatePhase, type GatePhase } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, tenantRegistryConsumer, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { registerFileLookupRoutes } from '../../src/routes/internal-file-lookup.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const SERVICE = 'strategies-content';
const LOOKUP_URL = '/internal/v1/files:lookup';
const FILE_UNIT = 'content.file';
/** A site whose public user pool is `umbrella` and whose private user pool keeps its own files. */
const SITE_C = 'tenant-c';
const TENANT_C = tenantIdForSite(SITE_C);
/** A site whose public user pool site the registry does not hold yet. */
const SITE_D = 'tenant-d';
const USER_ID = '7D3E1F20-4B5A-4C6D-8E9F0A1B2C3D4E5F';

const UMBRELLA_PHOTO = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const C_PHOTO = 'A1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D';
const NULL_EXT = 'A1B2C3D4-0003-4A5B-8C7D9E0F1A2B3C4D';
const B_FILE = 'A1B2C3D4-0004-4A5B-8C7D9E0F1A2B3C4D';
const A_FILE = 'A1B2C3D4-0005-4A5B-8C7D9E0F1A2B3C4D';
const MISSING = 'A1B2C3D4-0009-4A5B-8C7D9E0F1A2B3C4D';
const SHORT_ID = 'SHORT-PHOTO';

const FILES: ReadonlyArray<{ tenantId: string; siteId: string; fileId: string; fileExt: string | null }> = [
  { tenantId: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId, fileId: UMBRELLA_PHOTO, fileExt: 'jpg' },
  { tenantId: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId, fileId: NULL_EXT, fileExt: null },
  { tenantId: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId, fileId: SHORT_ID, fileExt: 'jpeg' },
  { tenantId: TENANT_C, siteId: SITE_C, fileId: C_PHOTO, fileExt: 'png' },
  { tenantId: TENANT_B.tenantId, siteId: TENANT_B.siteId, fileId: B_FILE, fileExt: 'gif' },
  { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, fileId: A_FILE, fileExt: 'jpg' },
];

let handle: ThrowawaySchema;
let stateDir: string;
let app: FastifyInstance;

/** User token of `site` with people's invocation credential, as people's service client sends them. */
async function peopleHeaders(site: string = SITE_C): Promise<Record<string, string>> {
  const [user, invocation] = await Promise.all([
    mintUserToken({ sub: USER_ID, site, roles: [Roles.systemUser] }),
    mintServiceToken({ caller: 'people', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** Posts `payload` to the lookup and checks the answer against the contract. */
async function lookup(headers: Record<string, string>, payload: string | Record<string, unknown>, url: string = LOOKUP_URL) {
  const res = await app.inject({ method: 'POST', url, headers, payload });
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'POST',
    path: LOOKUP_URL,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!(await pgAvailable()))('lookupFileExtensions', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await seedRegistry(handle.app);
    for (const payload of [
      { siteId: SITE_C, publicUserPoolId: TENANT_UMBRELLA.siteId, privateUserPoolId: SITE_C, filePoolId: SITE_C },
      { siteId: SITE_D, publicUserPoolId: 'unregistered-pool', privateUserPoolId: SITE_D, filePoolId: TENANT_UMBRELLA.siteId },
    ]) {
      const tenantId = tenantIdForSite(payload.siteId);
      await handle.app.withTenant(tenantId, (tx) => tenantRegistryConsumer.apply(tx, { tenantId, aggregateVersion: 1, payload }));
    }
    await ensureUnitGates(handle.app, [FILE_UNIT]);
    for (const file of FILES) {
      await handle.app.withTenant(file.tenantId, (tx) =>
        tx.query(`INSERT INTO ${handle.schema}.file (tenant_id, fileid, siteid, fileext) VALUES ($1, $2, $3, $4)`, [
          tx.tenantId,
          file.fileId,
          file.siteId,
          file.fileExt,
        ]),
      );
    }

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-file-lookup-'));
    await writeTestSecrets(stateDir);
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    await registerFileLookupRoutes(app, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares the contract operation', () => {
    const operation = OPENAPI.paths[LOOKUP_URL]?.post ?? {};
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/internal/v1/files'));
    expect(declared).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: operation['x-opt2-fastify-path'],
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
      }),
    ]);
  });

  it.each([
    [
      'reads the file pools of both user pools of the token site and merges them in listed order',
      SITE_C,
      [MISSING, C_PHOTO, B_FILE, UMBRELLA_PHOTO.toLowerCase(), UMBRELLA_PHOTO, NULL_EXT, A_FILE],
      [
        { fileId: C_PHOTO, fileExt: 'png' },
        { fileId: UMBRELLA_PHOTO.toLowerCase(), fileExt: 'jpg' },
        { fileId: UMBRELLA_PHOTO, fileExt: 'jpg' },
        { fileId: NULL_EXT, fileExt: null },
      ],
    ],
    [
      'reads the shared file pool of tenant-a, never its own tenant',
      TENANT_A.siteId,
      [UMBRELLA_PHOTO, A_FILE, C_PHOTO, B_FILE],
      [{ fileId: UMBRELLA_PHOTO, fileExt: 'jpg' }],
    ],
    ['reads only the unpooled tenant of tenant-b', TENANT_B.siteId, [B_FILE, UMBRELLA_PHOTO], [{ fileId: B_FILE, fileExt: 'gif' }]],
    [
      'skips a user pool whose site the registry does not hold yet',
      SITE_D,
      [C_PHOTO, UMBRELLA_PHOTO],
      [{ fileId: UMBRELLA_PHOTO, fileExt: 'jpg' }],
    ],
    ['answers no item for a token site the registry does not know', 'unregistered-site', [UMBRELLA_PHOTO, C_PHOTO], []],
  ])('%s', async (_label, site, fileIds, items) => {
    const res = await lookup(await peopleHeaders(site), { fileIds });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items });
  });

  it.each([
    ['a lower-case CF UUID', C_PHOTO.toLowerCase(), 'png'],
    ['a mixed-case CF UUID', `${C_PHOTO.slice(0, 9).toLowerCase()}${C_PHOTO.slice(9)}`, 'png'],
    ['a short id stored space-padded', SHORT_ID, 'jpeg'],
    ['a short id in another case with trailing spaces', `${SHORT_ID.toLowerCase()}   `, 'jpeg'],
  ])('matches %s as SQL Server compares char(35), echoing the id as listed', async (_label, fileId, fileExt) => {
    const res = await lookup(await peopleHeaders(), { fileIds: [fileId] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ fileId, fileExt }] });
  });

  it.each([
    ['no invocation credential', async () => ({ authorization: (await peopleHeaders()).authorization ?? '' }), LOOKUP_URL, 401],
    [
      'no user token',
      async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'people', audience: SERVICE })}` }),
      LOOKUP_URL,
      401,
    ],
    [
      'another service',
      async () => ({
        ...(await peopleHeaders()),
        [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'identity', audience: SERVICE })}`,
      }),
      LOOKUP_URL,
      403,
    ],
    [
      'the gateway',
      async () => ({
        ...(await peopleHeaders()),
        [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
      }),
      LOOKUP_URL,
      403,
    ],
    ['a siteid other than the token site', () => peopleHeaders(), `${LOOKUP_URL}?siteid=${TENANT_B.siteId}`, 403],
  ])('denies a call with %s', async (_label, headers, url, status) => {
    const res = await lookup(await headers(), { fileIds: [UMBRELLA_PHOTO] }, url);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each<[string, string | Record<string, unknown>]>([
    ['no fileIds', {}],
    ['an empty list', { fileIds: [] }],
    ['a repeated id', { fileIds: [UMBRELLA_PHOTO, UMBRELLA_PHOTO] }],
    ['an empty id', { fileIds: [''] }],
    ['an id over 35 characters', { fileIds: [`${UMBRELLA_PHOTO} `] }],
    ['a non-string id', { fileIds: [1] }],
    ['a string fileIds', { fileIds: UMBRELLA_PHOTO }],
    ['an unknown member', { fileIds: [UMBRELLA_PHOTO], siteId: SITE_C }],
    ['a non-JSON body', '{"fileIds":'],
  ])('rejects %s with the legacy 400', async (_label, payload) => {
    const headers = { ...(await peopleHeaders()), ...(typeof payload === 'string' ? { 'content-type': 'application/json' } : {}) };
    const res = await lookup(headers, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each<GatePhase>(['executing', 'importing', 'import-pending'])(
    'waits out a window %s phase on content.file for the gate budget, then answers the legacy 503',
    async (phase) => {
      const headers = await peopleHeaders();
      const holderId = `window-${randomUUID()}`;
      await closeGates(handle.app, { units: [FILE_UNIT], holderId, phase, allowLegacy: true });
      // Only Date is faked, so the gate's 30 s budget elapses in steps while its polls and the database run in real time.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const started = Date.now();
        let settled = false;
        const pending = lookup(headers, { fileIds: [UMBRELLA_PHOTO] }).finally(() => {
          settled = true;
        });
        while (!settled) {
          await sleep(25);
          vi.setSystemTime(Date.now() + 1_000);
        }
        const res = await pending;
        expect(res.statusCode).toBe(503);
        expect(Date.now() - started).toBeGreaterThanOrEqual(GATE_WAIT_MS);
      } finally {
        vi.useRealTimers();
        await openGates(handle.app, { units: [FILE_UNIT], holderId, state: 'legacy' });
      }
    },
  );

  it('answers once a window on content.file leaves its executing phase', async () => {
    const headers = await peopleHeaders();
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units: [FILE_UNIT], holderId, phase: 'executing', allowLegacy: true });
    try {
      const started = Date.now();
      const pending = lookup(headers, { fileIds: [UMBRELLA_PHOTO] });
      await sleep(300);
      await setGatePhase(handle.app, { units: [FILE_UNIT], holderId, phase: 'quiet' });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [{ fileId: UMBRELLA_PHOTO, fileExt: 'jpg' }] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    } finally {
      await openGates(handle.app, { units: [FILE_UNIT], holderId, state: 'legacy' });
    }
  });
});
