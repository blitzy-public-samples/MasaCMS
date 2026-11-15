// cArch.datamanager in the shell for tenant-a's site admin: the responses, edit and display panels, in-view writes.
import * as cheerio from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datamanagerScreen, type DataManagerData } from '@/screens/carch/datamanager';
import { dataDisplayHtmlHead } from '@/screens/carch/data-manager/display';
import { carchJs } from '@/screens/carch/partials/js';
import {
  CARCH_PATHS,
  CONTENT_IDS,
  FORM_RESPONSE_IDS,
  carchDatamanagerData,
} from '../../fixtures/strategies-content/carch';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

type Ctx = ReturnType<typeof makeScreenContext>;
type View = Awaited<ReturnType<typeof datamanagerScreen.render>>;
type Struct = Record<string, unknown>;

const SITE = 'tenant-a';
const FORM = CONTENT_IDS.contactForm;
const FORMS_MODULE = '00000000000000000000000000000000004';
const { first: FIRST, second: SECOND, third: THIRD } = FORM_RESPONSE_IDS;
const ATTACHMENT_ID = '5C000000-000C-4000-8000000000000009';

const CSRF_TOKENS = routeKey('POST', 'identity', '/v1/csrf/tokens');
const READ = routeKey('GET', 'strategies-content', CARCH_PATHS.datamanager);
const WRITE_PATH = `${CARCH_PATHS.datamanager}/delete` as const;
const WRITE = routeKey('POST', 'strategies-content', WRITE_PATH);
const WRITTEN: FakeReply = { status: 200, body: { saved: true, errors: {}, redirect: null } };

const FORM_RC = { contentid: FORM, moduleid: FORMS_MODULE, topid: FORMS_MODULE, parentid: FORMS_MODULE, type: 'Form' };
/** The download form's View Data submission over the seeded entries. */
const RANGE = {
  date1: '06/29/2026',
  hour1: '0',
  minute1: '0',
  date2: '06/30/2026',
  hour2: '23',
  minute2: '59',
  newSearch: '1',
  delete: '0',
};
const CSRF_PAIR = { [CSRF_FIELD_TOKEN]: 'ABC123', [CSRF_FIELD_EXPIRES]: '261113043456389' };

/** A token naming the context it was issued for, so a rendered token identifies its context. */
const tokenOf = (context: string): string => context.replaceAll('-', '');

/** identity `issueCsrfTokens`: one {@link tokenOf} pair per requested context. */
function issueByContext(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    [CSRF_FIELD_TOKEN]: tokenOf(context),
    [CSRF_FIELD_EXPIRES]: FIXED_CSRF.expires,
  }));
  return { status: 200, body: { tokens } };
}

/** `listFormResponses` of the seeded Contact Us Form with `rc` overrides. */
const model = (rc: Struct = {}): FakeReply => ({ status: 200, body: { rc: { ...carchDatamanagerData.rc, ...rc } } });

/** The tenant-a site admin on the form's data manager with `rc`, over a gateway answering `read` and `routes`. */
function contextFor(rc: Record<string, string> = {}, read: FakeReply = model(), routes: FakeRouteTable = {}): Ctx {
  const gateway = fakeGatewayClient({ [CSRF_TOKENS]: issueByContext, [READ]: read, ...routes });
  const req = siteAdminRequest(SITE, { circuit: 'carch', item: 'datamanager', rc: { ...FORM_RC, ...rc } });
  return makeScreenContext({ req, gateway });
}

/** The page inside the shell, parsed. */
async function page(ctx: Ctx): Promise<cheerio.CheerioAPI> {
  const rendered = await renderScreenPage(datamanagerScreen, ctx);
  if (rendered.kind !== 'document') throw new Error(`The page redirected to ${rendered.location}`);
  return cheerio.load(rendered.html);
}

/** The screen's controller step, load and render, for the ShellView the shell receives. */
async function shellView(ctx: Ctx): Promise<View> {
  expect(await datamanagerScreen.redirect?.(ctx)).toBeUndefined();
  const data = (await datamanagerScreen.load?.(ctx)) as DataManagerData;
  return datamanagerScreen.render(ctx, data);
}

const strategiesCalls = (gateway: FakeGatewayClient): FakeCall[] =>
  gateway.calls.filter((call) => call.service === 'strategies-content');

const issuedContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { readonly contexts: readonly string[] }).contexts);

const optionValues = ($: cheerio.CheerioAPI, select: string): string[] =>
  $(`${select} option`)
    .toArray()
    .map((el) => $(el).attr('value') ?? '');

/** The selected option value of each named select. */
const selectedOf = ($: cheerio.CheerioAPI, ...names: string[]): Array<string | undefined> =>
  names.map((name) => $(`select[name="${name}"] option[selected]`).attr('value'));

