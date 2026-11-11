// Tests of the admin-request helpers: the site the builder path seeds, and the session pool markers of each preset.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { ADMIN_LOGIN_REDIRECT_ACTION, ADMIN_NOACCESS_ACTION } from '@opt2/platform/legacy-compat';
import { applicationGate, type GateDecision } from '@/lib/access-gate';
import { resetLegacySettingsForTests } from '@/lib/env';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import {
  adminS2Session,
  noSitesSession,
  qaEditorSession,
  s2PrivateMemberSession,
  tenantASiteAdminSession,
} from '../fixtures/session';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  editorRequest,
  makeAdminRequest,
  noSitesRequest,
  opt2RoleRequest,
  siteAdminRequest,
  type AdminRequestPartial,
  type TestAdminRequestInput,
} from './admin-request';
import { useTestEnv } from './env';
import { fakeGatewayClient, type FakeGatewayClient } from './fake-gateway';
import type { WebTestSubjectKey } from './tokens';

type ScopeInput = Pick<TestAdminRequestInput, 'query' | 'form' | 'headers'>;
type Preset = (partial?: AdminRequestPartial) => AdminRequest;
type SessionFixture = { readonly s2IsPrivate: boolean; readonly mura: { readonly memberships: string } };

const NOACCESS: GateDecision = { kind: 'redirect', location: `/admin/?muraAction=${ADMIN_NOACCESS_ACTION}` };
const LOGOUT: GateDecision = { kind: 'redirect', location: `/admin/?muraAction=${ADMIN_LOGIN_REDIRECT_ACTION}` };
const ORIGINAL_LIST_URL = '/admin/?muraAction=carch.list&siteid=tenant-a';

const programsSitesPaths = (gateway: FakeGatewayClient): string[] =>
  gateway.calls.filter(({ service }) => service === 'programs-sites').map(({ path }) => path);

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('buildTestAdminRequest site seeding', () => {
  it.each<[string, ScopeInput, string, string[]]>([
    ['form over query', { query: { siteid: 'tenant-a' }, form: { siteid: 'default' } }, 'default', ['/v1/sites/default/shell']],
    ['an upper-case query name', { query: { SITEID: 'tenant-a' } }, 'tenant-a', []],
    ['a mixed-case form name', { form: { SiteID: 'tenant-a' } }, 'tenant-a', []],
    ['the original URL query', { headers: { [ORIGINAL_URL_HEADER]: ORIGINAL_LIST_URL } }, 'tenant-a', []],
    [
      'the original URL query over its path info',
      { headers: { [ORIGINAL_URL_HEADER]: '/admin/index.cfm/carch/list/siteid/default?siteid=tenant-a' } },
      'tenant-a',
      [],
    ],
    [
      'form over the original URL query',
      { headers: { [ORIGINAL_URL_HEADER]: ORIGINAL_LIST_URL }, form: { siteid: 'default' } },
      'default',
      ['/v1/sites/default/shell'],
    ],
  ])('seeds identity and programs-sites for the site of %s', async (_, scopes, siteId, siteReads) => {
    const gateway = fakeGatewayClient();
    const request = await buildTestAdminRequest({
      circuit: 'carch',
      action: 'list',
      user: 'admin',
      gateway,
      ...scopes,
    });
    expect(request.session.siteid).toBe(siteId);
    expect(request.rc['siteid']).toBe(siteId);
    expect(request.adminSites.map(({ siteID }) => siteID)).toEqual([siteId]);
    expect(programsSitesPaths(gateway)).toEqual(siteReads);
  });

  it('lays the site columns over the row of the site the merged context selects', async () => {
    const gateway = fakeGatewayClient();
    const request = await buildTestAdminRequest({
      circuit: 'carch',
      action: 'list',
      user: 'admin',
      gateway,
      query: { siteid: 'tenant-a' },
      form: { siteid: 'default' },
      site: { Site: 'Overridden' },
    });
    expect(request.site?.site).toBe('Overridden');
    expect(programsSitesPaths(gateway)).toEqual(['/v1/sites/default/shell']);
  });

  it("falls back to the subject's own site when the request names none", async () => {
    const request = await buildTestAdminRequest({ circuit: 'carch', action: 'list', user: 'siteAdmin' });
    expect(request.adminSites.map(({ siteID }) => siteID)).toEqual(['tenant-a']);
  });
});

