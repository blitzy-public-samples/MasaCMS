// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// finance/record: the record detail with version history, role transition buttons and attachments, inside the shell.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import {
  FINANCE_IDS,
  financeAttachmentSignedUrls,
  financeAttachments,
  financeRecordDetail,
  financeRecordVersions,
} from '../../../fixtures/opt2/finance';
import { fragmentModel, type DomButton, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { routeKey } from '../../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../../helpers/screen-context';
import {
  APPROVER,
  LOGOUT,
  NOACCESS,
  PREPARER,
  RECORD_ID,
  RECORD_ROUTE,
  SITE,
  financeAction,
  financeError,
  financeGateway,
  financeRequest,
  financeScreen,
  preparerApproverRequest,
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

/** The detail body's DOM model of the RE-SUBMITTED fixture record for a user seeing `buttons` and, when `preparer`, the forms. */
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
      record.title,
      'Version History',
      'Attachments',
      ...(preparer ? ['Upload Attachment', 'Edit Record'] : []),
    ],
    labels: [
      ...SUMMARY_LABELS,
      ...record.versions.flatMap(() => VERSION_LABELS),
      ...record.attachments.flatMap(() => ATTACHMENT_LABELS),
      ...(preparer ? ['File', 'Title', 'Amount', 'Period'] : []),
    ],
    controls: [...buttons.flatMap(() => CSRF_CONTROLS), ...(preparer ? [...uploadControls, ...editControls] : [])],
    buttons: [
      ...buttons,
      ...financeAttachments.map((attachment) => attachment.file_name),
      ...(preparer ? ['Upload', 'Save'] : []),
    ].map(button),
    links: [BACK_LINK],
    tables: [],
    alerts: [],
  };
}

/** `[label, value]` of the record's summary, each version and each attachment, as finance sent them. */
function recordValues(record = financeRecordDetail): string[][] {
  const pairs = (labels: readonly string[], values: readonly string[]): string[][] =>
    labels.map((label, index) => [label, values[index] ?? '']);
  return [
    ...pairs(SUMMARY_LABELS, [
      record.title,
      record.amount,
      record.period,
      record.state,
      String(record.version),
      record.created,
      record.lastupdate ?? '',
    ]),
    ...record.versions.flatMap((version) =>
      pairs(VERSION_LABELS, [
        String(version.version),
        version.action,
        version.state,
        version.title,
        version.amount,
        version.period,
        version.actor_user_id,
        version.created,
      ]),
    ),
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
  return $('.mura-control-group:has(> label + div)')
    .toArray()
    .map((group) => [$(group).children('label').text(), $(group).children('div').text()]);
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

  it.each([
    ['a preparer', financeRequest(PREPARER, { id: RECORD_ID }), ['Submit', 'Resubmit'], true],
    ['an approver', financeRequest(APPROVER, { id: RECORD_ID }), ['Approve', 'Reject'], false],
    ['a preparer and approver', preparerApproverRequest({ id: RECORD_ID }), ['Submit', 'Resubmit', 'Approve', 'Reject'], true],
  ])('renders the record, its versions and attachments with the buttons of %s', async (_, req, buttons, preparer) => {
    const { view, model } = await renderDetail(req);

    expect(view.opt2Module).toBe('finance');
    expect(model).toStrictEqual(detailModel(buttons, preparer));
  });

  it('shows the summary, each version and each attachment as label and value rows, values as sent', async () => {
    const { view } = await renderDetail(financeRequest(APPROVER, { id: RECORD_ID }));
    const body = toString(view.body);
    const $ = cheerio.load(body, null, false);

    expect(shownValues(body)).toEqual(recordValues());
    expect($('table')).toHaveLength(0);
    expect($('hr')).toHaveLength(financeRecordVersions.length - 1 + financeAttachments.length - 1);
  });

  it('reads the record once and issues the CSRF pair of its id for every form', async () => {
    const { gateway, view } = await renderDetail();
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
      ['post', `/opt2/admin-actions/finance/resubmit?siteid=${SITE}&id=${RECORD_ID}`, ''],
      ...financeAttachments.map(({ attachment_id }) => [
        'post',
        `/opt2/admin-actions/finance/download?siteid=${SITE}&id=${RECORD_ID}&aid=${attachment_id}`,
        '',
      ]),
      ['post', `/opt2/admin-actions/finance/upload?siteid=${SITE}&id=${RECORD_ID}`, 'multipart/form-data'],
      ['post', `/opt2/admin-actions/finance/edit?siteid=${SITE}&id=${RECORD_ID}`, ''],
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

  it('holds one fixed action bar, the edit form last, so no bar covers another form button', async () => {
    const { view } = await renderDetail();
    const $ = cheerio.load(toString(view.body), null, false);

    expect($('.mura-actions').toArray().map((bar) => $(bar).closest('form').attr('action'))).toEqual([
      `/opt2/admin-actions/finance/edit?siteid=${SITE}&id=${RECORD_ID}`,
    ]);
    expect($('form').last().find('.mura-actions button').text()).toBe('Save');
    expect($('form[enctype] .form-actions > button.btn.mura-primary').text()).toBe('Upload');
  });

  it('renders inside the shell with Finance marked in the OPT-2 nav group', async () => {
    const ctx = makeScreenContext({ req: financeRequest(APPROVER, { id: RECORD_ID }), gateway: financeGateway() });
    const page = await renderScreenPage(financeScreen('record'), ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);

    expect($(`#admin-nav-opt2 a[href="/opt2/admin/finance/records?siteid=${SITE}"]`).attr('class')).toBe('active');
    expect($('.mura-header h1').text()).toBe(financeRecordDetail.title);
  });

  it('encodes record text from the service', async () => {
    const hostile = { ...financeRecordDetail, title: '<script>alert(1)</script>', attachments: [] };
    const gateway = financeGateway({ [RECORD_ROUTE]: { status: 200, body: { data: hostile } } });
    const { view, model } = await renderDetail(undefined, gateway);

    expect(toString(view.body)).not.toContain('<script>');
    expect(model.headings[0]).toBe('<script>alert(1)</script>');
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
    expect(model.buttons.map(({ text }) => text)).toEqual([
      'Approve',
      'Reject',
      ...financeAttachments.map(({ file_name }) => file_name),
    ]);
  });
});
