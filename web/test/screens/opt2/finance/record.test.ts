// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// finance/record: the record detail with version history, state and role transition buttons and attachments, inside the shell.
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { FinanceState } from '@/screens/opt2/finance/service';
import { GUARDED_NATIVE_SUBMIT, GUARDED_SUBMIT } from '@/screens/opt2/shared';
import {
  FINANCE_IDS,
  financeAttachmentSignedUrls,
  financeAttachments,
  financeRecordDetail,
  financeRecordVersions,
  financeTransitionIllegal,
  financeTransitionLegal,
} from '../../../fixtures/opt2/finance';
import { fragmentModel, type DomButton, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { routeKey } from '../../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../../helpers/screen-context';
import {
  APPROVER,
  CSRF_HEADERS,
  LOGOUT,
  NOACCESS,
  POSTED_CSRF,
  PREPARER,
  RECORD_ID,
  RECORD_ROUTE,
  SITE,
  STATE_TEXT,
  financeAction,
  financeError,
  financeGateway,
  financeRequest,
  financeScreen,
  preparerApproverRequest,
  recordInState,
  useFinanceEnv,
} from './support';

// The registry module loads every circuit; screen suites stand in for it with the shell hooks this page renders with.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SUMMARY_LABELS = ['Title', 'Amount', 'Period', 'State', 'Version', 'Created', 'Last Update'];
const VERSION_LABELS = ['Version', 'Action', 'State', 'Title', 'Amount', 'Period', 'Actor', 'Created'];
const ATTACHMENT_LABELS = ['File Name', 'Content Type', 'Size (bytes)', 'SHA-256', 'Created'];
const BACK_LINK = { href: `/opt2/admin/finance/records?siteid=${SITE}`, text: 'Finance Records' };

const input = (name: string, type: string, value: string): DomControl => ({
  tag: 'input',
  name,
  type,
  value,
  checked: false,
  selected: [],
  options: [],
});

const CSRF_CONTROLS: readonly DomControl[] = [
  input('csrf_token', 'hidden', FIXED_CSRF.token),
  input('csrf_token_expires', 'hidden', FIXED_CSRF.expires),
];

const button = (text: string): DomButton => ({ text, type: 'submit', hasOnclick: false });

/** Button label of each lifecycle action. */
const TRANSITION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  submit: 'Submit',
  resubmit: 'Resubmit',
  approve: 'Approve',
  reject: 'Reject',
});

/** Form action URL of lifecycle action `action` on the fixture record. */
const transitionUrl = (action: string): string => `/opt2/admin-actions/finance/${action}?siteid=${SITE}&id=${RECORD_ID}`;

/** A gateway answering the fixture record in lifecycle state `state`. */
const recordIn = (state: FinanceState) => financeGateway(recordInState(state));

/** The version history grid of `record`: one row per version, values as finance sent them. */
function versionTable(record = financeRecordDetail): DomModel['tables'][number] {
  return {
    headers: VERSION_LABELS,
    rows: record.versions.map((version) => [
      String(version.version),
      version.action,
      STATE_TEXT[version.state],
      version.title,
      version.amount,
      version.period,
      version.actor_user_id,
      version.created,
    ]),
  };
}

/** The detail body's DOM model of the fixture record for a user seeing `buttons` and, when `preparer`, the forms. */
function detailModel(buttons: readonly string[], preparer: boolean): DomModel {
  const record = financeRecordDetail;
  const editControls = [
    input('title', 'text', record.title),
    input('amount', 'text', record.amount),
    input('period', 'text', record.period),
    ...CSRF_CONTROLS,
  ];
  const uploadControls = [input('file', 'file', ''), ...CSRF_CONTROLS];
  return {
    title: '',
    headings: [
      'Finance Record',
      'Version History',
      'Attachments',
      ...(preparer ? ['Upload Attachment', 'Edit Record'] : []),
    ],
    labels: preparer ? ['File', 'Title', 'Amount', 'Period'] : [],
    controls: [...(buttons.length > 0 ? CSRF_CONTROLS : []), ...(preparer ? [...uploadControls, ...editControls] : [])],
    buttons: [
      ...buttons,
      ...financeAttachments.map((attachment) => attachment.file_name),
      ...(preparer ? ['Upload', 'Save'] : []),
    ].map(button),
    links: [BACK_LINK],
    tables: [versionTable()],
    alerts: [],
  };
}