describe('session pool markers', () => {
  const PRIVATE_DEFAULT = 'S2IsPrivate;default,S2IsPrivate';
  const PRIVATE_TENANT_A = 'S2IsPrivate;tenant-a,S2IsPrivate';
  const PUBLIC_TENANT_A = 'S2IsPublic;tenant-a,S2IsPublic';
  const publicOverride = { session: { mura: { memberships: noSitesSession.mura.memberships } } };

  it.each<[string, () => AdminRequest, string | undefined, boolean]>([
    ['the S2 admin', () => adminS2Request(), `${PRIVATE_DEFAULT},S2`, true],
    ['qa_editor', () => editorRequest(), PRIVATE_DEFAULT, true],
    ['the site admin', () => siteAdminRequest(), PRIVATE_TENANT_A, true],
    ['a synthetic role', () => opt2RoleRequest(Roles.timesheetsEmployee), PRIVATE_TENANT_A, true],
    ['a private user without sites', () => noSitesRequest({ s2IsPrivate: true }), PRIVATE_TENANT_A, true],
    ['a public member', () => makeAdminRequest({}, 'member'), PUBLIC_TENANT_A, false],
    ['a public user without sites', () => noSitesRequest({ s2IsPrivate: false }), PUBLIC_TENANT_A, false],
    ['an anonymous visitor', () => anonymousRequest(), undefined, false],
  ])('gives %s the loginByQuery markers', (_, request, memberships, s2IsPrivate) => {
    const { session } = request();
    expect(session.mura.memberships).toBe(memberships);
    expect(session.s2IsPrivate).toBe(s2IsPrivate);
  });

  it.each<[string, () => AdminRequest]>([
    ['makeAdminRequest', () => adminS2Request(publicOverride)],
    ['noSitesRequest', () => noSitesRequest({ s2IsPrivate: true }, publicOverride)],
  ])('keeps the memberships a caller of %s gives', (_, request) => {
    const { session } = request();
    expect(session.mura.memberships).toBe(noSitesSession.mura.memberships);
    expect(session.s2IsPrivate).toBe(false);
  });

  it('keeps noSitesRequest without administered sites', () => {
    const { session } = noSitesRequest({ s2IsPrivate: true }, { session: { siteArray: ['tenant-a'] } });
    expect(session.siteArray).toEqual([]);
  });

  it.each<[WebTestSubjectKey, string | undefined, boolean]>([
    ['admin', `${PRIVATE_DEFAULT},S2`, true],
    ['qaEditor', PRIVATE_DEFAULT, true],
    ['member', PUBLIC_TENANT_A, false],
    ['anonymous', undefined, false],
  ])('derives the %s preset flag through the real builder', async (user, memberships, s2IsPrivate) => {
    const { session } = await buildTestAdminRequest({ circuit: 'carch', action: 'list', user });
    expect(session.mura.memberships).toBe(memberships);
    expect(session.s2IsPrivate).toBe(s2IsPrivate);
    expect(session.s2IsPrivate).toBe(makeAdminRequest({}, user).session.s2IsPrivate);
  });

  it("derives the builder's flag from identity's memberships override", async () => {
    const { session } = await buildTestAdminRequest({
      circuit: 'carch',
      action: 'list',
      user: 'admin',
      sessionState: { mura: { memberships: noSitesSession.mura.memberships } },
    });
    expect(session.mura.memberships).toBe(noSitesSession.mura.memberships);
    expect(session.s2IsPrivate).toBe(false);
  });
});

describe('application gate over the pool markers', () => {
  const usersList = { circuit: 'cusers', item: 'list', session: { siteArray: [] } } as const;
  const PRIVATE = { s2IsPrivate: true } as const;
  const PUBLIC = { s2IsPrivate: false } as const;

  it.each<[string, SessionFixture, WebTestSubjectKey, Preset, GateDecision]>([
    ['qa_editor', qaEditorSession, 'qaEditor', editorRequest, NOACCESS],
    ['the S2 admin', adminS2Session, 'admin', adminS2Request, NOACCESS],
    ['the site admin', tenantASiteAdminSession, 'siteAdmin', (partial) => siteAdminRequest(undefined, partial), NOACCESS],
    ['a private member', s2PrivateMemberSession, 'systemUser', (partial) => noSitesRequest(PRIVATE, partial), NOACCESS],
    ['a public member', noSitesSession, 'member', (partial) => noSitesRequest(PUBLIC, partial), LOGOUT],
  ])('sends %s without sites where its legacy session struct is sent', (_, fixture, subject, preset, decision) => {
    const fromFixture = makeAdminRequest(
      { ...usersList, session: { ...usersList.session, mura: { memberships: fixture.mura.memberships } } },
      subject,
    );
    const fromPreset = preset(usersList);
    expect(fromFixture.session.s2IsPrivate).toBe(fixture.s2IsPrivate);
    expect(fromPreset.session.s2IsPrivate).toBe(fixture.s2IsPrivate);
    expect(applicationGate(fromPreset)).toEqual(decision);
    expect(applicationGate(fromFixture)).toEqual(decision);
  });
});