/** Name and value of each hidden input of the named form, in document order. */
const hiddenFields = ($: cheerio.CheerioAPI, form: string): Record<string, string | undefined> =>
  Object.fromEntries(
    $(`form[name="${form}"] input[type="hidden"]`)
      .toArray()
      .map((el) => [$(el).attr('name'), $(el).attr('value')]),
  );

/** The query fields of a relative admin href. */
const hrefParams = (href: string | undefined): URLSearchParams => new URLSearchParams((href ?? '').split('?')[1] ?? '');

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('cArch.datamanager responses panel', () => {
  it('renders the header, secondary menu and download form when no filter ran', async () => {
    const ctx = contextFor();
    const $ = await page(ctx);
    expect($('.mura-header h1').text()).toBe('Form Data');
    expect($('.mura-item-metadata .label').toArray().map((el) => $(el).text())).toEqual([
      'Title: Contact Us Form',
      'Total Records Available: 3',
    ]);
    const menu = $('.mura-header .nav-module-specific a');
    expect(menu.toArray().map((el) => $(el).text().trim())).toEqual([
      'Back to Forms',
      'Version History',
      'Edit Display',
      'Delete Form',
      'Permissions',
    ]);
    expect(hrefParams(menu.eq(2).attr('href')).get('action')).toBe('display');

    const form = $('div#manage-data > form[name="download"]');
    expect([form.attr('method'), form.attr('action')]).toEqual(['get', 'index.cfm']);
    expect(form.find('input.datepicker').toArray().map((el) => $(el).attr('name'))).toEqual(['date1', 'date2']);
    const times = ['hour1', 'minute1', 'hour2', 'minute2'];
    expect(times.map((name) => optionValues($, `select[name="${name}"]`).length)).toEqual([24, 60, 24, 60]);
    expect(selectedOf($, ...times)).toEqual(['10', '15', '16', '40']);
    expect(optionValues($, 'select[name="sortBy"]')).toEqual(['Entered', 'fname', 'lname', 'email']);
    expect(optionValues($, 'select[name="sortDirection"]')).toEqual(['asc', 'desc']);
    expect(selectedOf($, 'sortBy', 'sortDirection')).toEqual(['Entered', 'desc']);
    expect(optionValues($, 'select[name="filterBy"]')).toEqual(['fname', 'lname', 'email']);
    expect(form.find('input[name="keywords"]').val()).toBe('');
    expect(hiddenFields($, 'download')).toEqual({
      muraAction: 'cArch.datamanager',
      contentid: FORM,
      siteid: SITE,
      moduleid: FORMS_MODULE,
      newSearch: '1',
      delete: '0',
    });

    const buttons = form.find('button').toArray().map((el) => $(el));
    // Delete Results renders only once rc.minute1 is defined, as in legacy.
    expect(buttons.map((button) => button.text().trim())).toEqual(['View Data', 'Download']);
    expect(buttons[1]?.attr('onclick')).toContain(
      `'./?muraAction=cArch.downloaddata&siteid=${SITE}&contentid=${FORM}&date1='`,
    );
    expect($('table.mura-table-grid')).toHaveLength(0);
    expect(strategiesCalls(ctx.gateway).map((call) => [call.method, call.path])).toEqual([
      ['GET', CARCH_PATHS.datamanager],
      ['GET', `/v1/sites/${SITE}/header-prompts`],
    ]);
  });

  it('lists the filtered responses, each delete link carrying the tokens of its own response id', async () => {
    const rows = (carchDatamanagerData.rc.rsData as Struct[]).map((row, index) =>
      index === 2 ? { ...row, entered: '2026-10-29 14:05:00.0' } : row,
    );
    const ctx = contextFor(RANGE, model({ rsData: rows }));
    const $ = await page(ctx);
    const grid = $('div#manage-data table.mura-table-grid');
    expect(grid.find('thead th').toArray().map((el) => $(el).text())).toEqual([
      '',
      'Date/Time Entered',
      'fname',
      'lname',
      'email',
    ]);
    const ids = [FIRST, SECOND, THIRD];
    const bodyRows = grid.find('tbody tr').toArray().map((el) => $(el));
    expect(bodyRows).toHaveLength(ids.length);
    bodyRows.forEach((row, index) => {
      const id = ids[index] ?? '';
      const edit = hrefParams(row.find('li.edit a').attr('href'));
      const remove = hrefParams(row.find('li.delete a').attr('href'));
      expect([edit.get('responseid'), edit.get('action'), edit.has(CSRF_FIELD_TOKEN)]).toEqual([id, 'edit', false]);
      expect([remove.get('responseid'), remove.get('action')]).toEqual([id, 'delete']);
      expect([remove.get(CSRF_FIELD_TOKEN), remove.get(CSRF_FIELD_EXPIRES)]).toEqual([tokenOf(id), FIXED_CSRF.expires]);
    });
    expect(issuedContexts(ctx.gateway)).toEqual(expect.arrayContaining(ids));
    // Known legacy issue kept: the admin date mask prints the day of the year, so 2026-10-29 reads 10/302/2026.
    expect(bodyRows.map((row) => row.find('td.dateSubmitted').text())).toEqual([
      '06/180/2026 10:15 AM',
      '06/181/2026 9:41 AM',
      '10/302/2026 2:05 PM',
    ]);
    expect($('form[name="download"] button').toArray().map((el) => $(el).text().trim())).toEqual([
      'View Data',
      'Delete Results',
      'Download',
    ]);
    expect(strategiesCalls(ctx.gateway).filter((call) => call.method === 'POST')).toEqual([]);
  });

  it.each<[string, Record<string, string>, FakeReply, FakeRouteTable, string, number]>([
    [
      'the bulk delete of the filtered responses',
      { ...RANGE, delete: '1' },
      model(),
      { [WRITE]: WRITTEN },
      '3 responses were deleted.',
      1,
    ],
    [
      'a form without responses',
      {},
      model({ rsDataInfo: [{ CountEntered: 0, firstEntered: null, lastEntered: null }], rsData: [] }),
      {},
      'No data to display for this form',
      0,
    ],
  ])('shows the notice of %s', async (_case, rc, read, routes, notice, downloadForms) => {
    const $ = await page(contextFor(rc, read, routes));
    expect($('div#manage-data .help-block-empty').text().trim()).toBe(notice);
    expect($('div#manage-data table')).toHaveLength(0);
    expect($('form[name="download"]')).toHaveLength(downloadForms);
  });
});

