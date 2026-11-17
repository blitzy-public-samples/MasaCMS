/** cperm's crumbs read of `routes/v1/carch.ts` through `app.inject` over a throwaway `content` schema holding a stored Page history. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance, type FastifyRequest, type ServiceRequest } from '@opt2/platform/service-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type InjectResponse,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { CARCH_SITE_SETTINGS_REASON, CARCH_VERSION_PREVIEW_EXCEPTION, registerCarchRoutes } from '../../src/routes/v1/carch.js';
import { SITE_CONFIG_FLAGS_PATH, siteConfigFlagsAnswer } from '../helpers/app.js';

type Row = Record<string, unknown>;

const SERVICE = 'strategies-content';
const HOLDER = 'cperm-crumbs-test';
const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const OPENAPI = parse(readFileSync(fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const SITE = TENANT_A.siteId;
const USER = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const SITE_TREE = '00000000000000000000000000000000000';
const HOME = '00000000000000000000000000000000001';
const ROOT_PARENT = '00000000000000000000000000000000END';
const NODE = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const [HOME_HIST, NODE_HIST, OLDER_HIST] = [1, 2, 3].map((n) => `B1B2C3D4-000${n}-4A5B-8C7D9E0F1A2B3C4D`) as [string, string, string];
const CHAIN = 'F1B2C3D4-0011-4A5B-8C7D9E0F1A2B3C4D';
const EXEMPT = 'F1B2C3D4-0012-4A5B-8C7D9E0F1A2B3C4D';
const ADMIN_STATE_PATH = '/v1/sessions/current/admin-state';

/** A recorded answer of this suite's provider that web's cperm screen tests render from, parsed. */
const webFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../web/test/fixtures/strategies-content/${name}`, import.meta.url), 'utf8'));

/** A stored `content.content` version of tenant-a: a Default Page under the site root unless `fields` say otherwise. */
const version = (fields: Row): Row => ({
  siteid: SITE,
  moduleid: SITE_TREE,
  parentid: HOME,
  type: 'Page',
  subtype: 'Default',
  approved: 1,
  display: 1,
  restricted: 0,
  lastupdate: new Date(2026, 5, 1, 9, 0, 0, 0),
  ...fields,
});

describe.skipIf(!(await pgAvailable()))('cperm crumbs of a node whose stored history holds Page versions', () => {
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  const routeErrors: Error[] = [];
  const identityCalls: ServiceRequest[] = [];

  /** Inserts `rows` into `content.<table>` in the transaction tenant; each row names its own columns. */
  async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
    for (const row of rows) {
      const names = Object.keys(row);
      await tx.query(
        `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
        [tx.tenantId, ...Object.values(row)],
      );
    }
  }

  /** A tenant-a site Admin's GET of `url`, its answer held to the contract. */
  async function get(url: string): Promise<InjectResponse> {
    const headers = {
      authorization: `Bearer ${await mintUserToken({ sub: USER, site: SITE, roles: [Roles.systemUser, Roles.siteAdmin] })}`,
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
    };
    const res = await app.inject({ method: 'GET', url, headers });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, schemaName: 'content', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, state: 'open' });
    await seedRegistry(handle.app);
    await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      await insert(tx, 'content', [
        version({ contentid: HOME, contenthistid: HOME_HIST, parentid: ROOT_PARENT, path: HOME, title: 'Home', menutitle: 'Home', filename: '', active: 1 }),
        version({ contentid: NODE, contenthistid: OLDER_HIST, path: `${HOME},${NODE}`, subtype: 'Landing', title: 'About', menutitle: 'About', filename: 'about', active: 0 }),
        version({ contentid: NODE, contenthistid: NODE_HIST, path: `${HOME},${NODE}`, subtype: 'Landing', title: 'About Us', menutitle: 'About', filename: 'about', active: 1 }),
      ]);
      await insert(tx, 'approval_assignment', [{ assignmentid: 'F1B2C3D4-0021-4A5B-8C7D9E0F1A2B3C4D', siteid: SITE, contentid: NODE, chainid: CHAIN, exemptid: EXEMPT }]);
      await insert(tx, 'extend_subtype', [
        { subtypeid: 'F1B2C3D4-0031-4A5B-8C7D9E0F1A2B3C4D', siteid: SITE, basetable: 'tcontent', type: 'Page', subtype: 'Landing', isactive: 1, iconclass: 'icon-star' },
      ]);
    });

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
        TZ: process.env.TZ ?? 'UTC',
      }),
      clock: CLOCK,
      verifierOverride: testVerifier(SERVICE),
      pool: handle.app,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    app.addHook('onError', async (_request, _reply, error) => {
      routeErrors.push(error);
    });
    const ctx = {
      domain: { db: handle.app, repository: createContentRepository({ clock: CLOCK, schema: handle.schema }), clock: CLOCK, config: CONTENT_CONFIG_DEFAULTS },
      clock: CLOCK,
      actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Admin User'),
    } as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;
    await registerCarchRoutes(app, ctx);
    await app.ready();
    // identity's admin session store, which carch before() reads for the history screen, and programs-sites' site flags.
    const request = async (req: ServiceRequest) => {
      if (req.service === 'programs-sites' && req.method === 'POST' && req.path === SITE_CONFIG_FLAGS_PATH) return siteConfigFlagsAnswer()(req);
      identityCalls.push(req);
      if (req.service !== 'identity' || req.method !== 'GET' || req.path !== ADMIN_STATE_PATH) throw new Error(`unexpected call ${req.service} ${req.method} ${req.path}`);
      return { status: 200, headers: {}, body: {} };
    };
    Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  beforeEach(() => {
    routeErrors.length = 0;
    identityCalls.length = 0;
  });

  it('halts the history read of the stored Page versions with the legacy 503 naming its exceptions entry', async () => {
    const res = await get(`/v1/sites/${SITE}/content/${NODE}/history`);
    expect(res.statusCode, res.body).toBe(503);
    expect(routeErrors).toEqual([
      expect.objectContaining({ reason: CARCH_SITE_SETTINGS_REASON, message: expect.stringContaining(`(${CARCH_VERSION_PREVIEW_EXCEPTION})`) }),
    ]);
    expect({ status: res.statusCode, body: res.json() }).toEqual(webFixture('cperm-history-page-halted.json'));
  });

  it('answers the same node’s crumbs node first, its active row holding the title, chain assignment and icon class', async () => {
    const res = await get(`/v1/sites/${SITE}/content/${NODE}/crumbs`);
    expect(res.statusCode, res.body).toBe(200);
    const { rc } = res.json() as { rc: { siteid: string; contentid: string; crumbdata: Row[] } };
    expect([rc.siteid, rc.contentid]).toEqual([SITE, NODE]);
    expect(rc.crumbdata).toEqual([
      expect.objectContaining({
        contentid: NODE,
        contenthistid: NODE_HIST,
        type: 'Page',
        subtype: 'Landing',
        title: 'About Us',
        chainid: CHAIN,
        exemptid: EXEMPT,
        iconclass: 'mi-star',
        parentarray: [NODE, HOME],
      }),
      expect.objectContaining({ contentid: HOME, contenthistid: HOME_HIST, title: 'Home', chainid: null, exemptid: null, iconclass: 'mi-file' }),
    ]);
    expect(res.json()).toEqual(webFixture('cperm-crumbs-page.json'));
    expect([routeErrors, identityCalls]).toEqual([[], []]);
  });
});
