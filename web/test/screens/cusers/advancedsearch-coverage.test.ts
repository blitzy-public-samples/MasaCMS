// cUsers.advancedSearch against cusers.cfc advancedSearch() and cusers/advancedsearch.cfm: the form and result tabs as
// the legacy server prints them, `rc.qs` in ACF's struct order, the stored criteria rows and the owner failures.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/people';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest, type AdvancedSearchParam } from '@/lib/request-context';
import {
  advancedSearchQueryString,
  advancedSearchScreen,
  loadAdvancedSearch,
  type UserExtendedAttribute,
} from '@/screens/cusers/advancedsearch';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, buildTestAdminRequest, editorRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

type AdvancedSearchPage = components['schemas']['AdvancedSearchPageV2'];

const SEARCH_ROUTE = routeKey('GET', 'people', '/v2/users/advanced-search');
const STORE_ROUTE = routeKey('POST', 'people', '/v2/users/advanced-search');

// The `mura-header` through the result tabs of the legacy ACF 2023 server's cUsers.advancedSearch for the admin, for
// the GET request targets below: one without criteria and 20 parameters, one storing two criteria.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/people/${name}.html`, import.meta.url), 'utf8');

const PARAMS_QUERY =
  'muraAction=cUsers.advancedSearch&siteid=default&ispublic=0&startrow=1&alpha=1&Bravo=2&charlie=3&delta=4&echo=5' +
  '&foxtrot=6&golf=7&hotel=8&india=9&juliet=10&kilo=11&lima=12&mike=13&Zed=z1&ZED=z2&zed=z3';
const CRITERIA_QUERY =
  'muraAction=cUsers.advancedSearch&siteid=default&ispublic=0&param=1,2&paramField1=tusers.lname%5Evarchar' +
  '&paramRelationship1=and&paramCondition1=Contains&paramCriteria1=Edi&paramField2=tusers.email%5Evarchar' +
  '&paramRelationship2=or&paramCondition2=Begins&paramCriteria2=qa&inActive=0';

/** `utility.getNextN` of `total` matches, 25 a page, from row 1. */
const nextn = (total: number): AdvancedSearchPage['nextn'] => ({
  totalrecords: total,
  recordsperpage: 25,
  numberofpages: Math.ceil(total / 25),
  currentpagenumber: 1,
  firstpage: 1,
  lastpage: Math.ceil(total / 25),
  next: 1,
  previous: 1,
  through: total,
  startrow: 1,
});

/** People's page of the oracle's two system users. */
const PAGE: AdvancedSearchPage = {
  items: [
    { UserID: '3BE10CC9-9421-80A7-719F9D4816FA78E5', Fname: 'Admin', Lname: 'User', Email: 'admin@example.com', isPublic: 0, S2: 1 },
    { UserID: '3BEC10FC-F5B5-5517-7E7F2072657EFB68', Fname: 'QA', Lname: 'Editor', Email: 'qa_editor@example.com', isPublic: 0, S2: 0 },
  ],
  nextn: nextn(2),
  listUnassignedUsers: [],
  criteria: { paramArray: [], inActive: '', paramCategories: '', paramGroups: '', membersOnly: 'false', visitorStatus: 'All' },
  groups: [],
};

const EMPTY_PAGE: AdvancedSearchPage = { ...PAGE, items: [], nextn: nextn(0) };

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** The admin's request built from the browser's GET `query`, as the gateway forwards it. */
async function getRequest(query: string, gateway: FakeGatewayClient): Promise<AdminRequest> {
  return buildTestAdminRequest({
    circuit: 'cusers',
    action: 'advancedsearch',
    query: Object.fromEntries(new URLSearchParams(query)),
    user: 'admin',
    gateway,
    headers: { [ORIGINAL_URL_HEADER]: `/admin/?${query}` },
  });
}