describe('cArch.datamanager edit panel', () => {
  const longMessage = 'Please send the program calendar for the autumn term, with every session date. '.repeat(2);
  const read = model({
    fieldnames: 'fname,message,resumeattachment',
    rsData: [
      {
        responseID: FIRST,
        entered: '2026-06-29 10:15:00.0',
        data: { RESPONSEID: FIRST, FNAME: 'Avery', MESSAGE: longMessage, RESUMEATTACHMENT: ATTACHMENT_ID },
      },
    ],
  });

  it('renders form1 with one control per field and the state it posts back as action=update', async () => {
    const ctx = contextFor({ ...RANGE, action: 'edit', responseid: FIRST }, read);
    const $ = await page(ctx);
    const form = $('form[name="form1"]');
    expect([form.attr('method'), form.attr('action')]).toEqual(['post', 'index.cfm']);
    expect(form.find('label').toArray().map((el) => $(el).text())).toEqual(['Date/Time Entered', 'fname', 'message']);
    expect(form.find('.mura-control').text().trim()).toBe('06/180/2026 10:15 AM');
    expect(form.find('input[name="fname"]').attr('type')).toBe('text');
    expect(form.find('input[name="fname"]').val()).toBe('Avery');
    expect(form.find('textarea[name="message"]').text()).toBe(longMessage);
    expect(form.find('input[name="resumeattachment"]').attr('type')).toBe('hidden');
    expect(form.find('input[name="resumeattachment"]').val()).toBe(ATTACHMENT_ID);

    expect(form.find('button').toArray().map((el) => [$(el).text(), $(el).attr('onclick')])).toEqual([
      ['Update', "submitForm(document.forms.form1,'update');"],
      ['Delete', "submitForm(document.forms.form1,'delete','Delete\\x20Response\\x3F');"],
    ]);
    expect(hiddenFields($, 'form1')).toEqual({
      resumeattachment: ATTACHMENT_ID,
      formid: FORM,
      contentid: FORM,
      siteid: SITE,
      muraAction: 'cArch.datamanager',
      responseID: FIRST,
      hour1: '0',
      hour2: '23',
      minute1: '0',
      minute2: '59',
      date1: '06/29/2026',
      date2: '06/30/2026',
      fieldlist: 'fname,message,resumeattachment',
      sortBy: 'entered',
      sortDirection: 'desc',
      filterBy: '',
      keywords: '',
      entered: '2026-06-29 10:15:00.0',
      moduleid: FORMS_MODULE,
      action: 'update',
      [CSRF_FIELD_TOKEN]: tokenOf(FIRST),
      [CSRF_FIELD_EXPIRES]: FIXED_CSRF.expires,
    });
    expect(issuedContexts(ctx.gateway)).toContain(FIRST);
    expect(strategiesCalls(ctx.gateway).filter((call) => call.method === 'POST')).toEqual([]);
  });
});

