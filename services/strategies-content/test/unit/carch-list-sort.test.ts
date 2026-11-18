/** carch.list's in-view sort write (list.cfm:590-634) through `GET /v1/sites/{siteid}/content/tree` over a throwaway `content` schema. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { WRITE_POSITION_HEADER_LC, closeGates, openGates, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance, type FastifyRequest, type ServiceRequest } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, pgAvailable, testVerifier, type InjectResponse } from '@opt2/platform/testing';
import { sortSiteManagerLevel } from '../../src/domain/content-tree.js';
import { actorFromClaims } from '../../src/domain/context.js';
import type { VersionInput } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { rawSurfaceOf } from '../../src/routes/v1/raw.js';
import { registerCarchRoutes } from '../../src/routes/v1/carch.js';
import { DEPLOYMENT_SETTINGS, SITE_CONFIG_FLAGS_PATH, siteConfigFlagsAnswer, userHeaders } from '../helpers/app.js';
import { ADMIN, END, HOME, SITE_ID, SITE_TREE, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

type Json = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SERVICE = 'strategies-content';
const USER = cfId('U', 1);
const SITE_B = TENANT_B.siteId;
const TREE_PATH = `/v1/sites/${SITE_ID}/content/tree`;
const FOLDER = cfId('F', 1);
const ALPHA = cfId('C', 1);
const BRAVO = cfId('C', 2);
const CHARLIE = cfId('C', 3);
const CHILDREN = [ALPHA, BRAVO, CHARLIE] as const;
const IDS = [FOLDER, ...CHILDREN];

/** One stored version: content id, history id, active flag, title, orderno, sortBy, sortDirection. */
type Seed = readonly [contentId: string, histId: string, active: 0 | 1, title: string, orderno: number, sortBy: string | null, sortDirection: string | null];

/** tenant-a: the folder and its three children, each with an archived version that differs from the active one. */
const TENANT_A_SEED: readonly Seed[] = [
  [FOLDER, cfId('H', 1), 1, 'Folder', 1, 'orderno', 'asc'],
  [FOLDER, cfId('H', 2), 0, 'Folder', 1, 'title', 'desc'],
  [ALPHA, cfId('H', 11), 1, 'Alpha', 1, null, null],
  [ALPHA, cfId('H', 12), 0, 'Alpha', 7, null, null],
  [BRAVO, cfId('H', 21), 1, 'Bravo', 2, null, null],
  [BRAVO, cfId('H', 22), 0, 'Bravo', 8, null, null],
  [CHARLIE, cfId('H', 31), 1, 'Charlie', 3, null, null],
  [CHARLIE, cfId('H', 32), 0, 'Charlie', 9, null, null],
];
/** tenant-b holds the same content ids, which legacy's contentid-only updates would also reach. */
const TENANT_B_SEED: readonly Seed[] = [
  [FOLDER, cfId('H', 51), 1, 'Other Folder', 4, 'title', 'desc'],
  [ALPHA, cfId('H', 61), 1, 'Other Alpha', 5, null, null],
  [BRAVO, cfId('H', 71), 1, 'Other Bravo', 6, null, null],
  [CHARLIE, cfId('H', 81), 1, 'Other Charlie', 7, null, null],
];

/** A stored version's sort columns. */
interface SortColumns {
  contentid: string;
  contenthistid: string;
  orderno: number | null;
  sortby: string | null;
  sortdirection: string | null;
}

