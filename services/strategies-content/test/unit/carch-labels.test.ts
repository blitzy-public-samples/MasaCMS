/** routes/v1/carch resource-bundle labels: read asynchronously once per locale, site overrides over core, `en` as the fallback. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { IDENTITY_SERVICE, legacyParamsOf, sendLegacyResponse, type FastifyRequest, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { TENANT_A, type InjectResponse } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { carchRawActions, registerCarchRoutes } from '../../src/routes/v1/carch.js';
import { DEPLOYMENT_SETTINGS, SITE_CONFIG_FLAGS_PATH, TEST_CLOCK, buildContentApp, siteConfigFlagsAnswer, userHeaders, type ContentTestApp } from '../helpers/app.js';

/** The bundle-file I/O the mocked fs modules see: reads, synchronous calls and the file bodies a test substitutes. */
const bundleIo = vi.hoisted(() => ({
  /** `core:<rb>` or `override:<rb>` for a resource-bundle file path, else undefined. */
  labelOf(path: unknown): string | undefined {
    const match = /\/(core\/mura\/resourceBundle\/resources|resource_bundles)\/([^/]+)\.properties$/.exec(String(path));
    return match === null ? undefined : `${match[1] === 'resource_bundles' ? 'override' : 'core'}:${match[2] ?? ''}`;
  },
  reads: [] as string[],
  syncCalls: [] as string[],
  files: new Map<string, string | Error>(),
  gates: new Map<string, Promise<void>>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const traced: Record<string, unknown> = { ...actual };
  for (const name of ['existsSync', 'readFileSync', 'statSync', 'lstatSync', 'accessSync', 'openSync'] as const) {
    const original = actual[name] as (...args: unknown[]) => unknown;
    traced[name] = (...args: unknown[]): unknown => {
      if (bundleIo.labelOf(args[0]) !== undefined) bundleIo.syncCalls.push(`${name} ${String(args[0])}`);
      return original(...args);
    };
  }
  return { ...traced, default: traced };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (path: Parameters<typeof actual.readFile>[0], options?: Parameters<typeof actual.readFile>[1]) => {
    const label = bundleIo.labelOf(path);
    if (label !== undefined) {
      bundleIo.reads.push(label);
      await bundleIo.gates.get(label);
      const file = bundleIo.files.get(label);
      if (file instanceof Error) throw file;
      if (file !== undefined) return file;
    }
    return actual.readFile(path, options);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const SITE = TENANT_A.siteId;
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const DIFF_URL = `/v1/raw/carch/loaddiff?siteid=${SITE}&contenthistid1=B1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D&contenthistid2=B1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D`;
const NO_DIFFERENCE_KEY = 'sitemanager.content.codediffnodifference';
const EN_TEXT = 'There are no differences between the content versions';
const FR_TEXT = "Il n'y a aucune différence entre ces versions du contenu";

let t: ContentTestApp;
let ctx: ContentRouteContext;
const identity = { state: {} as Record<string, unknown>, sessionCalls: 0 };

/** identity's admin session store and session struct, and programs-sites' site flags; any other service call fails the test. */
function identityDouble<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
  const answer = (body: unknown): Promise<ServiceResponse<T>> => Promise.resolve({ status: 200, headers: {}, body: body as T });
  if (req.service === 'programs-sites' && req.method === 'POST' && req.path === SITE_CONFIG_FLAGS_PATH) return Promise.resolve(siteConfigFlagsAnswer()(req) as ServiceResponse<T>);
  if (req.service === IDENTITY_SERVICE && req.method === 'GET' && req.path === '/v1/sessions/current/admin-state') return answer(identity.state);
  if (req.service === IDENTITY_SERVICE && req.method === 'GET' && req.path === '/v1/sessions/current') {
    identity.sessionCalls += 1;
    return answer({ user: { userID: USER_ID, memberships: 'S2IsPrivate,S2' } });
  }
  return Promise.reject(new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`));
}

/** The empty version diff, labelled from the session's `rb` and `locale`. */
async function emptyDiff(rb: string, locale: string): Promise<InjectResponse> {
  identity.state = { rb, locale };
  return t.app.inject({ method: 'GET', url: DIFF_URL, headers: await userHeaders({ sub: USER_ID, site: SITE, roles: [Roles.s2] }) });
}

/** The bundle files read for locale `rb`, in a stable order. */
const readsOf = (rb: string): string[] => bundleIo.reads.filter((label) => label.endsWith(`:${rb}`)).sort();

/** A file-system error with the errno `code`. */
const fsError = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code });

beforeAll(async () => {
  t = await buildContentApp({
    declare: async (app) => {
      const db = app.opt2.db;
      if (db === undefined) throw new TypeError('the test app has no pool');
      ctx = {
        domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
        clock: TEST_CLOCK,
        legacySettings: DEPLOYMENT_SETTINGS,
        actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Admin User'),
      } as Pick<ContentRouteContext, 'domain' | 'clock' | 'legacySettings' | 'actorFor'> as ContentRouteContext;
      // ./raw.ts's flow for loaddiff: the gate on the request's siteid, then the entry.
      app.route({
        method: 'GET',
        url: '/v1/raw/carch/loaddiff',
        config: circuitRouteConfig('carch'),
        handler: async (request, reply) => {
          const actor = await requireCircuitAccess(request, ctx, 'carch', String(legacyParamsOf(request).siteid ?? ''));
          const out = await carchRawActions.loaddiff.run(request, ctx, actor);
          return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...out.headers }, body: out.body });
        },
      });
      await registerCarchRoutes(app, ctx);
    },
  });
  Object.defineProperty(t.app.opt2.client, 'request', { value: identityDouble, writable: true, configurable: true, enumerable: true });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.db.reset();
  identity.sessionCalls = 0;
  bundleIo.syncCalls.length = 0;
  bundleIo.files.clear();
  bundleIo.gates.clear();
});

describe('carch resource-bundle labels', () => {
  it('reads a locale once for concurrent first requests, without a synchronous fs call', async () => {
    let release = (): void => undefined;
    bundleIo.gates.set('core:fr', new Promise<void>((resolve) => (release = resolve)));
    const settled: string[] = [];
    const first = emptyDiff('fr', 'fr_FR').finally(() => settled.push('first'));
    const second = emptyDiff('fr', 'fr_FR').finally(() => settled.push('second'));
    await vi.waitFor(() => expect([identity.sessionCalls, readsOf('fr')]).toEqual([2, ['core:fr', 'override:fr']]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toEqual([]);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((res) => [res.statusCode, res.body])).toEqual([
      [200, FR_TEXT],
      [200, FR_TEXT],
    ]);
    expect([readsOf('fr'), readsOf('en')]).toEqual([
      ['core:fr', 'override:fr'],
      ['core:en', 'override:en'],
    ]);
    expect((await emptyDiff('fr', 'fr_FR')).body).toBe(FR_TEXT);
    expect(readsOf('fr')).toHaveLength(2);
    expect(bundleIo.syncCalls).toEqual([]);
  });

  it.each([
    ['the override key over the core key', 'xa', { core: `${NO_DIFFERENCE_KEY}=Core\n`, override: `${NO_DIFFERENCE_KEY}=Override\n` }, 'Override'],
    ['the core key without an override file', 'xb', { core: `${NO_DIFFERENCE_KEY}=Core\n` }, 'Core'],
    ['the override key without a core file', 'xc', { override: `${NO_DIFFERENCE_KEY}:Override` }, 'Override'],
    ['escapes and continuations decoded', 'xd', { core: `${NO_DIFFERENCE_KEY} = Diff\\u00e9rent \\\n    lines\\tend\n` }, 'Différent lines\tend'],
    ['the en text for a key neither file holds', 'xe', { core: 'other.key=Other\n', override: '# comment only\n' }, EN_TEXT],
    ['the en text for a locale without files', 'sv', {}, EN_TEXT],
    ['the en text for an ENOTDIR read', 'xf', { core: fsError('ENOTDIR') }, EN_TEXT],
    ['the en text for a session rb outside the locale pattern', '../xa', {}, EN_TEXT],
  ] as const)('labels the empty diff with %s', async (_name, rb, files: { core?: string | Error; override?: string | Error }, text) => {
    const name = /^[a-z]{2,3}$/.test(rb) ? rb : 'en';
    if (files.core !== undefined) bundleIo.files.set(`core:${name}`, files.core);
    if (files.override !== undefined) bundleIo.files.set(`override:${name}`, files.override);
    const res = await emptyDiff(rb, 'en_US');
    expect([res.statusCode, res.body]).toEqual([200, text]);
    expect(bundleIo.syncCalls).toEqual([]);
  });

  it('fails the request on an unreadable bundle and reads the files again on the next request', async () => {
    bundleIo.files.set('core:xg', fsError('EACCES'));
    const failed = await emptyDiff('xg', 'en_US');
    expect(failed.statusCode).toBe(500);
    bundleIo.files.set('core:xg', `${NO_DIFFERENCE_KEY}=Readable\n`);
    const retried = await emptyDiff('xg', 'en_US');
    expect([retried.statusCode, retried.body]).toEqual([200, 'Readable']);
    expect(readsOf('xg')).toEqual(['core:xg', 'core:xg', 'override:xg', 'override:xg']);
  });
});
