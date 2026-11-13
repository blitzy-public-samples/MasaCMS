// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../../registry';
import {
  block,
  controlGroup,
  formActions,
  gridTable,
  hiddenField,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  select,
  type GridCell,
  type SelectOption,
} from '../shared';
import {
  FINANCE_MODULE,
  FINANCE_STATES,
  readResult,
  recordsUrl,
  recordUrl,
  sessionSite,
  type FinanceRecord,
  type FinanceState,
  type ReadResult,
} from './service';

/** Rows per page of the record list. */
export const RECORDS_PAGE_SIZE = 50;

const HEADERS: readonly string[] = ['Title', 'Period', 'Amount', 'State', 'Version', 'Last Update'];

const STATE_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'All' },
  ...FINANCE_STATES.map((state) => ({ value: state, label: state })),
];

/** A positive page number of at most nine digits, as `rc.page` may carry it. */
const PAGE_NUMBER = /^[1-9][0-9]{0,8}$/;

/** One page of records and the count of every matching record. */
interface RecordPage {
  readonly data: readonly FinanceRecord[];
  readonly total: number;
}

/** What the record list renders. */
export interface RecordsData {
  /** The state filter; undefined lists every state. */
  readonly state?: FinanceState;
  readonly page: number;
  readonly result: ReadResult<RecordPage>;
}

const isState = (value: string): value is FinanceState => (FINANCE_STATES as readonly string[]).includes(value);

/**
 * One page of the session site's records, filtered by `rc.state` when it names a state; `rc.page` selects the page.
 * @throws GatewayDenialError When finance refuses the list (401 or 403).
 */
export async function loadRecords(ctx: ScreenContext): Promise<RecordsData> {
  const { rc } = ctx.req;
  const state = rc.state !== undefined && isState(rc.state) ? rc.state : undefined;
  const page = rc.page !== undefined && PAGE_NUMBER.test(rc.page) ? Number(rc.page) : 1;
  const res = await ctx.gateway.finance.call('get', '/v1/finance/records', {
    query: { state, page, pageSize: RECORDS_PAGE_SIZE },
  });
  return { state, page, result: readResult(res, 'listRecords') };
}

/** GET form re-listing the records of the chosen state. */
function filterForm(ctx: ScreenContext, state: FinanceState | undefined): SafeHtml {
  const fields = controlGroup('State', select('state', STATE_OPTIONS, state ?? ''));
  return html`<form method="get"${attr('action', opt2ScreenUrl(FINANCE_MODULE, 'records'))}>${fields}${formActions(
    [{ label: 'Filter' }],
    hiddenField('siteid', sessionSite(ctx)),
  )}</form>`;
}

/** Previous and next page links of the list; null when every record fits the first page. */
function pager(ctx: ScreenContext, { state, page }: RecordsData, total: number): SafeHtml | null {
  const pages = Math.ceil(total / RECORDS_PAGE_SIZE);
  if (page === 1 && pages <= 1) return null;
  const link = (label: string, target: number): SafeHtml =>
    html`<li><a${attr('href', recordsUrl(ctx, { state, page: target }))}>${label}</a></li>`;
  return html`<ul class="pagination">${page > 1 ? link('Previous', page - 1) : null}${
    page < pages ? link('Next', page + 1) : null
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

/** The record list: header, state filter, then the page of records with its pager, or the service's alert. */
export function renderRecords(ctx: ScreenContext, data: RecordsData): SafeHtml {
  const { result } = data;
  const content = result.ok
    ? html`${gridTable(
        HEADERS,
        result.body.data.map((record) => recordRow(ctx, record)),
        'No finance records.',
      )}${pager(ctx, data, result.body.total)}`
    : result.alert;
  return html`${pageHeader('Finance Records')}${block(html`${filterForm(ctx, data.state)}${content}`)}`;
}

/** The record list inside the shell, with Finance marked in the OPT-2 nav group. */
export function renderRecordsView(ctx: ScreenContext, data: RecordsData): ShellView {
  return opt2View(FINANCE_MODULE, renderRecords(ctx, data));
}
