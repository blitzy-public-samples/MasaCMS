/** The content admin circuits' gates, `secure()` denials, FW/1 redirects and CSRF wrapper of `routes/v1/access.ts`. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { actorFromClaims } from '../../src/domain/context.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import {
  ADMIN_LOGIN_REDIRECT_ACTION,
  ADMIN_NOACCESS_ACTION,
  AdminDenial,
  CIRCUIT_ROUTE_REQUIRES,
  FEED_MANAGER_FLAG_SOURCE,
  adminCsrf,
  adminDenial,
  adminRedirect,
  circuitRouteConfig,
  csrfRejected,
  requireCircuitAccess,
  type ContentAdminCircuit,
} from '../../src/routes/v1/access.js';
import { buildContentApp, serviceHeaders, userHeaders, type ContentTestApp } from '../helpers/app.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const CIRCUITS: readonly ContentAdminCircuit[] = ['carch', 'cchangesets', 'ccomments', 'ccategory', 'cfeed', 'cchain', 'cform', 'cnav'];
const SITE = 'default';
const USER = 'U0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const m = (digits: string): string => moduleRole(`00000000000000000000000000000000${digits}`);

/** Every `/v1/` operation the contract maps to an admin circuit, with that circuit. */
const circuitOperations = Object.entries(OPENAPI.paths)
  .filter(([path]) => path.startsWith('/v1/'))
  .flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ id: `${method.toUpperCase()} ${path}`, op })))
  .flatMap(({ id, op }) => {
    const actions = op['x-opt2-legacy-actions'] as readonly string[] | undefined;
    return actions === undefined ? [] : [{ id, op, circuit: (actions[0] ?? '').split('.')[0] as ContentAdminCircuit }];
  });

/** The verified actor, as the service's own `actorFor` builds it. */
const ctx = {
  actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Test User'),
} as Pick<ContentRouteContext, 'actorFor'> as ContentRouteContext;

describe('route declarations', () => {
  it('covers every contract circuit operation', () => {
    expect(circuitOperations.length).toBeGreaterThan(100);
    expect(new Set(circuitOperations.map(({ circuit }) => circuit))).toEqual(new Set(CIRCUITS));
  });

  it.each(circuitOperations)('$id declares what the contract lists', ({ op, circuit }) => {
    const { opt2 } = circuitRouteConfig(circuit);
    if (op['x-opt2-public'] === true) {
      expect(opt2).toEqual({ public: true, transport: 'service' });
      return;
    }
    expect(opt2).toEqual({ requires: op['x-opt2-requires'], transport: op['x-opt2-transport'] });
    expect(CIRCUIT_ROUTE_REQUIRES[circuit as Exclude<ContentAdminCircuit, 'cnav'>]).toEqual(op['x-opt2-requires']);
  });

  it('hands each route its own copy of the frozen requires list', () => {
    expect(Object.isFrozen(CIRCUIT_ROUTE_REQUIRES.cchain)).toBe(true);
    expect(circuitRouteConfig('cchain').opt2.requires).not.toBe(CIRCUIT_ROUTE_REQUIRES.cchain);
  });

  it('re-exports the application gate actions and records the unverified feed-manager flag', () => {
    expect([ADMIN_LOGIN_REDIRECT_ACTION, ADMIN_NOACCESS_ACTION]).toEqual(['clogin.logout', 'cMessage.noaccess']);
    expect(FEED_MANAGER_FLAG_SOURCE).toBe('unavailable');
  });
});

describe('adminRedirect', () => {
  it.each([
    {
      name: 'appends listed keys in order, spelled as listed',
      action: 'cChangesets.edit',
      rc: { siteID: 'default', changesetID: 'X' },
      append: ['changesetID', 'siteID'],
      expected: { circuit: 'cChangesets', action: 'edit', params: [['changesetID', 'X'], ['siteID', 'default']] },
    },
    {
      name: 'skips absent and complex values and renders simple ones as text',
      action: 'cArch.hist',
      rc: { contentid: 'C', siteid: 'a b', startrow: 2, moduleid: { id: 1 }, parentid: null, type: true },
      append: ['contentid', 'siteid', 'startrow', 'moduleid', 'parentid', 'type'],
      expected: { circuit: 'cArch', action: 'hist', params: [['contentid', 'C'], ['siteid', 'a b'], ['startrow', '2'], ['type', 'true']] },
    },
    {
      name: 'finds keys ignoring case, as structKeyExists does',
      action: 'cchain.list',
      rc: { SITEID: 'default' },
      append: ['siteid'],
      expected: { circuit: 'cchain', action: 'list', params: [['siteid', 'default']] },
    },
    {
      name: 'appends nothing for an empty list',
      action: 'cComments.default',
      rc: { siteid: 'default' },
      append: [],
      expected: { circuit: 'cComments', action: 'default', params: [] },
    },
  ] as const)('$name', ({ action, rc, append, expected }) => {
    expect(adminRedirect(action, rc, append)).toEqual(expected);
  });
});