/** `[label, value]` of the record's summary and each attachment, as finance sent them. */
function recordValues(record = financeRecordDetail): string[][] {
  const pairs = (labels: readonly string[], values: readonly string[]): string[][] =>
    labels.map((label, index) => [label, values[index] ?? '']);
  return [
    ...pairs(SUMMARY_LABELS, [
      record.title,
      record.amount,
      record.period,
      STATE_TEXT[record.state],
      String(record.version),
      record.created,
      record.lastupdate ?? '',
    ]),
    ...record.attachments.flatMap((attachment) =>
      pairs(ATTACHMENT_LABELS, [
        attachment.file_name,
        attachment.content_type,
        String(attachment.size_bytes),
        attachment.sha256,
        attachment.created,
      ]),
    ),
  ];
}

/** `[label, value text]` of each read-only label and value row of `body`. */
function shownValues(body: string): string[][] {
  const $ = cheerio.load(body, null, false);
  return $('dl')
    .toArray()
    .map((pair) => [$(pair).children('dt').text(), $(pair).children('dd').text()]);
}

/** The detail body of `req` over `gateway`, with the gateway's calls. */
async function renderDetail(req = financeRequest(PREPARER, { id: RECORD_ID }), gateway = financeGateway()) {
  const ctx = makeScreenContext({ req, gateway });
  const def = financeScreen('record');
  const view = await def.render(ctx, await def.load(ctx));
  return { view, model: fragmentModel(toString(view.body)), gateway };
}

