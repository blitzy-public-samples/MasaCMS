// cUsers.advancedSearch in the admin shell (cusers/advancedsearch.cfm, cusers.cfc advancedSearch(), the search capture of
// admin/Application.cfc 459-498) and the `request.ajax` script of cusers/inc/js.cfm.
import { Roles, moduleRole } from '@opt2/platform/auth';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_VERSION, legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest, AdvancedSearchParam } from '@/lib/request-context';
import {
  advancedSearchScreen,
  loadAdvancedSearch,
  renderAdvancedSearch,
  type UserExtendedAttribute,
} from '@/screens/cusers/advancedsearch';
import { renderUsersJs } from '@/screens/cusers/inc/js';
import {
  advancedSearchDefaultAnswer,
  advancedSearchLastNameAnswer,
  advancedSearchLastNameCriteria,
  advancedSearchTwoRowCriteria,
} from '../../fixtures/people/search';
import { emptyUsersPage } from '../../fixtures/people/user-list';
import {
  adminS2Request,
  buildTestAdminRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel, normaliseIds, type DomModel, type DomOption } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeRouteTable } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry pulls in every circuit's screens; the shell reads only its hooks, and cUsers has no secondary menu.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Ctx = ReturnType<typeof makeScreenContext>;
type Answer = typeof advancedSearchDefaultAnswer;
type Session = NonNullable<AdminRequestPartial['session']>;
type Entry = readonly [value: string, label: string];

const SITE = 'tenant-a';
const SITE_MODULE_ID = '00000000000000000000000000000000000';
const USERS_MODULE_ID = '00000000000000000000000000000000008';
const SEARCH_ROUTE = routeKey('GET', 'people', '/v2/users/advanced-search');
const STORE_ROUTE = routeKey('POST', 'people', '/v2/users/advanced-search');
const ADMIN_URL = '/admin/index.cfm?muraAction=';
const SEARCH_ACTION = { circuit: 'cusers', item: 'advancedsearch' } as const;

const RELATIONSHIPS: readonly Entry[] = [
  ['and', 'And'],
  ['or', 'Or'],
];

// advancedsearch.cfm options[1..15]; options[6] is `tusers.jobTitle^varchar` in the view.
const FIELDS: readonly Entry[] = [
  ['tusers.fname^varchar', 'First Name'],
  ['tusers.lname^varchar', 'Last Name'],
  ['tusers.username^varchar', 'Username'],
  ['tusers.email^varchar', 'Email'],
  ['tusers.company^varchar', 'Company'],
  ['tusers.jobTitle^varchar', 'Job Title'],
  ['tusers.website^varchar', 'Website'],
  ['tusers.mobilePhone^varchar', 'Mobile Phone'],
  ['tuseraddresses.address1^varchar', 'Street Address 1'],
  ['tuseraddresses.address2^varchar', 'Street Address 2'],
  ['tuseraddresses.city^varchar', 'City'],
  ['tuseraddresses.state^varchar', 'State'],
  ['tuseraddresses.Zip^varchar', 'Zip'],
  ['tusers.created^date', 'Created'],
  ['tusers.tags^varchar', 'Tag'],
];

const CONDITIONS: readonly Entry[] = [
  ['Equals', 'Equals'],
  ['GT', 'Greater Than'],
  ['GTE', 'Greater Than or Equal To'],
  ['LT', 'Less Than'],
  ['LTE', 'Less Than or Equal To'],
  ['NEQ', 'Not Equal To'],
  ['Begins', 'Begins With'],
  ['Contains', 'Contains'],
];

const SELECT_FIELD: Entry = ['', 'Select Field'];

const SEARCH_ONCLICK = "document.forms.form2.muraAction.value='cUsers.advancedSearch';submitForm(document.forms.form2);";
const DOWNLOAD_ONCLICK =
  "document.forms.form2.muraAction.value='cUsers.advancedSearchToCSV';submitForm(document.forms.form2);$('#action-modal').remove();";

const EMPTY_ANSWER: Answer = { ...advancedSearchDefaultAnswer, items: [], nextn: emptyUsersPage.nextn };

