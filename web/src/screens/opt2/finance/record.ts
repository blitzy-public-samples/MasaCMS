// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../../registry';
import {
  actionButton,
  amountCell,
  block,
  canUse,
  controlGroup,
  detailList,
  formActions,
  gridTable,
  opt2Label,
  opt2View,
  pageHeader,
  postForm,
  submitButton,
  textInput,
  valueRows,
  type FormButton,
} from '../shared';
import {
  FINANCE_MODULE,
  PREPARER,
  TRANSITIONS,
  financeActionUrl,
  financeStateBadge,
  noRecord,
  readResult,
  recordsUrl,
  type FinanceRecordDetail,
  type ReadResult,
} from './service';

type Version = FinanceRecordDetail['versions'][number];
type Attachment = FinanceRecordDetail['attachments'][number];

/** The record named by a detail request, with its versions and attachment metadata, or the alert finance answered. */
export interface RecordData {
  readonly result: ReadResult<FinanceRecordDetail>;
}

/** Edit fields as posted, shown again when finance refuses the edit. */
export interface EditValues {
  readonly title: string;
  readonly amount: string;
  readonly period: string;
}

/** What a write that finance refused hands the re-rendered detail. */
export interface RecordRerender {
  readonly alert?: SafeHtml;
  readonly edit?: EditValues;
}

/**
 * Record `id` with its versions and attachments, and the CSRF pair of its context; an empty `id` asks nothing.
 * @throws GatewayDenialError When finance refuses the read (401 or 403).
 */
export async function loadRecord(ctx: ScreenContext, id: string): Promise<RecordData> {
  if (id === '') return { result: noRecord() };
  const res = await ctx.gateway.finance.call('get', '/v1/finance/records/{id}', { params: { id } });
  const read = readResult(res, 'getRecord');
  if (!read.ok) return { result: read };
  const record = read.body.data;
  await ctx.csrf.prefetch([record.record_id]);
  return { result: { ok: true, body: record } };
}

// Label and value rows rather than grid rows: legacy grid cells never wrap, so ids and hashes overflow narrow screens.
/** The record's own fields, each value as finance serialized it. */
function summaryRows(ctx: ScreenContext, record: FinanceRecordDetail): SafeHtml {
  return valueRows([
    [opt2Label(ctx, 'Title'), record.title],
    ['Amount', amountCell(record.amount)],
    ['Period', record.period],
    [opt2Label(ctx, 'State'), financeStateBadge(ctx, record.state)],
    [opt2Label(ctx, 'Version'), record.version],
    [opt2Label(ctx, 'Created'), record.created],
    [opt2Label(ctx, 'Last Update'), record.lastupdate],
  ]);
}

/**
 * Classes of the version grid's columns: amount, period, actor and created hide on narrow screens, as in legacy
 * lists; the actor id also below 1200 px, where it pushes the nowrap columns past the content beside the sidebar.
 */
const VERSION_COLUMN_CLASSES: ReadonlyArray<string | undefined> = [
  undefined,
  undefined,
  undefined,
  undefined,
  'hidden-xs',
  'hidden-xs hidden-sm',
  'hidden-xs hidden-sm hidden-md',
  'hidden-xs',
];

/** The version history grid, one row per version as finance lists them, values as serialized. */
function versionGrid(ctx: ScreenContext, versions: readonly Version[]): SafeHtml {
  const headers = [
    opt2Label(ctx, 'Version'),
    opt2Label(ctx, 'Action'),
    opt2Label(ctx, 'State'),
    opt2Label(ctx, 'Title'),
    'Amount',
    'Period',
    'Actor',
    opt2Label(ctx, 'Created'),
  ];
  const rows = versions.map((version) => [
    version.version,
    version.action,
    financeStateBadge(ctx, version.state),
    version.title,
    amountCell(version.amount),
    version.period,
    version.actor_user_id,
    version.created,
  ]);
  return gridTable(headers, rows, 'No versions.', { varWidthColumn: 3, columnClasses: VERSION_COLUMN_CLASSES });
}

function attachmentRows(ctx: ScreenContext, attachment: Attachment): SafeHtml {
  // A POST button, as the download action answers POST only; each click has it fetch a freshly signed URL.
  const url = financeActionUrl(ctx, 'download', { id: attachment.record_id, aid: attachment.attachment_id });
  return valueRows([
    ['File Name', actionButton(attachment.file_name, url)],
    [opt2Label(ctx, 'Content Type'), attachment.content_type],
    ['Size (bytes)', attachment.size_bytes],
    ['SHA-256', attachment.sha256],
    [opt2Label(ctx, 'Created'), attachment.created],
  ]);
}

