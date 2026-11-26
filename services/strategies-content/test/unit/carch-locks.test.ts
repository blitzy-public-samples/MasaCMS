/** carch.lockFile, unlockFile and unlockNode through `/v1/raw/carch/<action>` over a throwaway `content` schema. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  createService,
  loadEnv,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { TENANT_A, pgAvailable, testVerifier } from '@opt2/platform/testing';
import { actorFromClaims } from '../../src/domain/context.js';
import type { VersionInput } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { rawSurfaceOf, registerRawRoutes } from '../../src/routes/v1/raw.js';
import { DEPLOYMENT_SETTINGS, userHeaders } from '../helpers/app.js';
import { END, HOME, SITE_ID, SITE_TREE, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const SERVICE = 'strategies-content';
const USER = cfId('U', 1);
const ITEM = cfId('C', 1);
const FILE_ID = cfId('F', 1);
const CSRF = { csrf_token: 'TOKEN', csrf_token_expires: '260630235959000' } as const;

/** The registry's stored spelling of tenant-a's site and two other spellings SQL Server's siteid match accepts. */
const SPELLINGS = [
  ['its stored spelling', SITE_ID],
  ['upper case', SITE_ID.toUpperCase()],
  ['mixed case', 'Tenant-A'],
] as const;

describe.skipIf(!(await pgAvailable()))('carch file and node locks', () => {
  let fx: ContentFixture;
  let app: FastifyInstance;
  const consumed: string[] = [];

  /** Posts raw `action` for the item as an S2 user whose token, like the query `siteid`, names `site`. */
  const post = async (action: 'lockfile' | 'unlockfile' | 'unlocknode', site: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/raw/carch/${action}?siteid=${site}`,
      headers: { ...(await userHeaders({ sub: USER, site, roles: [Roles.s2], s2: true })), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ contentid: ITEM, ...CSRF }).toString(),
    });

  /** tenant-a's `content.content_stats` rows. */
  const statsRows = async () =>
    (await fx.rows('content_stats', 'true', [], 'contentid, siteid')).map((row) => ({
      contentid: String(row.contentid).trim(),
      siteid: row.siteid,
      lockid: row.lockid,
      locktype: row.locktype,
    }));

  beforeAll(async () => {
    fx = await createContentFixture('carch-locks-test');
    const ctx = {
      domain: { db: fx.deps.db, repository: fx.deps.repository, clock: fx.deps.clock, config: fx.deps.config },
      clock: fx.deps.clock,
      legacySettings: DEPLOYMENT_SETTINGS,
      actorFor: (request: FastifyRequest) => Promise.resolve(actorFromClaims(request.opt2Auth.user, 'Admin User')),
    } as Pick<ContentRouteContext, 'domain' | 'clock' | 'legacySettings' | 'actorFor'> as ContentRouteContext;
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
      clock: fx.deps.clock,
      verifierOverride: testVerifier(SERVICE),
      surfaceOf: rawSurfaceOf,
      pool: fx.handle.app,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    await registerRawRoutes(app, ctx);
    await app.ready();
    // identity's empty admin session and a valid token for every consume; any other call fails.
    const request = (req: ServiceRequest): Promise<ServiceResponse> => {
      if (req.service === 'identity' && req.path === CSRF_CONSUME_PATH) {
        consumed.push((req.json as { context: string }).context);
        return Promise.resolve({ status: 200, headers: {}, body: { valid: true } });
      }
      if (req.service === 'identity' && req.path === '/v1/sessions/current/admin-state') return Promise.resolve({ status: 200, headers: {}, body: {} });
      return Promise.reject(new Error(`unexpected call ${req.service} ${req.method} ${req.path}`));
    };
    Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
    await withGatedTenant(fx.handle.app, TENANT_A.tenantId, async (tx) => {
      const version = (contentid: string, contenthistid: string, extra: Partial<VersionInput>): VersionInput => ({
        contentid, contenthistid, siteid: SITE_ID, moduleid: SITE_TREE, type: 'Page', subtype: 'Default', active: 1, approved: 1, display: 1, ...extra,
      });
      await fx.repo.content.insertVersion(tx, version(HOME, cfId('H', 1), { parentid: END, path: HOME, title: 'Home', menutitle: 'Home' }));
      await fx.repo.content.insertVersion(tx, version(ITEM, cfId('H', 2), { parentid: HOME, path: `${HOME},${ITEM}`, type: 'File', title: 'Report', menutitle: 'Report', fileid: FILE_ID }));
    });
  });

  afterAll(async () => {
    await app?.close();
    await fx?.drop();
  });

  beforeEach(async () => {
    consumed.length = 0;
    await fx.inTenant((tx) => tx.query(`DELETE FROM ${fx.handle.schema}.content_stats`));
  });

  it.each(SPELLINGS)('lockfile under the site in %s file-locks the stored item and redirects to its file', async (_label, site) => {
    const res = await post('lockfile', site);
    expect([res.statusCode, res.headers.location]).toEqual([302, `/index.cfm/_api/render/file/?fileid=${FILE_ID}&method=attachment`]);
    expect(consumed).toEqual([`${ITEM}lockfile`]);
    expect(await statsRows()).toEqual([{ contentid: ITEM, siteid: SITE_ID, lockid: USER, locktype: 'file' }]);
  });

  describe.each(['unlockfile', 'unlocknode'] as const)('%s', (action) => {
    it.each(SPELLINGS)('under the site in %s clears the stored item lock', async (_label, site) => {
      await withGatedTenant(fx.handle.app, TENANT_A.tenantId, (tx) =>
        fx.repo.stats.setLock(tx, { contentId: ITEM, siteId: SITE_ID, lockId: USER, lockType: 'node' }),
      );
      const res = await post(action, site);
      expect([res.statusCode, res.body]).toEqual([200, '']);
      expect(consumed).toEqual([`${ITEM}${action}`]);
      expect(await statsRows()).toEqual([{ contentid: ITEM, siteid: SITE_ID, lockid: null, locktype: null }]);
    });
  });
});