/** The S2 admin's `cUsers.advancedSearch` with `rc` posted and `session` laid over the defaults. */
const postedRequest = (rc: Readonly<Record<string, string>>, session: Parameters<typeof adminS2Request>[0] = {}): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item: 'advancedsearch', rc: { siteid: 'default', ...rc }, ...session });

/** The body the registered screen loads and renders for `ctx`. */
async function bodyOf(ctx: ScreenContext): Promise<string> {
  return toString((await advancedSearchScreen.render(ctx, await advancedSearchScreen.load!(ctx))).body);
}

/** `stored` criteria as the request context captures them into the session for `cUsers`. */
const storedSession = (stored: readonly AdvancedSearchParam[], paramCount = stored.length) => ({
  session: { paramArray: stored, paramCount, paramCircuit: 'cUsers' },
});

const CRITERIA: readonly AdvancedSearchParam[] = [
  { Field: 'tusers.lname^varchar', Relationship: 'and', Criteria: 'Edi', Condition: 'Contains' },
  { Field: 'tusers.email^varchar', Relationship: 'or', Criteria: 'qa', Condition: 'Begins' },
];

describe('cUsers.advancedSearch as the legacy server prints it', () => {
  it.each<[string, string, string, string]>([
    ['twenty parameters without criteria, rc.qs in struct order', PARAMS_QUERY, SEARCH_ROUTE, 'cusers-advancedsearch-form-tabs'],
    ['two criteria it stores, one row each with its selections', CRITERIA_QUERY, STORE_ROUTE, 'cusers-advancedsearch-stored-tabs'],
  ])('renders a GET with %s', async (_label, query, route, fixture) => {
    const gateway = fakeGatewayClient({ [route]: { status: 200, body: PAGE } });
    const ctx = makeScreenContext({ req: await getRequest(query, gateway), gateway });

    const body = await bodyOf(ctx);
    const start = body.indexOf('<div class="mura-header">');
    const end = body.indexOf('</ul>', body.indexOf('<ul class="mura-tab-links nav-tabs">')) + '</ul>'.length;

    expect(body.slice(start, end)).toBe(legacy(fixture));
    expect(gateway.calls.filter(({ service }) => service === 'people').map(({ method }) => method)).toEqual([
      route === STORE_ROUTE ? 'POST' : 'GET',
    ]);
  });
});

