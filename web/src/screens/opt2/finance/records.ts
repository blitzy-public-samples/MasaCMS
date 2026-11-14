// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/finance';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  controlGroup,
  formActions,
  gridTable,
  hiddenField,
  opt2Label,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  select,
  type GridCell,
  type Label,
  type SelectOption,
} from '../shared';
import {
  FINANCE_MODULE,
  FINANCE_SERVICE,
  FINANCE_STATES,
  READERS,
  READER_GATE,
  readResult,
  recordsUrl,
  recordUrl,
  sessionSite,
  type FinanceRecord,
  type FinanceState,
  type ReadResult,
} from './service';

type FinanceRollup = components['schemas']['FinanceRollup'];

/** Rows per page of the record list. */
export const RECORDS_PAGE_SIZE = 50;

/** Each display column of `FinanceRecord`, the period included, labelled as legacy admin lists label them. */
function headers(ctx: ScreenContext): Label[] {
  return [
    opt2Label(ctx, 'Title'),
    'Period',
    'Amount',
    opt2Label(ctx, 'State'),
    opt2Label(ctx, 'Version'),
    opt2Label(ctx, 'Last Update'),
  ];
}

function rollupHeaders(ctx: ScreenContext): Label[] {
  return ['Period', opt2Label(ctx, 'State'), 'Record Count', 'Total Amount', 'Computed At'];
}

/** The state filter's options: All, then each lifecycle state as its contract value. */
function stateOptions(ctx: ScreenContext): SelectOption[] {
  return [
    { value: '', label: opt2Label(ctx, 'All') },
    ...FINANCE_STATES.map((state) => ({ value: state, label: state })),
  ];
}

/** A positive page number of at most nine digits, as `rc.page` may carry it. */
const PAGE_NUMBER = /^[1-9][0-9]{0,8}$/;

/** One page of records and the count of every matching record. */
interface RecordPage {
  readonly data: readonly FinanceRecord[];
  readonly total: number;
}

/** Every rollup row, ordered by period, then state. */
interface RollupList {
  readonly data: readonly FinanceRollup[];
}

/** What the record list renders. */
export interface RecordsData {
  /** The state filter; undefined lists every state. */
  readonly state?: FinanceState;
  readonly page: number;
  /** `rc.asOf` as requested; undefined when absent or empty. */
  readonly asOf?: string;
  readonly result: ReadResult<RecordPage>;
  readonly rollups: ReadResult<RollupList>;
}

const isState = (value: string): value is FinanceState => (FINANCE_STATES as readonly string[]).includes(value);

/**
 * One page of the session site's records, filtered by `rc.state` when it names a state, and the rollup totals as of
 * `rc.asOf` when given; `rc.page` selects the page.
 * @throws GatewayDenialError When finance refuses either read (401 or 403); handlers answer the access gate's redirect.
 */
async function loadRecords(ctx: ScreenContext): Promise<RecordsData> {
  const { rc } = ctx.req;
  const state = rc.state !== undefined && isState(rc.state) ? rc.state : undefined;
  const page = rc.page !== undefined && PAGE_NUMBER.test(rc.page) ? Number(rc.page) : 1;
  const asOf = rc.asOf || undefined;
  const [records, rollups] = await Promise.all([
    ctx.gateway.finance.call('get', '/v1/finance/records', { query: { state, page, pageSize: RECORDS_PAGE_SIZE } }),
    ctx.gateway.finance.call('get', '/v1/finance/rollups', { query: { asOf } }),
  ]);
  return {
    state,
    page,
    asOf,
    result: readResult(records, 'listRecords'),
    rollups: readResult(rollups, 'listRollups'),
  };
}

/** GET form re-listing the records of the chosen state, keeping the requested `asOf`. */
function filterForm(ctx: ScreenContext, { state, asOf }: RecordsData): SafeHtml {
  const fields = controlGroup(opt2Label(ctx, 'State'), select('state', stateOptions(ctx), state ?? ''));
  const hidden = html`${hiddenField('siteid', sessionSite(ctx))}${asOf === undefined ? null : hiddenField('asOf', asOf)}`;
  return html`<form method="get"${attr('action', opt2ScreenUrl(FINANCE_MODULE, 'records'))}>${fields}${formActions(
    [{ label: opt2Label(ctx, 'Filter') }],
    hidden,
  )}</form>`;
}

/** Previous and next page links of the list; null when every record fits the first page. */
function pager(ctx: ScreenContext, { state, asOf, page }: RecordsData, total: number): SafeHtml | null {
  const pages = Math.ceil(total / RECORDS_PAGE_SIZE);
  if (page === 1 && pages <= 1) return null;
  const link = (label: Label, target: number): SafeHtml =>
    html`<li><a${attr('href', recordsUrl(ctx, { state, asOf, page: target }))}>${label}</a></li>`;
  return html`<ul class="pagination">${page > 1 ? link('Previous', page - 1) : null}${
    page < pages ? link(opt2Label(ctx, 'Next'), page + 1) : null
  }</ul>`;
}

function recordRow(ctx: ScreenContext, record: FinanceRecord): GridCell[] {
  return [
    html`<a${attr('href', recordUrl(ctx, record.record_id))}>${record.title}</a>`,
    record.period,
    record.amount,
    record.state,
    record.version,
    record.lastupdate,
  ];
}

function rollupRow(rollup: FinanceRollup): GridCell[] {
  return [rollup.period, rollup.state, rollup.record_count, rollup.total_amount, rollup.computed_at];
}

/**
 * The record list: header, state filter, the page of records with its pager, then the rollup totals; a read finance
 * refused shows its alert in place of that table.
 */
function renderRecords(ctx: ScreenContext, data: RecordsData): SafeHtml {
  const { result, rollups } = data;
  const records = result.ok
    ? html`${gridTable(
        headers(ctx),
        result.body.data.map((record) => recordRow(ctx, record)),
        'There are currently no finance records.',
      )}${pager(ctx, data, result.body.total)}`
    : result.alert;
  const totals = rollups.ok
    ? gridTable(rollupHeaders(ctx), rollups.body.data.map(rollupRow), 'There are currently no rollup totals.')
    : rollups.alert;
  return html`${pageHeader('Finance Records')}${block(
    html`${filterForm(ctx, data)}${records}<h2>Rollup Totals</h2>${totals}`,
  )}`;
}

/** The record list inside the shell, with Finance marked in the OPT-2 nav group. */
function renderRecordsView(ctx: ScreenContext, data: RecordsData): ShellView {
  return opt2View(FINANCE_MODULE, renderRecords(ctx, data));
}

/** The record list screen, the OPT-2 nav's Finance entry. */
export const recordsScreen: Opt2ScreenDefinition<RecordsData> = Object.freeze({
  module: FINANCE_MODULE,
  screen: 'records',
  roles: READERS,
  service: FINANCE_SERVICE,
  gate: READER_GATE,
  load: loadRecords,
  render: renderRecordsView,
});