/** `entries` as DOM options, the one valued `selected` marked. */
const optionsOf = (entries: readonly Entry[], selected?: string): DomOption[] =>
  entries.map(([value, label]) => ({ value, label, selected: value === selected }));

/** The single blank criteria row of a new search over `fields`. */
const newSearchRow = (fields: readonly Entry[] = FIELDS) => [
  { tag: 'select', name: 'paramRelationship1', type: 'select-one', value: '', options: optionsOf(RELATIONSHIPS) },
  { tag: 'input', name: 'param', type: 'hidden', value: '1' },
  { tag: 'select', name: 'paramField1', type: 'select-one', value: '', options: optionsOf([SELECT_FIELD, ...fields]) },
  { tag: 'select', name: 'paramCondition1', type: 'select-one', value: '', options: optionsOf(CONDITIONS) },
  { tag: 'input', name: 'paramCriteria1', type: 'text', value: '' },
];

/** Criteria row `p` with the stored relationship, field and condition selected and its criteria filled. */
const storedRow = (p: number, { Field, Relationship, Criteria, Condition }: AdvancedSearchParam) => [
  {
    tag: 'select',
    name: `paramRelationship${p}`,
    type: 'select-one',
    value: Relationship,
    options: optionsOf(RELATIONSHIPS, Relationship),
  },
  { tag: 'input', name: 'param', type: 'hidden', value: String(p) },
  {
    tag: 'select',
    name: `paramField${p}`,
    type: 'select-one',
    value: Field,
    options: optionsOf([SELECT_FIELD, ...FIELDS], Field),
  },
  { tag: 'select', name: `paramCondition${p}`, type: 'select-one', value: Condition, options: optionsOf(CONDITIONS, Condition) },
  { tag: 'input', name: `paramCriteria${p}`, type: 'text', value: Criteria },
];

/** The S2 admin on `default` system users, `rc` and `session` laid over. */
const adminSearch = (rc: Readonly<Record<string, string>> = {}, session: Session = {}): AdminRequest =>
  adminS2Request({ ...SEARCH_ACTION, rc: { siteid: 'default', ispublic: '0', ...rc }, session });

