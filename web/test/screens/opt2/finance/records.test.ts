// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// finance/records: the record list and rollup totals inside the shell, over finance's /v1 record list and rollups.
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { RECORDS_PAGE_SIZE, recordsScreen } from '@/screens/opt2/finance/records';
import { financeRecords, financeRollups } from '../../../fixtures/opt2/finance';
import { anonymousRequest } from '../../../helpers/admin-request';
import { routeKey } from '../../../helpers/fake-gateway';
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
type DomTable = DomModel['tables'][number];

const ROLLUPS_ROUTE = routeKey('GET', 'finance', '/v1/finance/rollups');
const HEADERS = ['Title', 'Period', 'Amount', 'State', 'Version', 'Last Update'];
const ROLLUP_HEADERS = ['Period', 'State', 'Record Count', 'Total Amount', 'Computed At'];
const STATES = ['IN-PROGRESS', 'SUBMITTED', 'RE-SUBMITTED', 'APPROVED', 'REJECTED'];
const recordHref = (id: string): string => `/opt2/admin/finance/record?siteid=${SITE}&id=${id}`;
const listHref = (query: string): string => `/opt2/admin/finance/records?siteid=${SITE}&${query}`;

/** The rollup totals table of the fixture rollups. */
const ROLLUP_TABLE: DomTable = {
  headers: ROLLUP_HEADERS,
  rows: financeRollups.map((rollup) => [
    rollup.period,
    rollup.state,
    String(rollup.record_count),
    rollup.total_amount,
    rollup.computed_at,
  ]),
};

/** The state filter's controls with `selected` chosen, and the hidden `asOf` when given. */
function filterControls(selected: string, asOf?: string): DomControl[] {
  const options = [{ value: '', label: 'All' }, ...STATES.map((state) => ({ value: state, label: state }))];
  const hidden = (name: string, value: string): DomControl => ({
    tag: 'input',
    name,
    type: 'hidden',
    value,
    checked: false,
    selected: [],
    options: [],
  });
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
    hidden('siteid', SITE),
    ...(asOf === undefined ? [] : [hidden('asOf', asOf)]),
  ];
}

/** The list body's DOM model for `records`, with `pager` links after the record links, then the rollup totals. */
function listModel(records: readonly FinanceRecordRow[], selected = '', pager: DomModel['links'] = []): DomModel {
  return {
    title: '',
    headings: ['Finance Records', 'Rollup Totals'],
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
      ROLLUP_TABLE,
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

  it('is the finance records screen of the barrel, gated by the reader roles', () => {
    expect(financeScreen('records')).toBe(recordsScreen);
    expect([recordsScreen.module, recordsScreen.screen, recordsScreen.service]).toEqual(['finance', 'records', 'finance']);
    expect(recordsScreen.roles).toEqual([PREPARER, APPROVER]);
  });

  it.each([PREPARER, APPROVER])('lists the first page of records and the rollups with decimals as sent, for %s', async (role) => {
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
    expect(model.tables[1]?.rows.map((row) => row[3])).toEqual([
      '315.7500',
      '1250.0000',
      '4200.0000',
      '12000.0000',
      '980.5000',
    ]);
    expect(calls).toEqual([
      {
        service: 'finance',
        method: 'GET',
        path: '/v1/finance/records',
        query: { page: '1', pageSize: String(RECORDS_PAGE_SIZE) },
      },
      { service: 'finance', method: 'GET', path: '/v1/finance/rollups' },
    ]);
  });

  it('asks for the rollups as of rc.asOf and keeps it in the filter form and pager', async () => {
    const gateway = financeGateway({ [LIST_ROUTE]: { status: 200, body: { data: financeRecords, total: 55 } } });
    const { model, calls } = await renderList({ asOf: '2026-06-30' }, gateway);

    expect(calls[1]).toEqual({
      service: 'finance',
      method: 'GET',
      path: '/v1/finance/rollups',
      query: { asOf: '2026-06-30' },
    });
    expect(model.controls).toEqual(filterControls('', '2026-06-30'));
    expect(model.links.slice(financeRecords.length)).toEqual([{ href: listHref('asOf=2026-06-30&page=2'), text: 'Next' }]);
  });

  it('renders inside the shell with Finance marked in the OPT-2 nav group', async () => {
    const ctx = makeScreenContext({ req: financeRequest(PREPARER), gateway: financeGateway() });
    const page = await renderScreenPage(financeScreen('records'), ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);

    expect($('#admin-nav-opt2').attr('class')).toBe('open');
    expect($(`#admin-nav-opt2 a[href="/opt2/admin/finance/records?siteid=${SITE}"]`).attr('class')).toBe('active');
    expect($('.mura-header h1').text()).toBe('Finance Records');
    expect($('table.mura-table-grid').map((_, table) => $(table).find('tbody tr').length).get()).toEqual([
      financeRecords.length,
      financeRollups.length,
    ]);
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

  it('shows finance 400 envelope message in an alert instead of the list, above the rollup totals', async () => {
    const gateway = financeGateway({ [LIST_ROUTE]: financeError(400, 'finance.records', 'Bad Request') });
    const { model } = await renderList({}, gateway);

    expect(model.alerts).toEqual([{ text: 'Bad Request', className: 'alert alert-error' }]);
    expect(model.tables).toEqual([ROLLUP_TABLE]);
    expect(model.controls).toEqual(filterControls(''));
  });

  it('shows the rollups 400 envelope message in an alert instead of the totals, below the list', async () => {
    const gateway = financeGateway({ [ROLLUPS_ROUTE]: financeError(400, 'finance.rollups', 'Bad Request') });
    const { model } = await renderList({ asOf: '30/06/2026' }, gateway);

    expect(model.alerts).toEqual([{ text: 'Bad Request', className: 'alert alert-error' }]);
    expect(model.tables.map(({ headers }) => headers)).toEqual([HEADERS]);
    expect(model.headings).toEqual(['Finance Records', 'Rollup Totals']);
  });

  it('shows the empty-list messages when no record matches and no rollup exists', async () => {
    const gateway = financeGateway({
      [LIST_ROUTE]: { status: 200, body: { data: [], total: 0 } },
      [ROLLUPS_ROUTE]: { status: 200, body: { data: [] } },
    });
    const { view } = await renderList({ state: 'APPROVED' }, gateway);
    const body = toString(view.body);

    expect(body).toContain('<div class="help-block-empty">There are currently no finance records.</div>');
    expect(body).toContain('<h2>Rollup Totals</h2><div class="help-block-empty">There are currently no rollup totals.</div>');
  });

  it.each([
    [LIST_ROUTE, 401, LOGOUT],
    [LIST_ROUTE, 403, NOACCESS],
    [ROLLUPS_ROUTE, 401, LOGOUT],
    [ROLLUPS_ROUTE, 403, NOACCESS],
  ])('answers finance %s %i with the access gate redirect', async (route, status, location) => {
    const gateway = financeGateway({ [route]: financeError(status, 'finance.records', 'Insufficient Account Permissions') });
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