describe('finance record screen', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = useFinanceEnv();
  });
  afterEach(() => {
    restore();
  });

  it.each<[string, FinanceState, AdminRequest, string[], boolean]>([
    ['a preparer', 'IN-PROGRESS', financeRequest(PREPARER, { id: RECORD_ID }), ['Submit'], true],
    ['an approver', 'RE-SUBMITTED', financeRequest(APPROVER, { id: RECORD_ID }), ['Approve', 'Reject'], false],
    ['a preparer and approver', 'REJECTED', preparerApproverRequest({ id: RECORD_ID }), ['Resubmit'], true],
  ])('renders the record, its versions and attachments with the buttons of %s on a record in state %s', async (_, state, req, buttons, preparer) => {
    const { view, model } = await renderDetail(req, recordIn(state));

    expect(view.opt2Module).toBe('finance');
    expect(model).toStrictEqual(detailModel(buttons, preparer));
  });

  it('shows the summary and each attachment as label and value rows and the versions as one grid, values as sent', async () => {
    const { view, model } = await renderDetail(financeRequest(APPROVER, { id: RECORD_ID }));
    const body = toString(view.body);
    const $ = cheerio.load(body, null, false);

    expect(shownValues(body)).toEqual(recordValues());
    // The record's state, then each version's, as legacy admin label badges.
    expect($('.label').toArray().map((badge) => $(badge).attr('class'))).toEqual(
      ['info', 'inverse', 'inverse', 'info', 'important', 'important', 'info'].map((tone) => `label label-${tone}`),
    );
    expect(model.tables).toEqual([versionTable()]);
    expect(model.tables[0]?.rows).toHaveLength(financeRecordVersions.length);
    expect($('h2:contains("Version History") + table.mura-table-grid')).toHaveLength(1);
    expect($('hr')).toHaveLength(financeAttachments.length - 1);
  });

  it('marks the secondary version columns hidden on narrow screens, the title taking the variable width', async () => {
    const { view } = await renderDetail(financeRequest(APPROVER, { id: RECORD_ID }));
    const $ = cheerio.load(toString(view.body), null, false);
    const columns = [
      undefined,
      undefined,
      undefined,
      'var-width',
      'hidden-xs',
      'hidden-xs hidden-sm',
      'hidden-xs hidden-sm hidden-md',
      'hidden-xs',
    ];

    for (const [index, expected] of columns.entries()) {
      const cells = $(`table.mura-table-grid tr > :nth-child(${index + 1})`).toArray();
      expect(cells.map((cell) => $(cell).attr('class'))).toEqual(Array(financeRecordVersions.length + 1).fill(expected));
    }
  });

  it('shows the empty-list message for a record without versions', async () => {
    const bare = { ...financeRecordDetail, versions: [] };
    const gateway = financeGateway({ [RECORD_ROUTE]: { status: 200, body: { data: bare } } });
    const { view, model } = await renderDetail(undefined, gateway);

    expect(model.tables).toEqual([]);
    expect(toString(view.body)).toContain('<h2>Version History</h2><div class="help-block-empty">No versions.</div>');
  });

  it.each<[string, FinanceState, AdminRequest, string[]]>([
    ['a preparer', 'REJECTED', financeRequest(PREPARER, { id: RECORD_ID }), ['resubmit']],
    ['an approver', 'SUBMITTED', financeRequest(APPROVER, { id: RECORD_ID }), ['approve', 'reject']],
    ['a preparer and approver', 'IN-PROGRESS', preparerApproverRequest({ id: RECORD_ID }), ['submit']],
  ])('groups the transitions of %s on a record in state %s in one btn-group of one form posting the CSRF pair once', async (_, state, req, actions) => {
    const { view } = await renderDetail(req, recordIn(state));
    const $ = cheerio.load(toString(view.body), null, false);
    const form = $('form:has(> .btn-group)');

    expect(form).toHaveLength(1);
    expect([form.attr('method'), form.attr('action')]).toEqual(['post', transitionUrl(actions[0] ?? '')]);
    expect(form.children('input').toArray().map((el) => [$(el).attr('name'), $(el).attr('value')])).toEqual([
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
    expect(form.find('.btn-group > *').toArray().map((el) => [el.tagName, $(el).attr('class'), $(el).attr('formaction')])).toEqual(
      actions.map((action) => ['button', 'btn', transitionUrl(action)]),
    );
  });

  it.each<[FinanceState, string, AdminRequest, string[], boolean]>([
    ['IN-PROGRESS', 'a preparer', financeRequest(PREPARER, { id: RECORD_ID }), ['submit'], true],
    ['IN-PROGRESS', 'an approver', financeRequest(APPROVER, { id: RECORD_ID }), [], false],
    ['IN-PROGRESS', 'a preparer and approver', preparerApproverRequest({ id: RECORD_ID }), ['submit'], true],
    ['SUBMITTED', 'a preparer', financeRequest(PREPARER, { id: RECORD_ID }), [], false],
    ['SUBMITTED', 'an approver', financeRequest(APPROVER, { id: RECORD_ID }), ['approve', 'reject'], false],
    ['SUBMITTED', 'a preparer and approver', preparerApproverRequest({ id: RECORD_ID }), ['approve', 'reject'], false],
    ['RE-SUBMITTED', 'a preparer', financeRequest(PREPARER, { id: RECORD_ID }), [], false],
    ['RE-SUBMITTED', 'an approver', financeRequest(APPROVER, { id: RECORD_ID }), ['approve', 'reject'], false],
    ['RE-SUBMITTED', 'a preparer and approver', preparerApproverRequest({ id: RECORD_ID }), ['approve', 'reject'], false],
    ['APPROVED', 'a preparer', financeRequest(PREPARER, { id: RECORD_ID }), [], false],
    ['APPROVED', 'an approver', financeRequest(APPROVER, { id: RECORD_ID }), [], false],
    ['APPROVED', 'a preparer and approver', preparerApproverRequest({ id: RECORD_ID }), [], false],
    ['REJECTED', 'a preparer', financeRequest(PREPARER, { id: RECORD_ID }), ['resubmit'], true],
    ['REJECTED', 'an approver', financeRequest(APPROVER, { id: RECORD_ID }), [], false],
    ['REJECTED', 'a preparer and approver', preparerApproverRequest({ id: RECORD_ID }), ['resubmit'], true],
  ])('offers on a record in state %s to %s only the transitions and edit form legal from that state', async (state, _, req, actions, editable) => {
    const { view } = await renderDetail(req, recordIn(state));
    const $ = cheerio.load(toString(view.body), null, false);
    const preparer = req.user?.roles.includes(PREPARER) === true;

    expect($('form:has(> .btn-group)')).toHaveLength(actions.length > 0 ? 1 : 0);
    expect($('.btn-group > button').toArray().map((el) => [$(el).text(), $(el).attr('formaction')])).toEqual(
      actions.map((action) => [TRANSITION_LABELS[action], transitionUrl(action)]),
    );
    // The download buttons stay in every state, the upload form for a preparer, the edit form only where it is legal.
    expect($('h2').toArray().map((el) => $(el).text())).toEqual([
      'Version History',
      'Attachments',
      ...(preparer ? ['Upload Attachment'] : []),
      ...(editable ? ['Edit Record'] : []),
    ]);
    expect($('form[enctype="multipart/form-data"]').toArray().map((el) => $(el).attr('action'))).toEqual(
      preparer ? [`/opt2/admin-actions/finance/upload?siteid=${SITE}&id=${RECORD_ID}`] : [],
    );
    expect($('form[name="form1"]').toArray().map((el) => $(el).attr('action'))).toEqual(
      editable ? [transitionUrl('edit')] : [],
    );
    expect($('button').toArray().map((el) => $(el).text())).toEqual([
      ...actions.map((action) => TRANSITION_LABELS[action]),
      ...financeAttachments.map(({ file_name }) => file_name),
      ...(preparer ? ['Upload'] : []),
      ...(editable ? ['Save'] : []),
    ]);
  });

  it.each<[FinanceState, boolean]>([
    ['IN-PROGRESS', true],
    ['SUBMITTED', false],
    ['RE-SUBMITTED', false],
    ['APPROVED', false],
    ['REJECTED', true],
  ])('shows a refused edit alert on a record reloaded in state %s before the shown edit form, else leading the detail', async (state, editable) => {
    const edited = { title: 'Consulting services Q3', amount: '4300.5', period: '2026-07' };
    const gateway = financeGateway({
      ...recordInState(state),
      [routeKey('POST', 'finance', `/v1/finance/records/${RECORD_ID}/transitions/edit`)]: financeTransitionIllegal,
    });
    const req = financeRequest(PREPARER, { id: RECORD_ID, ...POSTED_CSRF, ...edited });
    const result = await financeAction('edit').submit(makeScreenContext({ req, gateway }));
    if (result.kind !== 'render') throw new Error(`Expected a re-render, got ${result.kind}`);
    const $ = cheerio.load(toString(result.view.body), null, false);
    const alert = $('.alert');

    expect(alert.toArray().map((el) => [$(el).attr('class'), $(el).text()])).toEqual([['alert alert-error', 'illegalTransition']]);
    expect(alert.is($('.block-content').first().children().first())).toBe(!editable);
    expect([alert.prev('h2').text(), alert.next('form[name="form1"]').length]).toEqual(editable ? ['Edit Record', 1] : ['', 0]);
    expect($('form[name="form1"] input:not([type="hidden"])').toArray().map((el) => $(el).attr('value'))).toEqual(
      editable ? [edited.title, edited.amount, edited.period] : [],
    );
    expect($('[autofocus]').toArray().map((el) => $(el).attr('id'))).toEqual(editable ? ['title'] : []);
    expect($('form[enctype="multipart/form-data"]')).toHaveLength(1);
  });

  it.each<[FinanceState, string[]]>([
    ['IN-PROGRESS', ['submit']],
    ['SUBMITTED', ['approve', 'reject']],
    ['RE-SUBMITTED', ['approve', 'reject']],
    ['REJECTED', ['resubmit']],
  ])('leads each transition button of a record in state %s, posted with the form CSRF pair, to its action and on to finance', async (state, actions) => {
    const { view } = await renderDetail(preparerApproverRequest({ id: RECORD_ID }), recordIn(state));
    const $ = cheerio.load(toString(view.body), null, false);
    const form = $('form:has(> .btn-group)');
    const posted = Object.fromEntries(form.children('input').toArray().map((el) => [$(el).attr('name'), $(el).attr('value')]));
    const path = (action: string): `/${string}` => `/v1/finance/records/${RECORD_ID}/transitions/${action}`;
    const urls = form
      .find('.btn-group > button')
      .toArray()
      .map((button) => new URL($(button).attr('formaction') ?? '', 'http://localhost'));

    expect(urls.map((url) => url.pathname.split('/').pop())).toEqual(actions);
    for (const url of urls) {
      const action = url.pathname.split('/').pop() ?? '';
      const gateway = financeGateway({
        [routeKey('POST', 'finance', path(action))]: { status: 200, body: financeTransitionLegal },
      });
      const ctx = makeScreenContext({ req: preparerApproverRequest({ ...Object.fromEntries(url.searchParams), ...posted }), gateway });

      await expect(financeAction(action).submit(ctx)).resolves.toEqual({
        kind: 'location',
        location: `/opt2/admin/finance/record?siteid=${SITE}&id=${RECORD_ID}`,
      });
      expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([
        { service: 'finance', method: 'POST', path: path(action), headers: CSRF_HEADERS },
      ]);
    }
  });

  it('renders no transition form for a user holding neither finance role', async () => {
    const { view } = await renderDetail(financeRequest(Roles.timesheetsEmployee, { id: RECORD_ID }));
    const $ = cheerio.load(toString(view.body), null, false);

    expect($('form .btn-group')).toHaveLength(0);
    expect($('form').toArray().map((form) => $(form).attr('action'))).toEqual(
      financeAttachments.map(({ attachment_id }) => `/opt2/admin-actions/finance/download?siteid=${SITE}&id=${RECORD_ID}&aid=${attachment_id}`),
    );
  });

  it('reads the record once and issues the CSRF pair of its id for every form', async () => {
    const { gateway, view } = await renderDetail(undefined, recordIn('IN-PROGRESS'));
    const $ = cheerio.load(toString(view.body), null, false);

    expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([
      { service: 'finance', method: 'GET', path: `/v1/finance/records/${RECORD_ID}` },
    ]);
    expect(
      gateway.calls.filter(({ path }) => path === '/v1/csrf/tokens').map(({ json }) => json),
    ).toEqual([{ contexts: [RECORD_ID] }]);
    expect(
      $('form')
        .toArray()
        .map((form) => [$(form).attr('method'), $(form).attr('action'), $(form).attr('enctype') ?? '']),
    ).toEqual([
      ['post', `/opt2/admin-actions/finance/submit?siteid=${SITE}&id=${RECORD_ID}`, ''],
      ...financeAttachments.map(({ attachment_id }) => [
        'post',
        `/opt2/admin-actions/finance/download?siteid=${SITE}&id=${RECORD_ID}&aid=${attachment_id}`,
        '',
      ]),
      ['post', `/opt2/admin-actions/finance/upload?siteid=${SITE}&id=${RECORD_ID}`, 'multipart/form-data'],
      ['post', `/opt2/admin-actions/finance/edit?siteid=${SITE}&id=${RECORD_ID}`, ''],
    ]);
  });

  it('submits the write forms once, the transitions natively for their formaction, and the downloads unguarded', async () => {
    const { view } = await renderDetail(undefined, recordIn('IN-PROGRESS'));
    const $ = cheerio.load(toString(view.body), null, false);
    const onsubmitOf = (guard: { value: string }): string | undefined =>
      cheerio.load(`<form${guard.value}></form>`, null, false)('form').attr('onsubmit');
    const guard = onsubmitOf(GUARDED_SUBMIT);

    expect(
      $('form')
        .toArray()
        .map((form) => [new URL($(form).attr('action') ?? '', 'http://localhost').pathname, $(form).attr('onsubmit')]),
    ).toEqual([
      ['/opt2/admin-actions/finance/submit', onsubmitOf(GUARDED_NATIVE_SUBMIT)],
      ...financeAttachments.map(() => ['/opt2/admin-actions/finance/download', undefined]),
      ['/opt2/admin-actions/finance/upload', guard],
      ['/opt2/admin-actions/finance/edit', guard],
    ]);
    expect(
      $('input[required]')
        .toArray()
        .map((el) => [el.attribs.name, el.attribs['data-label']]),
    ).toEqual([
      ['file', 'File'],
      ['title', 'Title'],
      ['amount', 'Amount'],
      ['period', 'Period'],
    ]);
  });

  it('offers each attachment as a POST button whose id and aid lead the download action to its URL', async () => {
    const { view } = await renderDetail(financeRequest(APPROVER, { id: RECORD_ID }));
    const $ = cheerio.load(toString(view.body), null, false);
    const forms = $('form[action*="/finance/download"]')
      .toArray()
      .map((form) => $(form));

    expect($('a[href*="/finance/download"]')).toHaveLength(0);
    expect(forms.map((form) => [form.attr('method'), form.find('button[type="submit"]').text()])).toEqual(
      financeAttachments.map(({ file_name }) => ['post', file_name]),
    );
    for (const [index, form] of forms.entries()) {
      const rc = Object.fromEntries(new URL(form.attr('action') ?? '', 'http://localhost').searchParams);
      const attachment = financeAttachments[index];
      const ctx = makeScreenContext({ req: financeRequest(APPROVER, rc), gateway: financeGateway() });

      expect(rc).toEqual({ siteid: SITE, id: RECORD_ID, aid: attachment?.attachment_id });
      await expect(financeAction('download').submit(ctx)).resolves.toEqual({
        kind: 'location',
        location: financeAttachmentSignedUrls[attachment?.attachment_id ?? '']?.url,
      });
    }
  });

  it('ends a block with each form, so no heading follows a form inside its block', async () => {
    const { view } = await renderDetail(preparerApproverRequest({ id: RECORD_ID }), recordIn('REJECTED'));
    const $ = cheerio.load(toString(view.body), null, false);
    const blocks = $('.block-content').toArray();

    expect(blocks.map((content) => $(content).children('h2').first().text())).toEqual([
      '',
      'Version History',
      'Upload Attachment',
      'Edit Record',
    ]);
    expect($('.block-content > form').toArray().map((form) => $(form).nextAll().length)).toEqual([0, 0, 0]);
    expect($('.block-content form').length).toBe(3 + financeAttachments.length);
  });

  it('puts the upload and edit buttons in in-flow action rows, with no fixed action bar and one form1', async () => {
    const { view } = await renderDetail(undefined, recordIn('IN-PROGRESS'));
    const $ = cheerio.load(toString(view.body), null, false);

    expect($('.mura-actions')).toHaveLength(0);
    expect($('form[enctype] > .form-actions > button.btn.mura-primary').text()).toBe('Upload');
    expect($('form[name="form1"] > .form-actions > button.btn.mura-primary').text()).toBe('Save');
    expect($('form[name="form1"]').attr('action')).toBe(`/opt2/admin-actions/finance/edit?siteid=${SITE}&id=${RECORD_ID}`);
    expect($('[autofocus]')).toHaveLength(0);
  });

  it('renders inside the shell with Finance marked in the OPT-2 nav group', async () => {
    const ctx = makeScreenContext({ req: financeRequest(APPROVER, { id: RECORD_ID }), gateway: financeGateway() });
    const page = await renderScreenPage(financeScreen('record'), ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);

    expect($(`#admin-nav-opt2 a[href="/opt2/admin/finance/records?siteid=${SITE}"]`).attr('class')).toBe('active');
    expect($('.mura-header h1').text()).toBe('Finance Record');
  });

  it.each([
    ['the fixture title', financeRecordDetail.title, 0],
    ['a 255-character title', 'Consulting services for the quarterly close '.repeat(6).slice(0, 255), 0],
    ['a 255-character unbroken title', 'A'.repeat(255), 10],
  ])('heads the detail with the fixed label, shows %s as the first row and each version title as a variable-width cell', async (_, title, breaks) => {
    const versions = financeRecordDetail.versions.map((version) => ({ ...version, title }));
    const gateway = financeGateway({
      [RECORD_ROUTE]: { status: 200, body: { data: { ...financeRecordDetail, title, versions } } },
    });
    const { view } = await renderDetail(financeRequest(APPROVER, { id: RECORD_ID }), gateway);
    const $ = cheerio.load(toString(view.body), null, false);
    const first = $('.block-content').first().children().first();
    const titleValues = $('dt')
      .toArray()
      .filter((dt) => $(dt).text() === 'Title')
      .map((dt) => $(dt).next('dd'));

    expect($('.mura-header h1').text()).toBe('Finance Record');
    expect($('.mura-header').text()).not.toContain(title);
    expect(first.is('dl')).toBe(true);
    expect([first.children('dt').text(), first.children('dd').text()]).toEqual(['Title', title]);
    expect(titleValues.map((dd) => [dd.text(), dd.find('wbr').length])).toEqual([[title, breaks]]);
    expect($('table.mura-table-grid tbody td.var-width').toArray().map((td) => $(td).text())).toEqual(
      versions.map(() => title),
    );
  });

  it('breaks each attachment digest after every 24 hex digits, its text unchanged', async () => {
    const { view } = await renderDetail(financeRequest(APPROVER, { id: RECORD_ID }));
    const $ = cheerio.load(toString(view.body), null, false);
    const digests = $('dt')
      .toArray()
      .filter((dt) => $(dt).text() === 'SHA-256')
      .map((dt) => $(dt).next('dd'));

    expect(digests.map((dd) => [dd.text(), dd.html()])).toEqual(
      financeAttachments.map(({ sha256 }) => [
        sha256,
        `${sha256.slice(0, 24)}<wbr>${sha256.slice(24, 48)}<wbr>${sha256.slice(48)}`,
      ]),
    );
  });

  it('encodes record text from the service', async () => {
    const hostile = { ...financeRecordDetail, title: '<script>alert(1)</script>', attachments: [] };
    const gateway = financeGateway({ [RECORD_ROUTE]: { status: 200, body: { data: hostile } } });
    const { view, model } = await renderDetail(undefined, gateway);

    expect(toString(view.body)).not.toContain('<script>');
    expect(model.headings[0]).toBe('Finance Record');
    expect(shownValues(toString(view.body))[0]).toEqual(['Title', '<script>alert(1)</script>']);
    expect(toString(view.body)).toContain('<div class="help-block-empty">No attachments.</div>');
  });

  it.each([
    ['finance answers 404', financeError(404, 'finance.records', 'Not Found'), 'Not Found'],
    ['finance answers 400', financeError(400, 'finance.records', 'Bad Request'), 'Bad Request'],
  ])('shows the alert alone when %s', async (_, reply, text) => {
    const gateway = financeGateway({ [RECORD_ROUTE]: reply });
    const { model } = await renderDetail(undefined, gateway);

    expect(model.headings).toEqual(['Finance Record']);
    expect(model.links).toEqual([BACK_LINK]);
    expect(model.alerts).toEqual([{ text, className: 'alert alert-error' }]);
    expect(model.tables).toEqual([]);
    expect(model.buttons).toEqual([]);
  });

  it('asks finance nothing for a request naming no record', async () => {
    const { model, gateway } = await renderDetail(financeRequest(PREPARER));

    expect(model.alerts).toEqual([{ text: 'Not Found', className: 'alert alert-error' }]);
    expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([]);
  });

  it.each(['..', '../x', '../../x', 'abc', `${RECORD_ID}x`])(
    'answers the malformed id %j as finance answers one, asking finance nothing',
    async (id) => {
      const { model, gateway } = await renderDetail(financeRequest(PREPARER, { id }));

      expect(model.headings).toEqual(['Finance Record']);
      expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
      expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([]);
    },
  );

  it.each([
    [401, LOGOUT],
    [403, NOACCESS],
  ])('answers finance %i with the access gate redirect', async (status, location) => {
    const gateway = financeGateway({ [RECORD_ROUTE]: financeError(status, 'finance.records', 'Insufficient Account Permissions') });
    const ctx = makeScreenContext({ req: financeRequest(PREPARER, { id: RECORD_ID }), gateway });

    await expect(renderScreenPage(financeScreen('record'), ctx)).resolves.toEqual({ kind: 'redirect', location });
  });

  it('fails on a finance status the screen does not show', async () => {
    const gateway = financeGateway({ [RECORD_ROUTE]: financeError(500, 'finance.records', 'Unhandled Exception', 'server_error') });

    await expect(renderDetail(undefined, gateway)).rejects.toThrow('getRecord answered HTTP 500');
  });

  it('propagates finance unavailability', async () => {
    const gateway = financeGateway();
    gateway.failWith();

    await expect(renderDetail(undefined, gateway)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('reads another record by its own id', async () => {
    const otherRoute = routeKey('GET', 'finance', `/v1/finance/records/${FINANCE_IDS.recordApproved}`);
    const approved = { ...financeRecordDetail, record_id: FINANCE_IDS.recordApproved, state: 'APPROVED' as const };
    const gateway = financeGateway({ [otherRoute]: { status: 200, body: { data: approved } } });
    const { model, view } = await renderDetail(financeRequest(APPROVER, { id: FINANCE_IDS.recordApproved }), gateway);

    expect(shownValues(toString(view.body))).toEqual(recordValues(approved));
    expect(model.buttons.map(({ text }) => text)).toEqual(financeAttachments.map(({ file_name }) => file_name));
  });
});