/** The tenant-a site admin on its own system users, `rc` laid over. */
const siteAdminSearch = (rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  siteAdminRequest(SITE, { ...SEARCH_ACTION, rc: { siteid: SITE, ispublic: '0', ...rc } });

/** qa_editor holding the Users and Site Manager modules the cUsers gate requires of a non-admin. */
const usersEditorSearch = (rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  editorRequest({
    ...SEARCH_ACTION,
    rc: { siteid: 'default', ...rc },
    user: { roles: [Roles.systemUser, moduleRole(SITE_MODULE_ID), moduleRole(USERS_MODULE_ID)] },
  });

/** People answering the stored search with `answer`. */
const searching = (answer: Answer): FakeRouteTable => ({ [SEARCH_ROUTE]: { status: 200, body: answer } });

/** People storing posted criteria and answering their result with `answer`. */
const storing = (answer: Answer): FakeRouteTable => ({ [STORE_ROUTE]: { status: 200, body: answer } });

const contextFor = (req: AdminRequest, routes: FakeRouteTable): Ctx =>
  makeScreenContext({ req, gateway: fakeGatewayClient(routes) });

/** The page markup the screen answers; fails on a redirect. */
async function pageHtml(ctx: Ctx): Promise<string> {
  const page = await renderScreenPage(advancedSearchScreen, ctx);
  if (page.kind === 'redirect') throw new Error(`The screen redirected to ${page.location}`);
  return page.html;
}

/** The masked model of the elements `selector` picks in `html`. */
function sectionModel(html: string, selector: string): DomModel {
  const $ = cheerio.load(html);
  return normaliseIds(fragmentModel($.html($(selector))));
}

/** The people calls `ctx` made. */
const peopleCalls = (ctx: Ctx) => ctx.gateway.calls.filter((call) => call.service === 'people');

/** The rc fields posting `params` as the advanced search form's rows 1..n. */
function postedCriteria(params: readonly AdvancedSearchParam[], inActive: string): Record<string, string> {
  const rows = params.flatMap((param, index) => {
    const p = index + 1;
    return [
      [`paramField${p}`, param.Field],
      [`paramRelationship${p}`, param.Relationship],
      [`paramCriteria${p}`, param.Criteria],
      [`paramCondition${p}`, param.Condition],
    ];
  });
  return { param: params.map((_param, index) => index + 1).join(','), inActive, ...Object.fromEntries(rows) };
}

let restoreEnv: () => void;

beforeEach(() => {
  vi.stubEnv('MURA_CONTEXT', undefined);
  vi.stubEnv('MURA_ADMINDIR', undefined);
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderUsersJs', () => {
  it.each<[string, Readonly<Record<string, string>>]>([
    ['the default context and admin directory', {}],
    ['a configured context and admin directory', { MURA_CONTEXT: '/masa', MURA_ADMINDIR: '/manage' }],
  ])('writes the searchParams.js script for %s', (_label, settings) => {
    for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
    resetLegacySettingsForTests();
    const { context, adminDir } = legacySettings();

    const script = renderUsersJs(contextFor(adminSearch(), {}));

    expect(isSafeHtml(script)).toBe(true);
    expect(CORE_VERSION).toBe('7.6.1');
    expect(toString(script)).toBe(
      `<script src="${context}${adminDir}/assets/js/searchParams.js?coreversion=7.6.1" type="text/javascript" ></script>`,
    );
  });

  it('is the screen view request.ajax, which the shell writes into the page', async () => {
    const ctx = contextFor(adminSearch(), searching(advancedSearchDefaultAnswer));
    const script = toString(renderUsersJs(ctx));

    const view = await advancedSearchScreen.render(ctx, await advancedSearchScreen.load!(ctx));

    expect(view.ajax === undefined ? undefined : toString(view.ajax)).toBe(script);
    expect(await pageHtml(contextFor(adminSearch(), searching(advancedSearchDefaultAnswer)))).toContain(script);
  });
});

describe('cUsers.advancedSearch criteria rows', () => {
  it.each<[string, Readonly<Record<string, string>>, Session]>([
    ['rc.newSearch over stored criteria', { newsearch: 'true' }, { ...advancedSearchTwoRowCriteria }],
    ['criteria another circuit stored', {}, { ...advancedSearchTwoRowCriteria, paramCircuit: 'cArch' }],
    ['a session without stored criteria', {}, {}],
  ])('shows one blank row with the fixed fields and conditions for %s', async (_label, rc, session) => {
    const html = await pageHtml(contextFor(adminSearch(rc, session), searching(advancedSearchDefaultAnswer)));
    const model = sectionModel(html, '#searchParams');

    expect(model.labels).toEqual(['Search Criteria']);
    expect(model.controls).toMatchObject(newSearchRow());
    expect(cheerio.load(html)('select[name="paramRelationship1"]').attr('style')).toBe('display:none;');
  });

  it('lists the active tusers extended attributes after the fixed fields', async () => {
    const attributes: UserExtendedAttribute[] = [
      { attributeID: 101, type: 2, subType: 'Default', attribute: 'shoeSize' },
      { attributeID: '102', type: '1', subType: 'Team', attribute: 'motto' },
    ];
    const loader = vi.fn(() => Promise.resolve(attributes));
    const ctx = contextFor(adminSearch(), searching(advancedSearchDefaultAnswer));

    const view = await renderAdvancedSearch(ctx, await loadAdvancedSearch(ctx, loader));
    const model = sectionModel(toString(view.body), '#searchParams');

    expect(loader).toHaveBeenCalledWith(ctx, 'default');
    expect(model.controls).toMatchObject(
      newSearchRow([...FIELDS, ['101^varchar', 'User/Default - shoeSize'], ['102^varchar', 'Group/Team - motto']]),
    );
  });

  it('shows one selected row per stored cUsers criterion', async () => {
    const ctx = contextFor(adminSearch({}, { ...advancedSearchTwoRowCriteria }), searching(advancedSearchLastNameAnswer));

    const model = sectionModel(await pageHtml(ctx), '#searchParams');

    expect(advancedSearchTwoRowCriteria.paramCircuit).toBe('cUsers');
    expect(model.controls).toMatchObject(advancedSearchTwoRowCriteria.paramArray.flatMap((param, i) => storedRow(i + 1, param)));
  });
});

describe('cUsers.advancedSearch form', () => {
  // The All option is never marked, so an empty session.inActive selects nothing and the browser shows All.
  it.each<[string, Session, string | undefined]>([
    ['All', {}, undefined],
    ['Yes', { inActive: '0' }, '0'],
    ['No', { inActive: '1' }, '1'],
  ])('selects %s in the Active filter from session.inActive', async (_label, session, selected) => {
    const model = sectionModel(
      await pageHtml(contextFor(adminSearch({}, session), searching(advancedSearchDefaultAnswer))),
      'form#advancedMemberSearch',
    );

    expect(model.labels).toEqual(['Search Criteria', 'Active']);
    expect(model.controls.find(({ name }) => name === 'inActive')).toMatchObject({
      tag: 'select',
      type: 'select-one',
      value: selected ?? '',
      options: optionsOf(
        [
          ['', 'All'],
          ['0', 'Yes'],
          ['1', 'No'],
        ],
        selected,
      ),
    });
  });

  it('submits by GET to index.cfm with the action, site and ispublic hidden', async () => {
    const html = await pageHtml(contextFor(siteAdminSearch(), searching(advancedSearchDefaultAnswer)));
    const form = cheerio.load(html)('form#advancedMemberSearch');

    expect([form.attr('name'), form.attr('method'), form.attr('action')]).toEqual(['form2', 'get', 'index.cfm']);
    expect(sectionModel(html, 'form#advancedMemberSearch .form-actions').controls).toMatchObject([
      { tag: 'input', name: 'muraAction', type: 'hidden', value: 'cUsers.advancedSearch' },
      { tag: 'input', name: 'siteid', type: 'hidden', value: SITE },
      { tag: 'input', name: 'ispublic', type: 'hidden', value: '0' },
    ]);
  });

  it.each<[string, Answer, readonly (readonly [string, string])[]]>([
    [
      'offers the download when the search found users',
      advancedSearchDefaultAnswer,
      [
        ['Search', SEARCH_ONCLICK],
        ['Download', DOWNLOAD_ONCLICK],
      ],
    ],
    ['offers no download for an empty result', EMPTY_ANSWER, [['Search', SEARCH_ONCLICK]]],
  ])('%s', async (_label, answer, buttons) => {
    const $ = cheerio.load(await pageHtml(contextFor(adminSearch(), searching(answer))));

    const found = $('form#advancedMemberSearch .form-actions button')
      .toArray()
      .map((button) => [$(button).text().trim(), $(button).attr('onclick')]);

    expect(found).toEqual(buttons);
  });
});

describe('cUsers.advancedSearch header', () => {
  it('heads the screen and links Basic Search to cusers.search of the site', async () => {
    const html = await pageHtml(contextFor(siteAdminSearch(), searching(advancedSearchDefaultAnswer)));
    const header = sectionModel(html, '#mura-content .mura-header');

    expect(header.headings).toEqual(['Advanced User Search']);
    expect(header.links).toEqual([{ href: `${ADMIN_URL}cusers.search&siteid=${SITE}`, text: 'Basic Search' }]);
  });
});

describe('cUsers.advancedSearch results', () => {
  const headers = ['', '', 'User', 'Email', 'Date Last Update', 'Time Last Update', 'Last Updated By'];
  const nameAndEmail = (answer: Answer): string[][] =>
    answer.items.map(({ Lname, Fname, Email }) => [`${Lname ?? ''}, ${Fname ?? ''}`, Email ?? '']);

  it.each<[string, string, string]>([
    ['1', 'Site Members', '1'],
    ['0', 'System Users', '0'],
  ])('tabs an admin on ispublic=%s under %s with the scrubbed query string', async (ispublic, title, active) => {
    const html = await pageHtml(contextFor(adminSearch({ ispublic }), searching(advancedSearchDefaultAnswer)));
    const $ = cheerio.load(html);
    const tabUrl = (flag: string): string => `${ADMIN_URL}cusers.advancedsearch&siteid%3Ddefault%26ispublic=${flag}`;

    expect(sectionModel(html, 'ul.mura-tab-links').links).toEqual([
      { href: tabUrl('1'), text: 'Site Members' },
      { href: tabUrl('0'), text: 'System Users' },
    ]);
    expect($('ul.mura-tab-links > li.active > a').attr('href')).toBe(tabUrl(active));
    expect($('#tab2 h3.block-title').text()).toBe(title);
    const [table] = sectionModel(html, '#tab2 table#tbl-users').tables;
    expect(table?.headers).toEqual(headers);
    expect(table?.rows.map((row) => row.slice(2, 4))).toEqual(nameAndEmail(advancedSearchDefaultAnswer));
  });

  it('shows a non-admin the Site Members heading without tabs', async () => {
    const ctx = contextFor(usersEditorSearch({ ispublic: '0' }), searching(advancedSearchLastNameAnswer));
    const html = await pageHtml(ctx);
    const $ = cheerio.load(html);

    expect(peopleCalls(ctx)).toMatchObject([{ method: 'GET', query: { siteid: 'default', ispublic: '1' } }]);
    expect($('ul.mura-tab-links')).toHaveLength(0);
    expect($('.block-bordered > .block-content > h3').text()).toBe('Site Members');
    const [table] = sectionModel(html, '.block-bordered > .block-content > table#tbl-users').tables;
    expect(table?.rows.map((row) => row.slice(2, 4))).toEqual(nameAndEmail(advancedSearchLastNameAnswer));
  });

  it('reports an empty result with the search message and no table', async () => {
    const html = await pageHtml(contextFor(adminSearch(), searching(EMPTY_ANSWER)));
    const $ = cheerio.load(html);

    expect($('table#tbl-users')).toHaveLength(0);
    expect($('#tab2 .help-block-empty').text().trim()).toBe('Your search returned no results.');
  });
});

describe('cUsers.advancedSearch criteria persistence', () => {
  const [lastName] = advancedSearchLastNameCriteria.paramArray as [AdvancedSearchParam];
  const posted = postedCriteria([lastName], advancedSearchLastNameCriteria.inActive);
  const query = { siteid: 'default', ispublic: '0', startrow: '1', recordsperpage: '25' };

  it('has people store posted criteria once and shows the page its store answers', async () => {
    const ctx = contextFor(adminSearch(posted), storing(advancedSearchLastNameAnswer));

    const data = await advancedSearchScreen.load!(ctx);

    expect(peopleCalls(ctx)).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/v2/users/advanced-search',
        query,
        form: {
          muraAction: 'core:cusers.advancedsearch',
          param: '1',
          inActive: '0',
          categoryID: '',
          groupID: '',
          membersOnly: 'false',
          visitorStatus: 'All',
          paramField1: 'tusers.lname^varchar',
          paramRelationship1: 'and',
          paramCriteria1: lastName.Criteria,
          paramCondition1: lastName.Condition,
        },
      }),
    ]);
    expect(data.page).toEqual(advancedSearchLastNameAnswer);
  });

  it('stores nothing without posted criteria and runs the stored ones', async () => {
    const ctx = contextFor(adminSearch({}, { ...advancedSearchLastNameCriteria }), searching(advancedSearchLastNameAnswer));

    await pageHtml(ctx);

    expect(peopleCalls(ctx)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/v2/users/advanced-search', query: { ...query, newsearch: 'false' } }),
    ]);
  });

  it('makes one store call for criteria the request context already captured', async () => {
    const gateway = fakeGatewayClient(storing(advancedSearchLastNameAnswer));
    const req = await buildTestAdminRequest({
      circuit: 'cusers',
      action: 'advancedsearch',
      query: { siteid: 'default', ispublic: '0', ...posted },
      user: 'admin',
      gateway,
    });
    const ctx = makeScreenContext({ req, gateway });

    const model = sectionModel(await pageHtml(ctx), '#searchParams');

    expect(req.sessionWrites).toMatchObject({ paramArray: [lastName], paramCount: 1, paramCircuit: 'cusers' });
    expect(peopleCalls(ctx)).toEqual([
      expect.objectContaining({ method: 'POST', path: '/v2/users/advanced-search', query }),
    ]);
    expect(model.controls).toMatchObject(storedRow(1, lastName));
  });
});