describe('cUsers.advancedSearch loading', () => {
  it("runs people's stored criteria with the paging and newsearch flag when the request stores none", async () => {
    const gateway = fakeGatewayClient({ [SEARCH_ROUTE]: { status: 200, body: EMPTY_PAGE } });
    const ctx = makeScreenContext({ req: postedRequest({ ispublic: '0', startrow: '26', recordsperpage: '10', newsearch: 'true' }), gateway });

    const data = await advancedSearchScreen.load!(ctx);

    expect(gateway.calls.filter(({ service }) => service === 'people')).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/v2/users/advanced-search',
        query: { siteid: 'default', ispublic: '0', startrow: '26', recordsperpage: '10', newsearch: 'true' },
      }),
    ]);
    expect(data.page).toEqual(EMPTY_PAGE);
    expect(data.extendedAttributes).toEqual([]);
  });

  it('lists the extended attributes of the site after the built-in fields', async () => {
    const attributes: UserExtendedAttribute[] = [
      { attributeID: 101, type: 2, subType: 'Default', attribute: 'shoeSize' },
      { attributeID: '102', type: '1', subType: 'Team', attribute: 'motto' },
    ];
    const loader = vi.fn(() => Promise.resolve(attributes));
    const gateway = fakeGatewayClient({ [SEARCH_ROUTE]: { status: 200, body: EMPTY_PAGE } });
    const ctx = makeScreenContext({ req: postedRequest({ ispublic: '0' }), gateway });

    const view = await advancedSearchScreen.render(ctx, await loadAdvancedSearch(ctx, loader));
    const body = toString(view.body);

    expect(loader).toHaveBeenCalledWith(ctx, 'default');
    expect(body).toContain(
      '<option value="tusers.tags^varchar">Tag</option>\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<option value="101^varchar">User/Default - shoeSize</option>' +
        '\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<option value="102^varchar">Group/Team - motto</option>',
    );
    expect(body).not.toContain("muraAction.value='cUsers.advancedSearchToCSV'");
    expect(view.ajax).toBeDefined();
  });

  it.each<[string, FakeReply, string, new (...args: never[]) => Error]>([
    ['refuses the stored search', { status: 403, body: { error: { code: 'forbidden', message: 'No' } } }, 'getAdvancedSearchV2', GatewayDenialError],
    ['is unavailable', { status: 503, body: '' }, 'getAdvancedSearchV2', GatewayUnavailableError],
  ])('fails when people %s', async (_label, reply, operation, type) => {
    const ctx = makeScreenContext({ req: postedRequest({ ispublic: '0' }), gateway: fakeGatewayClient({ [SEARCH_ROUTE]: reply }) });

    const loaded = advancedSearchScreen.load!(ctx);

    await expect(loaded).rejects.toBeInstanceOf(type);
    if (type === GatewayDenialError) await expect(loaded).rejects.toMatchObject({ service: 'people', operation, status: 403 });
  });

  it('reports a refused store as a denial of the store operation, without running the stored search', async () => {
    const gateway = fakeGatewayClient({ [STORE_ROUTE]: { status: 401, body: { error: { code: 'unauthorized', message: 'No' } } } });
    const req = postedRequest({ ispublic: '0', param: '1', paramField1: 'tusers.fname^varchar', paramCriteria1: 'A' });
    const ctx = makeScreenContext({ req, gateway });

    await expect(advancedSearchScreen.load!(ctx)).rejects.toMatchObject({ name: 'GatewayDenialError', operation: 'setAdvancedSearchV2', status: 401 });
    expect(gateway.calls.map(({ method }) => method)).toEqual(['POST']);
  });
});

describe('cUsers.advancedSearch criteria rows', () => {
  const search = (rc: Readonly<Record<string, string>>, stored: ReturnType<typeof storedSession>) =>
    makeScreenContext({
      req: postedRequest({ ispublic: '0', ...rc }, stored),
      gateway: fakeGatewayClient({ [SEARCH_ROUTE]: { status: 200, body: PAGE } }),
    });

  it.each<[string, Readonly<Record<string, string>>, ReturnType<typeof storedSession>]>([
    ['a new search', { newsearch: 'yes' }, storedSession(CRITERIA)],
    ['criteria another circuit stored', {}, { session: { paramArray: CRITERIA, paramCount: 2, paramCircuit: 'cArch' } }],
    ['no stored criteria', {}, storedSession([])],
  ])('shows the single blank row for %s', async (_label, rc, stored) => {
    const body = await bodyOf(search(rc, stored));

    expect(body).toContain('<select name="paramRelationship1" style="display:none;">');
    expect(body).not.toContain('paramField2');
    expect(body).not.toContain('value="Edi"');
  });

  it('shows one selected row per stored criterion, its criteria written unencoded', async () => {
    const stored = storedSession([CRITERIA[0]!, { ...CRITERIA[1]!, Criteria: 'a"b' }]);

    const body = await bodyOf(search({}, stored));

    expect(body).toContain('<input type="text" name="paramCriteria1" value="Edi">');
    expect(body).toContain('<input type="text" name="paramCriteria2" value="a"b">');
    expect(body).toContain('<option value="or" selected>\n\t\t\t\t\t\t\t\tOr\n\t\t\t\t\t\t\t</option>');
    expect(body).toContain('<option value="Begins" selected>');
  });

  it('fails as ACF does when session.paramCount exceeds the stored criteria', async () => {
    await expect(bodyOf(search({}, storedSession(CRITERIA, 3)))).rejects.toThrow(
      new RangeError('The element at position 3 of session.paramArray does not exist.'),
    );
  });

  it('fails as ACF does when rc.newSearch is no boolean', async () => {
    await expect(bodyOf(search({ newsearch: 'maybe' }, storedSession(CRITERIA)))).rejects.toThrow(TypeError);
  });
});

