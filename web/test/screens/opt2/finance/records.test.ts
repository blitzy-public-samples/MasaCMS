// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// finance/records: the record list inside the shell, over finance's /v1 record list.
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { RECORDS_PAGE_SIZE } from '@/screens/opt2/finance/records';
import { financeRecords } from '../../../fixtures/opt2/finance';
import { anonymousRequest } from '../../../helpers/admin-request';
import { fragmentModel, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { makeScreenContext, renderScreenPage } from '../../../helpers/screen-context';
import {
  APPROVER,
  LIST_ROUTE,
  LOGOUT,
  NOACCESS,
  PREPARER,
  SITE,
  financeError,
  financeGateway,
  financeRequest,
  financeScreen,
  useFinanceEnv,
} from './support';

// The registry module loads every circuit; screen suites stand in for it with the shell hooks this page renders with.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type FinanceRecordRow = (typeof financeRecords)[number];

const HEADERS = ['Title', 'Period', 'Amount', 'State', 'Version', 'Last Update'];
const STATES = ['IN-PROGRESS', 'SUBMITTED', 'RE-SUBMITTED', 'APPROVED', 'REJECTED'];
const recordHref = (id: string): string => `/opt2/admin/finance/record?siteid=${SITE}&id=${id}`;
const listHref = (query: string): string => `/opt2/admin/finance/records?siteid=${SITE}&${query}`;

/** The state filter's controls with `selected` chosen. */
function filterControls(selected: string): DomControl[] {
  const options = [{ value: '', label: 'All' }, ...STATES.map((state) => ({ value: state, label: state }))];
  return [
    {
      tag: 'select',
      name: 'state',
      type: 'select-one',
      value: selected,
      checked: false,
      selected: [selected],
      options: options.map((option) => ({ ...option, selected: option.value === selected })),
    },
    { tag: 'input', name: 'siteid', type: 'hidden', value: SITE, checked: false, selected: [], options: [] },
  ];
}

/** The list body's DOM model for `records`, with `pager` links after the record links. */
function listModel(records: readonly FinanceRecordRow[], selected = '', pager: DomModel['links'] = []): DomModel {
  return {
    title: '',
    headings: ['Finance Records'],
    labels: ['State'],
    controls: filterControls(selected),
    buttons: [{ text: 'Filter', type: 'submit', hasOnclick: false }],
    links: [...records.map((record) => ({ href: recordHref(record.record_id), text: record.title })), ...pager],
    tables: [
      {
        headers: HEADERS,
        rows: records.map((record) => [
          record.title,
          record.period,
          record.amount,
          record.state,
          String(record.version),
          record.lastupdate,
        ]),
      },
    ],
    alerts: [],
  };
}

/** The list body's DOM model and the list calls for `rc` over `gateway`. */
async function renderList(rc: Readonly<Record<string, string>> = {}, gateway = financeGateway(), role = PREPARER) {
  const ctx = makeScreenContext({ req: financeRequest(role, rc), gateway });
  const def = financeScreen('records');
  const view = await def.render(ctx, await def.load(ctx));
  const calls = gateway.calls.filter(({ service }) => service === 'finance');
  return { view, model: fragmentModel(toString(view.body)), calls };
}

describe('finance records screen', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = useFinanceEnv();
  });
  afterEach(() => {
    restore();
  });

  it.each([PREPARER, APPROVER])('lists the first page of records with decimal amounts as sent, for %s', async (role) => {
    const { view, model, calls } = await renderList({}, financeGateway(), role);

    expect(view.opt2Module).toBe('finance');
    expect(model).toStrictEqual(listModel(financeRecords));
    expect(model.tables[0]?.rows.map((row) => row[2])).toEqual([
      '1250.0000',
      '980.5000',
      '4200.0000',
      '315.7500',
      '12000.0000',
    ]);
    expect(calls).toEqual([
      {
        service: 'finance',
        method: 'GET',
        path: '/v1/finance/records',
        query: { page: '1', pageSize: String(RECORDS_PAGE_SIZE) },
      },
    ]);
  });

  it('renders inside the shell with Finance marked in the OPT-2 nav group', async () => {
    const ctx = makeScreenContext({ req: financeRequest(PREPARER), gateway: financeGateway() });
    const page = await renderScreenPage(financeScreen('records'), ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);

    expect($('#admin-nav-opt2').attr('class')).toBe('open');
    expect($(`#admin-nav-opt2 a[href="/opt2/admin/finance/records?siteid=${SITE}"]`).attr('class')).toBe('active');
    expect($('.mura-header h1').text()).toBe('Finance Records');
    expect($('table.mura-table-grid tbody tr')).toHaveLength(financeRecords.length);
  });

  it('filters by a known state and pages through every matching record', async () => {
    const submitted = financeRecords.filter((record) => record.state === 'SUBMITTED');
    const gateway = financeGateway({ [LIST_ROUTE]: { status: 200, body: { data: submitted, total: 120 } } });
    const { model, calls } = await renderList({ state: 'SUBMITTED', page: '2' }, gateway);

    expect(model).toStrictEqual(
      listModel(submitted, 'SUBMITTED', [
        { href: listHref('state=SUBMITTED&page=1'), text: 'Previous' },
        { href: listHref('state=SUBMITTED&page=3'), text: 'Next' },
      ]),
    );
    expect(calls[0]?.query).toEqual({ state: 'SUBMITTED', page: '2', pageSize: '50' });
  });

  it('offers no next page on the last one', async () => {
    const gateway = financeGateway({ [LIST_ROUTE]: { status: 200, body: { data: financeRecords, total: 55 } } });
    const { model } = await renderList({ page: '2' }, gateway);

    expect(model.links.slice(financeRecords.length)).toEqual([{ href: listHref('page=1'), text: 'Previous' }]);
  });

  it.each([
    ['an unknown state and a non-numeric page', { state: 'PAID', page: 'two' }],
    ['a lower-case state and a zero page', { state: 'submitted', page: '0' }],
  ])('lists every state from the first page for %s', async (_, rc) => {
    const { calls } = await renderList(rc);

    expect(calls[0]?.query).toEqual({ page: '1', pageSize: '50' });
  });

  it('shows finance 400 envelope message in an alert instead of the list', async () => {
    const gateway = financeGateway({ [LIST_ROUTE]: financeError(400, 'finance.records', 'Bad Request') });
    const { model } = await renderList({}, gateway);

    expect(model.alerts).toEqual([{ text: 'Bad Request', className: 'alert alert-error' }]);
    expect(model.tables).toEqual([]);
    expect(model.controls).toEqual(filterControls(''));
  });

  it('shows the empty-list message when no record matches', async () => {
    const gateway = financeGateway({ [LIST_ROUTE]: { status: 200, body: { data: [], total: 0 } } });
    const { view } = await renderList({ state: 'APPROVED' }, gateway);

    expect(toString(view.body)).toContain('<div class="help-block-empty">No finance records.</div>');
  });

  it.each([
    [401, LOGOUT],
    [403, NOACCESS],
  ])('answers finance %i with the access gate redirect', async (status, location) => {
    const gateway = financeGateway({ [LIST_ROUTE]: financeError(status, 'finance.records', 'Insufficient Account Permissions') });
    const ctx = makeScreenContext({ req: financeRequest(PREPARER), gateway });

    await expect(renderScreenPage(financeScreen('records'), ctx)).resolves.toEqual({ kind: 'redirect', location });
  });

  it('sends a user without a finance role to cMessage.noaccess without asking finance', async () => {
    const gateway = financeGateway();
    const req = financeRequest(Roles.timesheetsEmployee);
    const page = await renderScreenPage(financeScreen('records'), makeScreenContext({ req, gateway }));

    expect(page).toEqual({ kind: 'redirect', location: NOACCESS });
    expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([]);
  });

  it('sends an anonymous user to the login form without asking finance', async () => {
    const gateway = financeGateway();
    const page = await renderScreenPage(financeScreen('records'), makeScreenContext({ req: anonymousRequest(), gateway }));

    expect(page.kind).toBe('redirect');
    expect(page.kind === 'redirect' ? page.location : '').toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
    expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([]);
  });

  it('propagates finance unavailability', async () => {
    const gateway = financeGateway();
    gateway.failWith();
    const ctx = makeScreenContext({ req: financeRequest(PREPARER), gateway });

    await expect(financeScreen('records').load(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