describe('circuit gates and denials', () => {
  let t: ContentTestApp;

  beforeAll(async () => {
    t = await buildContentApp({
      declare: (app: FastifyInstance) => {
        for (const circuit of CIRCUITS) {
          for (const siteCheck of [true, false]) {
            app.get<{ Params: { siteid: string } }>(
              `/v1/sites/:siteid/gate-${siteCheck ? '' : 'nosite-'}${circuit}`,
              { config: { opt2: { ...circuitRouteConfig(circuit).opt2, siteCheck } } },
              async (request) => ({ userId: (await requireCircuitAccess(request, ctx, circuit, request.params.siteid)).userId }),
            );
          }
        }
        app.get('/v1/sites/:siteid/denial', { config: { opt2: { public: true } } }, async (request) => {
          const denial = adminDenial(request);
          return { isDenial: denial instanceof AdminDenial, status: denial.statusCode, redirect: denial.redirect };
        });
        app.post(
          '/v1/sites/:siteid/csrf',
          { config: circuitRouteConfig('cchain'), preHandler: adminCsrf((request) => String(legacyParamsOf(request).chainid)) },
          async (request) => ({ rejected: csrfRejected(request) }),
        );
      },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  const get = async (url: string, roles: readonly string[] | null, opts: { site?: string; referer?: string } = {}) => {
    const headers =
      roles === null ? await serviceHeaders('gateway') : await userHeaders({ sub: USER, site: opts.site ?? SITE, roles, s2: roles.includes(Roles.s2) });
    return t.app.inject({ method: 'GET', url, headers: { ...headers, ...(opts.referer === undefined ? {} : { referer: opts.referer }) } });
  };

  it.each([
    ['carch', [m('000')], 200],
    ['carch', [m('014')], 403],
    ['cchangesets', [m('014')], 403],
    ['cchangesets', [m('014'), m('000')], 200],
    ['cchangesets', [Roles.s2], 200],
    ['cchangesets', [Roles.siteAdmin], 200],
    ['ccomments', [m('015')], 403],
    ['ccomments', [m('015'), m('000')], 200],
    ['ccategory', [m('010')], 403],
    ['ccategory', [m('010'), m('000')], 200],
    ['cfeed', [m('011')], 403],
    ['cfeed', [m('011'), m('000')], 200],
    ['cfeed', [Roles.siteAdmin], 200],
    ['cform', [m('004')], 403],
    ['cform', [m('000')], 403],
    ['cform', [m('004'), m('000')], 200],
    ['cform', [Roles.s2], 200],
    ['cchain', [Roles.siteAdmin], 200],
    ['cchain', [m('000')], 403],
    ['cnav', [], 200],
  ] as const)('%s admits %j with %i', async (circuit, roles, status) => {
    const response = await get(`/v1/sites/${SITE}/gate-${circuit}`, roles);
    expect(response.statusCode, response.body).toBe(status);
  });

  it('answers an in-handler denial exactly as the route hook answers one', async () => {
    const inHandler = await get(`/v1/sites/${SITE}/gate-cchangesets`, [m('014')]);
    const hook = await get(`/v1/sites/${SITE}/gate-cchangesets`, [m('000')]);
    expect(inHandler.statusCode).toBe(403);
    expect([inHandler.statusCode, inHandler.headers['content-type'], inHandler.body]).toEqual([
      hook.statusCode,
      hook.headers['content-type'],
      hook.body,
    ]);
  });

  it('refuses anonymous callers on gated circuits and serves them on cnav', async () => {
    expect((await get(`/v1/sites/${SITE}/gate-carch`, null)).statusCode).toBe(401);
    const nav = await get(`/v1/sites/${SITE}/gate-cnav`, null);
    expect([nav.statusCode, nav.json()]).toEqual([200, { userId: '' }]);
  });

  it('denies a token of another site in the handler, comparing site ids ignoring case', async () => {
    const other = await get(`/v1/sites/${TENANT_A.siteId}/gate-nosite-carch`, [Roles.s2], { site: TENANT_B.siteId });
    expect(other.statusCode).toBe(403);
    const own = await get(`/v1/sites/${TENANT_B.siteId.toUpperCase()}/gate-nosite-carch`, [Roles.s2], { site: TENANT_B.siteId });
    expect(own.statusCode).toBe(200);
  });

  it.each([
    { name: 'anonymous with compactDisplay', roles: null, query: '?CompactDisplay=true', referer: undefined, status: 401, redirect: { kind: 'login', redirect: { circuit: 'cLogin', action: 'main', params: [['compactDisplay', 'true']] } } },
    { name: 'anonymous without compactDisplay', roles: null, query: '', referer: undefined, status: 401, redirect: { kind: 'login', redirect: { circuit: 'cLogin', action: 'main', params: [] } } },
    { name: 'logged in with a referrer', roles: [m('000')], query: '', referer: 'http://localhost/admin/?muraAction=cArch.list', status: 403, redirect: { kind: 'back', location: 'http://localhost/admin/?muraAction=cArch.list' } },
    { name: 'logged in without a referrer', roles: [m('000')], query: '', referer: undefined, status: 403, redirect: { kind: 'back', location: './' } },
  ] as const)('secure() for $name', async ({ roles, query, referer, status, redirect }) => {
    const response = await get(`/v1/sites/${SITE}/denial${query}`, roles, referer === undefined ? {} : { referer });
    expect(response.json()).toEqual({ isDenial: true, status, redirect });
  });

  it('records a refused CSRF token and still runs the handler', async () => {
    const headers = await userHeaders({ sub: USER, site: SITE, roles: [Roles.siteAdmin] });
    const response = await t.app.inject({ method: 'POST', url: `/v1/sites/${SITE}/csrf`, headers, payload: { chainid: 'C1' } });
    expect([response.statusCode, response.json()]).toEqual([200, { rejected: true }]);
  });
});