describe('cUsers.advancedSearch results and flags', () => {
  it.each<[string, string, string, boolean]>([
    ['yes', 'yes', 'Site Members', true],
    ['true', 'no', 'Site Members', true],
    ['false', 'false', 'System Users', false],
    ['no', 'true', 'System Users', false],
  ])('reads ispublic=%s and the session inActive=%s as CFML booleans', async (ispublic, inActive, title, members) => {
    const ctx = makeScreenContext({
      req: postedRequest({ ispublic }, { session: { inActive } }),
      gateway: fakeGatewayClient({ [SEARCH_ROUTE]: { status: 200, body: PAGE } }),
    });

    const body = await bodyOf(ctx);
    const active = /<li class="active">\n\t+<a href="[^"]*ispublic=(\d)"/.exec(body)?.[1];

    expect(body).toContain(`<h3 class="block-title">${title}</h3>`);
    expect(active).toBe(members ? '1' : '0');
    const inactive = /^(?:true|yes)$/.test(inActive) ? '1' : '0';
    expect(body).toContain(`<option value="${inactive}" selected>`);
    expect(body).toContain(`<option value="${inactive === '1' ? '0' : '1'}" >`);
  });

  it('shows the bordered Site Members results without tabs to a caller who is not an admin', async () => {
    const gateway = fakeGatewayClient({ [SEARCH_ROUTE]: { status: 200, body: PAGE } });
    const req = editorRequest({ circuit: 'cusers', item: 'advancedsearch', rc: { siteid: 'default', ispublic: '0' } });
    const ctx = makeScreenContext({ req, gateway });

    const body = await bodyOf(ctx);

    expect(gateway.calls.find(({ service }) => service === 'people')?.query).toMatchObject({ ispublic: '1' });
    expect(body).toContain('<div class="block block-bordered">\n\t\t\t  <div class="block-content">\n\n\t\t      <h3>Site Members</h3>');
    expect(body).not.toContain('mura-tab-links');
    expect(body).toContain('<input type="hidden" name="ispublic" value="1">');
  });
});

describe('advancedSearchQueryString', () => {
  const source = (formScope: Readonly<Record<string, string>>, target: string | null, currentUrl = './?&muraAction=cusers.advancedsearch') => ({
    formScope,
    headers: new Headers(target === null ? {} : { [ORIGINAL_URL_HEADER]: target }),
    currentUrl,
  });

  // Each expected value is the legacy server's rc.qs for a GET carrying the same parameters; the order depends on the
  // names alone, so posted fields order alike.
  it.each<[string, ReturnType<typeof source>, string]>([
    [
      'posted fields, whatever the request target',
      source({ muraAction: 'cUsers.advancedSearch', siteid: 'default', ispublic: '0', b: '2', a: '1' }, '/admin/?x=9'),
      'a=1&b=2&siteid=default&',
    ],
    ['the request target without a query', source({}, '/admin/'), ''],
    [
      'the first value of a repeated target parameter, ISPUBLIC dropped in any case',
      source({}, '/admin/?muraAction=cUsers.advancedSearch&siteid=default&b=1&b=2&ISPUBLIC=1&a='),
      'a=&b=1&siteid=default&',
    ],
    [
      'the URL scope of rc.currentURL without the gateway header',
      source({}, null, './?muraAction=cUsers.advancedSearch&siteid=default&q=x'),
      'q=x&siteid=default&',
    ],
  ])('reads %s', (_label, req, qs) => {
    expect(advancedSearchQueryString(req)).toBe(qs);
  });
});