/**
 * One POST form carrying the record's CSRF pair, with a button group of the lifecycle actions whose role the user
 * holds, each button posting to its own action; null when the user holds none.
 */
function transitionForm(ctx: ScreenContext, id: string, csrf: SafeHtml): SafeHtml | null {
  const buttons: FormButton[] = TRANSITIONS.filter(({ role }) => canUse(ctx.req, [role])).map(({ action, label }) => ({
    label: label(ctx),
    formAction: financeActionUrl(ctx, action, { id }),
  }));
  const first = buttons[0];
  if (first === undefined) return null;
  return html`<form method="post"${attr('action', first.formAction)}>${csrf}<div class="btn-group">${buttons.map(
    submitButton,
  )}</div></form>`;
}

/** The attachment upload form; unnamed, as the page's edit form is `form1`. */
function uploadForm(ctx: ScreenContext, actionUrl: string, csrf: SafeHtml): SafeHtml {
  const fields = controlGroup(opt2Label(ctx, 'File'), textInput('file', '', { type: 'file', required: true }));
  return html`<form novalidate="novalidate"${attr('action', actionUrl)} method="post" enctype="multipart/form-data">${fields}${formActions(
    [{ label: 'Upload', primary: true }],
    csrf,
  )}</form>`;
}

/**
 * The preparer's upload and edit forms, one block each. Amounts stay the decimal text finance serialized or the user
 * typed.
 */
function preparerForms(ctx: ScreenContext, record: FinanceRecordDetail, csrf: SafeHtml, edit?: EditValues): SafeHtml {
  const id = record.record_id;
  const values = edit ?? { title: record.title, amount: record.amount, period: record.period };
  const editFields = html`${controlGroup(
    opt2Label(ctx, 'Title'),
    textInput('title', values.title, { maxlength: 255, required: true }),
  )}${controlGroup(
    'Amount',
    textInput('amount', values.amount, { required: true }),
  )}${controlGroup('Period', textInput('period', values.period, { required: true }))}`;
  return html`${block(
    html`<h2>Upload Attachment</h2>${uploadForm(ctx, financeActionUrl(ctx, 'upload', { id }), csrf)}`,
  )}${block(
    html`<h2>Edit Record</h2>${postForm(financeActionUrl(ctx, 'edit', { id }), editFields, opt2Label(ctx, 'Save'), {
      hidden: csrf,
    })}`,
  )}`;
}

/**
 * The record detail: summary, transition buttons for the user's roles, version history, attachments with their
 * download buttons and, for a preparer, the upload and edit forms. `rerender` carries a refused write's alert, which
 * replaces the read's own alert, and the posted edit fields. Each form ends its block, as legacy action rows do:
 * legacy headings carry no top margin, so a heading after a form's buttons would touch them.
 */
export function renderRecord(ctx: ScreenContext, data: RecordData, rerender: RecordRerender = {}): SafeHtml {
  const back = [{ label: 'Finance Records', href: recordsUrl(ctx) }];
  const { result } = data;
  if (!result.ok) return html`${pageHeader('Finance Record', back)}${block(rerender.alert ?? result.alert)}`;
  const record = result.body;
  const csrf = ctx.csrf.render(record.record_id);
  const attachments = detailList(
    record.attachments.map((attachment) => attachmentRows(ctx, attachment)),
    'No attachments.',
  );
  const forms = canUse(ctx.req, [PREPARER]) ? preparerForms(ctx, record, csrf, rerender.edit) : null;
  return html`${pageHeader(record.title, back)}${block(
    html`${rerender.alert}${summaryRows(ctx, record)}${transitionForm(ctx, record.record_id, csrf)}`,
  )}${block(
    html`<h2>${opt2Label(ctx, 'Version History')}</h2>${versionGrid(ctx, record.versions)}<h2>Attachments</h2>${attachments}`,
  )}${forms}`;
}

/** The record detail inside the shell, with Finance marked in the OPT-2 nav group. */
export function renderRecordView(ctx: ScreenContext, data: RecordData): ShellView {
  return opt2View(FINANCE_MODULE, renderRecord(ctx, data), 'record');
}
