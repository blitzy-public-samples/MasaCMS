/** lookupGroupFavorites over a throwaway `identity` schema: char(35) matching, every registered tenant, request order, auth denials, the legacy 400s and the window read gate. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  loadOpenApiDocument,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createGroupFavoriteReads } from '../../src/domain/group-favorites.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { GROUP_FAVORITE, IDENTITY_UNITS } from '../../src/repo/tables.js';
import { registerGroupFavoriteRoutes } from '../../src/routes/internal-group-favorites.js';

const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;
const LOOKUP_URL = '/internal/v1/group-favorites:lookup';
const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const SHORT_MS = 300;

function id(n: number, prefix = 'E'): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const GROUP_A = id(1, 'D');
const GROUP_B = id(2, 'D');
const GROUP_ELSEWHERE = id(3, 'D');
const FAVORITE_A = id(1);
const FAVORITE_B = id(2);
const SHARED = id(3);
/** Stored under a tenant the registry does not hold. */
const UNREGISTERED = id(4);
/** Shorter than the char(35) column, which pads it. */
const SHORT = 'Fav-Short';
const MISSING = id(99);

// Unit and auth cases run without PostgreSQL; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: () => Promise.resolve(),
};

function groupInput(userid: string, siteid: string): GroupInput {
  return {
    userid, groupname: 'Favorites', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;

async function adminQuery(sql: string, params: unknown[] = []): Promise<void> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  const { schema } = handle;
  await withMetadata(handle.app, (tx) => tx.query(sql.replaceAll('$schema', schema), params));
}

async function registerSite(site: string): Promise<void> {
  await adminQuery(
    'INSERT INTO $schema.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id, private_user_pool_tenant,' +
      ' public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $1, $2, $2, 1, $3)',
    [site, tenantIdForSite(site), CLOCK.now()],
  );
}

/** Stores group `groupId` of `site` with a favorite under each of `favoriteIds`. */
async function seedGroup(site: string, groupId: string, favoriteIds: readonly string[]): Promise<void> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  await withGatedTenant(handle.app, tenantIdForSite(site), async (tx) => {
    await repo.insertGroup(tx, groupInput(groupId, site), null);
    for (const favoriteid of favoriteIds) {
      await repo.insert(tx, GROUP_FAVORITE.table, { favoriteid, userid: groupId, favorite: id(9, 'C'), type: 'Page', siteid: site, datecreated: CLOCK.now() });
    }
  });
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-group-favorites-'));
  await writeTestSecrets(stateDir);
  repo = createIdentityRepository({ clock: CLOCK });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await adminQuery("UPDATE $schema.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'");
    await registerSite('tenant-a');
    await registerSite('tenant-b');
    await seedGroup('tenant-a', GROUP_A, [FAVORITE_A, SHORT, SHARED]);
    await seedGroup('tenant-b', GROUP_B, [FAVORITE_B, SHARED]);
    await seedGroup('unregistered', GROUP_ELSEWHERE, [UNREGISTERED]);
  }
  app = await createService({
    name: 'identity',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: 'identity',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('identity'),
    logger: createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerGroupFavoriteRoutes(app, { db: handle?.app ?? NO_DB, groupFavorites: createGroupFavoriteReads({ repo, gateWaitMs: SHORT_MS }) });
  await app.ready();
});

afterAll(async () => {
  await app.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

/** Headers of a `caller` invocation credential, beside a tenant-a user token when `withUser`; no caller sends the user token alone. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-visitor', site: 'tenant-a', roles: [Roles.systemUser] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}`;
  return headers;
}

/** Posts `payload` to lookupGroupFavorites and checks the answer against the contract. */
async function lookup(headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: LOOKUP_URL,
    headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_URL, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

describe('auth and request shape', () => {
  it('refuses callers other than people with 403 and a user token without an invocation credential with 401', async () => {
    for (const caller of ['gateway', 'strategies-content', 'identity']) {
      expect((await lookup(await headersFor(caller), { favoriteIds: [MISSING] })).statusCode).toBe(403);
      expect((await lookup(await headersFor(caller, true), { favoriteIds: [MISSING] })).statusCode).toBe(403);
    }
    expect((await lookup(await headersFor(null, true), { favoriteIds: [MISSING] })).statusCode).toBe(401);
    expect((await lookup(await headersFor(null), { favoriteIds: [MISSING] })).statusCode).toBe(401);
  });

  it.each<[string, unknown]>([
    ['no body', undefined],
    ['no favoriteIds', {}],
    ['an empty list', { favoriteIds: [] }],
    ['more than 100 ids', { favoriteIds: Array.from({ length: 101 }, (_, n) => id(n + 100)) }],
    ['a repeated id', { favoriteIds: [FAVORITE_A, FAVORITE_A] }],
    ['an empty id', { favoriteIds: [''] }],
    ['an id longer than char(35)', { favoriteIds: [`${FAVORITE_A} `] }],
    ['an id that is not a string', { favoriteIds: [{ id: FAVORITE_A }] }],
  ])('answers a body with %s with the legacy 400', async (_label, payload) => {
    const res = await lookup(await headersFor('people'), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });
});

describe.skipIf(!available)('reads against PostgreSQL', () => {
  beforeEach(async () => {
    await adminQuery("UPDATE $schema.unit_gate SET phase = 'quiet'");
  });

  it('matches stored ids ignoring case and trailing spaces, answering each as sent', async () => {
    const favoriteIds = [`${SHORT.toUpperCase()}  `, FAVORITE_A.toLowerCase(), SHORT];
    const res = await lookup(await headersFor('people'), { favoriteIds });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: favoriteIds.map((favoriteId) => ({ favoriteId })) });
  });

  it('finds favorites of every registered tenant once each, in request order, for people with or without a user token', async () => {
    const favoriteIds = [MISSING, SHARED, FAVORITE_B, UNREGISTERED, FAVORITE_A];
    const expected = { items: [SHARED, FAVORITE_B, FAVORITE_A].map((favoriteId) => ({ favoriteId })) };

    expect((await lookup(await headersFor('people'), { favoriteIds })).json()).toEqual(expected);
    expect((await lookup(await headersFor('people', true), { favoriteIds })).json()).toEqual(expected);
  });

  it('answers ids naming no favorite of a registered tenant, a NUL-bearing one included, with no items', async () => {
    const res = await lookup(await headersFor('people'), { favoriteIds: [MISSING, UNREGISTERED, GROUP_A, `${FAVORITE_A.slice(0, 34)}\u0000`] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('answers the legacy 503 while a window executes on identity.user_favorite past the gate wait', async () => {
    await adminQuery("UPDATE $schema.unit_gate SET phase = 'executing' WHERE unit = $1", [GROUP_FAVORITE.unit]);

    const res = await lookup(await headersFor('people'), { favoriteIds: [FAVORITE_A] });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { message: 'Unhandled Exception' } });
  });
});
