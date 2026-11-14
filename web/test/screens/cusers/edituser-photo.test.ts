// cUsers.editUser photo tools against cf_filetools (filetools.cfm:37) and fileManager.createHREFForImage's direct path.
import { readFileSync } from 'node:fs';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components as PeopleComponents } from '@/generated/clients/people';
import type { components as ProgramsSitesComponents } from '@/generated/clients/programs-sites';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { loadEditUser, renderEditUser } from '@/screens/cusers/edituser';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, siteRecordFor } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';

type PersonRecord = PeopleComponents['schemas']['PersonRecord'];
type UserEditData = PeopleComponents['schemas']['UserEditData'];
type ShellSite = ProgramsSitesComponents['schemas']['ShellSite'];

// The `cf_filetools` block of the legacy ACF 2023 server's user form for the seeded pooled person below, request site
// `default`, user site `pooltest` (file pool `poolfiles`), port 20680, context ''; its cacheID UUID masked.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/identity/cusers-edituser-photo-pooled-${name}.html`, import.meta.url), 'utf8');

const USER_ID = 'AAAAAAAA-1111-2222-3333444455556666';
const PHOTO_ID = 'BBBBBBBB-1111-2222-3333444455556666';
const CSRF = { token: 'TESTCSRFTOKEN0000000000000000000', expires: '260630150000000' };
const CACHE_ID = /cacheID=[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}"/g;
const BLOCK_START = '\n<div class="mura-control justify">';
const BLOCK_END = '\n</div>\n';

const USER_EDIT_ROUTE = routeKey('GET', 'people', '/v1/users/edit');
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const POOL_SITES_ROUTE = routeKey('GET', 'programs-sites', '/v1/sites/default/user-pool-sites');

/** The seeded person: a public user of `siteId` with a JPG photo. */
const person = (siteId: string): PersonRecord => ({
  UserID: USER_ID,
  Type: 2,
  SiteID: siteId,
  Fname: 'Pool',
  Lname: 'Member',
  Email: 'pool.member@example.com',
  subType: 'Default',
  isPublic: 1,
  InActive: 0,
  S2: 0,
  Subscribe: 0,
  photoFileID: PHOTO_ID,
  photoFileExt: 'jpg',
});

/** people's edit data of a stored person without addresses, groups or subtypes. */
const userEdit = (user: PersonRecord): UserEditData => ({
  user,
  isNew: false,
  tempIsPublic: 1,
  lockedSuper: false,
  blockedUntil: null,
  passwordExpired: false,
  addresses: [],
  privateGroups: [],
  publicGroups: [],
  groupIds: [],
  categoryIds: [],
  subTypes: [],
  extendedAttributes: {},
  sites: [],
  errors: {},
  retained: false,
});

/** The stored `pooltest` site: a copy of `default` with its own pools and file pool `poolfiles`. */
const poolSite = (overrides: Partial<ShellSite> = {}): ShellSite => ({
  ...siteRecordFor('pooltest'),
  Site: 'Pool Test',
  Domain: 'pooltest.example',
  filePoolID: 'poolfiles',
  isremote: 0,
  resourceDomain: null,
  remotecontext: null,
  ...overrides,
});

/** identity's pair for every requested context. */
function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({ context, [CSRF_FIELD_TOKEN]: CSRF.token, [CSRF_FIELD_EXPIRES]: CSRF.expires }));
  return { status: 200, body: { tokens } };
}

/** A gateway answering people's edit read, identity's tokens and, when given, programs-sites' user pool sites. */
function gatewayFor(user: PersonRecord, poolSites?: FakeReply): FakeGatewayClient {
  return fakeGatewayClient({
    [USER_EDIT_ROUTE]: { status: 200, body: userEdit(user) },
    [CSRF_ROUTE]: issueTokens,
    ...(poolSites === undefined ? {} : { [POOL_SITES_ROUTE]: poolSites }),
  });
}

// Built by hand: the registry's shell hooks import every circuit, and the view reads only req, gateway, csrf and rb.
/** The admin's `cUsers.editUser` ScreenContext for the seeded person over `gateway`. */
function contextFor(gateway: FakeGatewayClient): ScreenContext {
  return {
    req: adminS2Request({ circuit: 'cusers', item: 'edituser', rc: { userid: USER_ID, siteid: 'default', routeid: '' } }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

/** The rendered `cf_filetools` block, its cacheID masked once it is a CF UUID. */
async function photoTools(gateway: FakeGatewayClient): Promise<string> {
  const ctx = contextFor(gateway);
  const body = toString((await renderEditUser(ctx, await loadEditUser(ctx))).body);
  const start = body.indexOf(BLOCK_START);
  expect(start).toBeGreaterThanOrEqual(0);
  return body.slice(start, body.indexOf(BLOCK_END, start) + BLOCK_END.length).replace(CACHE_ID, 'cacheID=<uuid>"');
}

/** The programs-sites calls the gateway received. */
const programsSitesCalls = (gateway: FakeGatewayClient) =>
  gateway.calls.filter(({ service }) => service === 'programs-sites').map(({ method, path }) => `${method} ${path}`);

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  vi.stubEnv('MURA_PORT', '20680');
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
  restoreEnv();
});

describe('cusers.edituser photo tools', () => {
  it("addresses a photo of the request's site under its own file pool without asking programs-sites", async () => {
    const gateway = gatewayFor(person('default'));

    const block = await photoTools(gateway);

    expect(block).toContain(`<img id="assocImage" src="/sites/default/cache/file/${PHOTO_ID}_medium.jpg?cacheID=<uuid>" />`);
    expect(block).toContain(`&siteid=default&fileid=${PHOTO_ID}&`);
    expect(programsSitesCalls(gateway)).toEqual([]);
  });

  it.each<{ name: string; site: Partial<ShellSite> }>([
    { name: 'local', site: {} },
    { name: 'remote-domain', site: { isremote: 1, resourceDomain: 'cdn.pool.example' } },
    { name: 'remote-context', site: { isremote: 1, resourceDomain: '', remotecontext: '/rc' } },
  ])('renders a pooled photo as legacy does for a $name pool site', async ({ name, site }) => {
    const gateway = gatewayFor(person('pooltest'), { status: 200, body: { sites: [siteRecordFor('default'), poolSite(site)] } });

    expect(await photoTools(gateway)).toBe(legacy(name));
    expect(programsSitesCalls(gateway)).toEqual(['GET /v1/sites/default/user-pool-sites']);
  });

  it.each<{ name: string; reply: FakeReply; type: new (...args: never[]) => Error; fields: Record<string, unknown> }>([
    {
      name: 'serves no site of the photo',
      reply: { status: 200, body: { sites: [siteRecordFor('default')] } },
      type: LegacyServiceUnavailableError,
      fields: { surface: 'admin', reason: 'photo-site-unserved' },
    },
    {
      name: 'refuses the read',
      reply: { status: 403, body: { error: { code: 'invalid_request', message: 'Forbidden' } } },
      type: GatewayDenialError,
      fields: { service: 'programs-sites', operation: 'getUserPoolSites', status: 403 },
    },
  ])('fails closed when programs-sites $name', async ({ reply, type, fields }) => {
    const loaded = loadEditUser(contextFor(gatewayFor(person('pooltest'), reply)));

    await expect(loaded).rejects.toBeInstanceOf(type);
    await expect(loaded).rejects.toMatchObject(fields);
  });
});