describe.skipIf(!(await pgAvailable()))('carch.list in-view sort', () => {
  let fx: ContentFixture;
  let ctx: ContentRouteContext;
  let app: FastifyInstance;
  let gateHolder = 0;

  /** Stores `seeds` in `tenantId` under `siteId`, through the repository. */
  const seed = (tenantId: string, siteId: string, seeds: readonly Seed[]): Promise<void> =>
    withGatedTenant(fx.handle.app, tenantId, async (tx) => {
      for (const [contentid, contenthistid, active, title, orderno, sortby, sortdirection] of seeds) {
        const parentid = contentid === HOME ? END : contentid === FOLDER ? HOME : FOLDER;
        const row: VersionInput = {
          contentid, contenthistid, siteid: siteId, moduleid: SITE_TREE, parentid, path: contentid === HOME ? HOME : `${HOME},${contentid}`,
          type: contentid === FOLDER ? 'Folder' : 'Page', subtype: 'Default', title, menutitle: title, active, approved: 1, display: 1, orderno, sortby, sortdirection,
        };
        await fx.repo.content.insertVersion(tx, row);
      }
    });

  /** The sort columns of every stored version of the seeded ids in `tenantId`, by history id. */
  const stored = (tenantId: string = TENANT_A.tenantId): Promise<SortColumns[]> =>
    fx.inTenant(
      async (tx) =>
        (
          await tx.query<SortColumns>(
            `SELECT contentid, contenthistid, orderno, sortby, sortdirection FROM ${fx.handle.schema}.content WHERE contentid = ANY($1::bpchar[]) ORDER BY contenthistid`,
            [IDS],
          )
        ).rows.map((row) => ({ ...row, contentid: row.contentid.trim(), contenthistid: row.contenthistid.trim() })),
      tenantId,
    );

  /** `before` with `changes` applied to the versions of each content id it names. */
  const changed = (before: readonly SortColumns[], changes: Readonly<Record<string, Partial<SortColumns>>>): SortColumns[] =>
    before.map((row) => ({ ...row, ...(changes[row.contentid] ?? {}) }));

  /** The changelog rows of tenant-a written by transaction `xid`. */
  const changelogOf = (xid: string): Promise<Json[]> =>
    fx.inTenant(
      async (tx) =>
        (
          await tx.query(
            `SELECT "table", op, columns, origin, actor_user_id, actor_service, request_id FROM ${fx.handle.schema}.changelog WHERE xid = $1::xid8 ORDER BY seq`,
            [xid],
          )
        ).rows as Json[],
    );

  /** The changelog row count of tenant-a. */
  const changelogCount = async (): Promise<number> =>
    fx.inTenant(async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${fx.handle.schema}.changelog`)).rows[0]?.n ?? 0));

  /** Sets every content unit gate to `state` through a fresh holder. */
  const setGates = async (state: 'open' | 'legacy'): Promise<void> => {
    const holderId = `carch-list-sort-${String((gateHolder += 1))}`;
    await closeGates(fx.handle.app, { units: CONTENT_UNITS, holderId, allowLegacy: true });
    await openGates(fx.handle.app, { units: CONTENT_UNITS, holderId, state });
  };

  /** The tree page's answer to `fields` for the level under the folder, checked against the contract unless it is the undeclared legacy 500. */
  const tree = async (fields: ReadonlyArray<readonly [string, string]>): Promise<InjectResponse> => {
    const query = new URLSearchParams([['topid', FOLDER], ['moduleid', SITE_TREE], ...fields].map(([name, value]): [string, string] => [name, value])).toString();
    const res = await app.inject({ method: 'GET', url: `${TREE_PATH}?${query}`, headers: await userHeaders({ sub: USER, site: SITE_ID, roles: [Roles.s2], s2: true }) });
    if (res.statusCode !== 500) {
      assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: TREE_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    }
    return res;
  };

  /** The `rc` of a 200 answer. */
  const rcOf = (res: InjectResponse): Json => {
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { rc: Json }).rc;
  };

  /** The Site Manager's sort form post, `orderid` repeated in the new order; an override replaces a field, null drops it. */
  const sortForm = (order: readonly string[], overrides: Readonly<Record<string, string | null>> = {}): Array<readonly [string, string]> => {
    const fields: Record<string, string | null> = {
      nextN: '20', sortBy: 'orderno', sortDirection: 'asc', saveSort: 'true', startrow: '1', orderperm: 'Editor', sorted: 'true', ...overrides,
    };
    const posted = Object.entries(fields).flatMap(([name, value]) => (value === null ? [] : [[name, value] as const]));
    return [...posted, ...order.map((id) => ['orderid', id] as const)];
  };

  beforeAll(async () => {
    fx = await createContentFixture('carch-list-sort-test');
    ctx = {
      domain: { db: fx.deps.db, repository: fx.deps.repository, clock: fx.deps.clock, config: fx.deps.config },
      clock: fx.deps.clock,
      legacySettings: DEPLOYMENT_SETTINGS,
      actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Admin User'),
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
    registerWritePositionHeader(app);
    await registerCarchRoutes(app, ctx);
    await app.ready();
    // identity's empty admin session and its writes, and programs-sites' seeded site flags; any other call fails.
    const request = async (req: ServiceRequest) => {
      if (req.service === 'programs-sites' && req.path === SITE_CONFIG_FLAGS_PATH) return siteConfigFlagsAnswer()(req);
      if (req.service === 'identity' && req.path === '/v1/sessions/current/admin-state') return { status: 200, headers: {}, body: {} };
      if (req.service === 'identity' && req.path === '/v1/sessions/current') return { status: 200, headers: {}, body: { user: { userID: USER } } };
      throw new Error(`unexpected call ${req.service} ${req.method} ${req.path}`);
    };
    Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await app?.close();
    await fx?.drop();
  });

  beforeEach(async () => {
    for (const tenantId of [TENANT_A.tenantId, TENANT_B.tenantId]) {
      await fx.inTenant((tx) => tx.query(`DELETE FROM ${fx.handle.schema}.content`), tenantId);
    }
    await seed(TENANT_A.tenantId, SITE_ID, [[HOME, cfId('H', 99), 1, 'Home', 1, 'orderno', 'asc'], ...TENANT_A_SEED]);
    await seed(TENANT_B.tenantId, SITE_B, TENANT_B_SEED);
  });

  it.each([
    ['nextN resets startrow to 1', {}, 1],
    ['without nextN, startrow 5', { nextN: '0', startrow: '5' }, 5],
  ] as const)(
    'renumbers every version of each orderid and stores the top sort in one changelogged transaction (%s)',
    async (_label, overrides, from) => {
      const before = await stored();
      const otherTenant = await stored(TENANT_B.tenantId);
      const res = await tree(sortForm([CHARLIE, ALPHA, BRAVO], overrides));
      const rc = rcOf(res);
      expect([rc.sortBy, rc.sortDirection]).toEqual(['orderno', 'asc']);
      expect(await stored()).toEqual(
        changed(before, {
          [FOLDER]: { sortby: 'orderno', sortdirection: 'asc' },
          [CHARLIE]: { orderno: from },
          [ALPHA]: { orderno: from + 1 },
          [BRAVO]: { orderno: from + 2 },
        }),
      );
      expect(await stored(TENANT_B.tenantId)).toEqual(otherTenant);
      const position = String(res.headers[WRITE_POSITION_HEADER_LC]);
      expect(position).toMatch(new RegExp(`^${SERVICE}=\\d+$`));
      const log = await changelogOf(position.slice(SERVICE.length + 1));
      // The archived folder version's sort changes; the active one already holds it. Every child version changes.
      expect(log.map((row) => [row.op, row.columns])).toEqual([
        ...Array.from({ length: 6 }, () => ['update', ['orderno']]),
        ['update', ['sortby', 'sortdirection']],
      ]);
      expect(new Set(log.map((row) => JSON.stringify([row.table, row.origin, row.actor_user_id, row.actor_service])))).toEqual(
        new Set([JSON.stringify(['content', 'target', USER, SERVICE])]),
      );
      expect(new Set(log.map((row) => row.request_id)).size).toBe(1);
      expect(log[0]?.request_id).toEqual(expect.any(String));
    },
  );

  it.each([
    ['no orderperm', null],
    ['orderperm Read', 'Read'],
    ['orderperm None', 'None'],
    ['orderperm Author while sortPermission is not author', 'author'],
  ] as const)('writes nothing and answers no write position for %s', async (_label, orderperm) => {
    const before = await stored();
    const logged = await changelogCount();
    const res = await tree(sortForm([CHARLIE, ALPHA, BRAVO], { orderperm }));
    rcOf(res);
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
    expect([await stored(), await changelogCount()]).toEqual([before, logged]);
  });

  it.each([
    ['author', 'author', true],
    ['AUTHOR', 'Author', true],
    ['editor', 'author', false],
  ] as const)('with configBean sortPermission %j, an orderperm %j sort writes: %s', async (sortPermission, orderperm, writes) => {
    const before = await stored();
    ctx.domain.config = { ...fx.deps.config, sortPermission };
    try {
      const res = await tree(sortForm([CHARLIE, ALPHA, BRAVO], { orderperm }));
      rcOf(res);
      expect(res.headers[WRITE_POSITION_HEADER_LC] !== undefined).toBe(writes);
    } finally {
      ctx.domain.config = fx.deps.config;
    }
    const sorted = changed(before, { [FOLDER]: { sortby: 'orderno', sortdirection: 'asc' }, [CHARLIE]: { orderno: 1 }, [ALPHA]: { orderno: 2 }, [BRAVO]: { orderno: 3 } });
    expect(await stored()).toEqual(writes ? sorted : before);
  });

  it.each([
    ['a sorted orderno sort as asc', [['sortBy', 'orderno'], ['sortDirection', 'desc'], ['sorted', 'true']], ['orderno', 'asc']],
    ['an unsorted orderno sort as posted', [['sortBy', 'orderno'], ['sortDirection', 'desc'], ['sorted', 'false']], ['orderno', 'desc']],
    ['a saveSort title sort as posted', [['sortBy', 'title'], ['sortDirection', 'desc']], ['title', 'desc']],
  ] as const)('stores and answers %s, numbering the posted orderid', async (_label, sort, [sortBy, sortDirection]) => {
    const before = await stored();
    const rc = rcOf(await tree([['saveSort', 'true'], ['orderperm', 'editor'], ['orderid', `${BRAVO},${ALPHA}`], ...sort]));
    expect([rc.sortBy, rc.sortDirection]).toEqual([sortBy, sortDirection]);
    expect(await stored()).toEqual(changed(before, { [FOLDER]: { sortby: sortBy, sortdirection: sortDirection }, [BRAVO]: { orderno: 1 }, [ALPHA]: { orderno: 2 } }));
  });

  it('numbers every version of the active children 1 to N in the stored sort when an orderno sort posts no orderid', async () => {
    await fx.inTenant((tx) =>
      tx.query(`UPDATE ${fx.handle.schema}.content SET sortby = 'title', sortdirection = 'desc' WHERE contentid = $1::bpchar AND active = 1`, [FOLDER]),
    );
    const before = await stored();
    const otherTenant = await stored(TENANT_B.tenantId);
    const rc = rcOf(await tree([['saveSort', 'true'], ['sortBy', 'orderno'], ['sortDirection', 'asc'], ['orderperm', 'editor']]));
    expect([rc.sortBy, rc.sortDirection]).toEqual(['orderno', 'asc']);
    expect(await stored()).toEqual(
      changed(before, {
        [FOLDER]: { sortby: 'orderno', sortdirection: 'asc' },
        [CHARLIE]: { orderno: 1 },
        [BRAVO]: { orderno: 2 },
        [ALPHA]: { orderno: 3 },
      }),
    );
    expect(await stored(TENANT_B.tenantId)).toEqual(otherTenant);
  });

  it('takes the stored top sort without saveSort and renumbers the children by it', async () => {
    const before = await stored();
    const rc = rcOf(await tree([['sortBy', 'title'], ['sortDirection', 'desc'], ['orderperm', 'editor']]));
    expect([rc.sortBy, rc.sortDirection]).toEqual(['orderno', 'asc']);
    // The stored orderno asc sort renumbers the children in their current order and rewrites the archived folder version.
    expect(await stored()).toEqual(changed(before, { [FOLDER]: { sortby: 'orderno', sortdirection: 'asc' }, [ALPHA]: { orderno: 1 }, [BRAVO]: { orderno: 2 }, [CHARLIE]: { orderno: 3 } }));
  });

  it.each([
    ['a sorted CFML cannot read as a boolean', { sorted: 'maybe' }],
    ['a non-numeric startrow beside an orderid', { nextN: '0', startrow: 'abc' }],
  ] as const)('fails with the legacy 500 for %s, writing nothing', async (_label, overrides) => {
    const before = await stored();
    const res = await tree(sortForm([CHARLIE, ALPHA], overrides));
    expect([res.statusCode, await stored()]).toEqual([500, before]);
  });

  it.each([
    ['an order number past int', { nextN: '0', startrow: '2147483647' }, { [CHARLIE]: { orderno: 2147483647 } }],
    ['a sortBy past its 50-character column', { sortBy: 'x'.repeat(51) }, { [CHARLIE]: { orderno: 1 }, [ALPHA]: { orderno: 2 }, [BRAVO]: { orderno: 3 } }],
  ] as const)('fails with the legacy 500 at %s, keeping the updates before it', async (_label, overrides, kept) => {
    const before = await stored();
    const res = await tree(sortForm([CHARLIE, ALPHA, BRAVO], overrides));
    expect([res.statusCode, await stored()]).toEqual([500, changed(before, kept)]);
  });

  it('stores a sort past its column by trailing spaces only cut to the column, as SQL Server does', async () => {
    const before = await stored();
    const sortBy = `title${' '.repeat(50)}`;
    const input = { siteId: SITE_ID, topId: FOLDER, sortBy, sortDirection: 'asc', sorted: false, orderIds: undefined, startRow: 1, storedSortBy: 'orderno', storedSortDirection: 'asc' };
    expect(await sortSiteManagerLevel(fx.deps, ADMIN, input)).toBe('asc');
    expect(await stored()).toEqual(changed(before, { [FOLDER]: { sortby: sortBy.slice(0, 50), sortdirection: 'asc' } }));
  });

  it('reads no startrow for an empty orderid list, storing only the top sort', async () => {
    const before = await stored();
    const rc = rcOf(await tree([['saveSort', 'true'], ['sortBy', 'title'], ['sortDirection', 'asc'], ['orderperm', 'editor'], ['orderid', ''], ['startrow', 'abc']]));
    expect([rc.sortBy, rc.sortDirection]).toEqual(['title', 'asc']);
    expect(await stored()).toEqual(changed(before, { [FOLDER]: { sortby: 'title', sortdirection: 'asc' } }));
  });

  it('answers the legacy-shaped 503 and writes nothing while legacy holds the content units', async () => {
    const before = await stored();
    await setGates('legacy');
    try {
      const res = await tree(sortForm([CHARLIE, ALPHA, BRAVO]));
      expect([res.statusCode, res.headers[WRITE_POSITION_HEADER_LC]]).toEqual([503, undefined]);
    } finally {
      await setGates('open');
    }
    expect(await stored()).toEqual(before);
  });
});