describe('cArch.datamanager display panel', () => {
  it('renders frmDisplayFields from the full field list and the saved display settings', async () => {
    const $ = await page(contextFor({ action: 'display' }));
    const form = $('form[name="frmDisplayFields"]');
    expect([form.attr('method'), form.attr('action')]).toEqual(['post', 'index.cfm']);
    expect(optionValues($, 'select#availableFields')).toEqual(['fname', 'lname', 'email', 'message']);
    expect(optionValues($, 'select#summaryList')).toEqual(['fname', 'lname', 'email']);
    expect(optionValues($, 'select#detailList')).toEqual(['fname', 'lname', 'email', 'message']);
    expect(optionValues($, 'select[name="nextN"]')).toEqual(Array.from({ length: 10 }, (_, i) => String(5 * (i + 1))));
    expect(selectedOf($, 'nextN', 'sortBy', 'sortDirection')).toEqual(['20', undefined, 'desc']);
    expect(hiddenFields($, 'frmDisplayFields')).toEqual({
      summaryList2: 'fname^lname^email',
      detailList2: 'fname^lname^email^message',
      action: 'setDisplay',
      muraAction: 'cArch.datamanager',
      contentid: FORM,
      siteid: SITE,
      moduleid: FORMS_MODULE,
    });
    expect($('div#manage-data')).toHaveLength(0);
  });

  it('heads the page with the session date key, then the display script', async () => {
    const ctx = contextFor({ action: 'display' });
    const view = await shellView(ctx);
    expect(view.htmlHead?.value).toBe(ctx.req.session.dateKey.script.value + dataDisplayHtmlHead('7.6.1').value);
    expect(view.htmlHead?.value).toContain('assets/js/manageData.js?coreversion=7.6.1');
  });
});

describe('cArch.datamanager in-view writes', () => {
  it.each<[string, Record<string, string>]>([
    ['Update', { action: 'Update', responseid: FIRST, FNAME: 'Avery', MESSAGE: 'Updated message', ...CSRF_PAIR }],
    ['Delete', { action: 'Delete', responseid: FIRST, ...CSRF_PAIR }],
    [
      'setDisplay',
      {
        action: 'setDisplay',
        summaryList2: 'email^fname',
        detailList2: 'fname^lname^email^message',
        nextN: '25',
        sortBy: 'lname',
        sortDirection: 'asc',
      },
    ],
  ])('posts %s with every inbound field unchanged before the read', async (action, rc) => {
    const ctx = contextFor(rc, model(), { [WRITE]: WRITTEN });
    const $ = await page(ctx);
    const [write, read, ...rest] = strategiesCalls(ctx.gateway);
    expect([write?.method, write?.path]).toEqual(['POST', WRITE_PATH]);
    expect([read?.method, read?.path]).toEqual(['GET', CARCH_PATHS.datamanager]);
    expect(rest.map((call) => call.path)).toEqual([`/v1/sites/${SITE}/header-prompts`]);
    for (const [name, value] of Object.entries(rc)) expect(write?.form?.[name]).toBe(value);
    expect(read?.query?.action).toBe(action === 'setDisplay' ? '' : action);
    const relayedRc = { ...read?.query, action };
    expect(write?.form).toEqual(relayedRc);
    expect(write?.headers).toBeUndefined();
    expect($('.mura-header h1').text()).toBe('Form Data');
  });
});

describe('cArch.datamanager shell and gate', () => {
  it('sets request.ajax to the carch js block', async () => {
    const ctx = contextFor();
    expect((await shellView(ctx)).ajax?.value).toBe(carchJs(ctx, 'datamanager').value);
  });

  it('answers an anonymous request with the secure() redirect, whatever roles rc names', async () => {
    const req = anonymousRequest({
      circuit: 'carch',
      item: 'datamanager',
      rc: { ...FORM_RC, s2: '1', isS2: 'true', roles: 's2,site-admin' },
    });
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient({ [READ]: model() }) });
    const rendered = await renderScreenPage(datamanagerScreen, ctx);
    expect(rendered.kind).toBe('redirect');
    expect(rendered.kind === 'redirect' ? rendered.location : '').toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
    expect(strategiesCalls(ctx.gateway)).toEqual([]);
  });

  it('fails with GatewayUnavailableError when strategies-content is unreachable', async () => {
    const ctx = contextFor();
    ctx.gateway.failWith();
    const error: unknown = await renderScreenPage(datamanagerScreen, ctx).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ name: 'GatewayUnavailableError', service: 'strategies-content' });
  });
});
