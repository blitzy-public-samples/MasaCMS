// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { javaTrim } from '@opt2/platform/legacy-compat';
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
  focusesFirst,
  formActions,
  GUARDED_NATIVE_SUBMIT,
  GUARDED_SUBMIT,
  gridTable,
  invalidParametersAlert,
  isInvalidParameters,
  isMalformedId,
  opt2Label,
  opt2View,
  pageHeader,
  postForm,
  refusedFields,
  submitButton,
  textInput,
  valueRows,
  wrappable,
  type FieldError,
  type FieldRule,
  type FormButton,
  type Opt2Refusal,
} from '../shared';
import {
  FINANCE_MODULE,
  PREPARER,
  canEdit,
  financeActionUrl,
  financeStateBadge,
  legalTransitions,
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

/** A preparer form of the detail. */
export type RecordForm = 'upload' | 'edit';

/** A refused write's detail re-render: its alert and refusal, the posted edit fields and the form it came from. */
export interface RecordRerender {
  readonly alert?: SafeHtml;
  readonly refusal?: Opt2Refusal;
  readonly edit?: EditValues;
  readonly form?: RecordForm;
}

const TITLE_MAX_LENGTH = 255;
// MoneyInput and Period of the finance contract; MoneyInput's surrounding U+0000 to U+0020 are what javaTrim strips.
const AMOUNT_TEXT = /^-?[0-9]{1,15}(\.[0-9]{1,4})?$/;
const PERIOD_TEXT = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** finance's edit rules: the message beside each field whose value finance refuses. */
const EDIT_RULES: Readonly<Record<keyof EditValues, FieldRule>> = Object.freeze({
  title: (value) => {
    if (javaTrim(value) === '') return 'Enter a title that is not blank.';
    // finance stores titles in PostgreSQL text, which cannot hold U+0000.
    if (value.includes('\u0000')) return 'Enter a title without NUL (U+0000) characters.';
    return value.length > TITLE_MAX_LENGTH ? `Enter at most ${TITLE_MAX_LENGTH} characters.` : undefined;
  },
  amount: (value) =>
    AMOUNT_TEXT.test(javaTrim(value))
      ? undefined
      : 'Enter a number with up to 15 digits before the decimal point and up to 4 after it.',
  period: (value) => (PERIOD_TEXT.test(value) ? undefined : 'Enter a month as YYYY-MM, for example 2026-06.'),
});

// finance refuses an amount that would carry a period's positive or negative total past numeric(19,4).
const PERIOD_TOTAL_LIMIT =
  "A period's positive amounts, and its negative amounts, may each total at most 999999999999999.9999.";
const AMOUNT_HINT = `Up to 15 digits before the decimal point and 4 after it, for example -1234.5678. ${PERIOD_TOTAL_LIMIT}`;

/** An invalidParameters refusal no edit rule explains: finance's period-total guard refused the amount. */
const PERIOD_TOTAL_ERRORS: Readonly<Partial<Record<keyof EditValues, FieldError>>> = Object.freeze({
  amount: { message: `Finance refused this amount. ${PERIOD_TOTAL_LIMIT}`, focus: true },
});

/**
 * Record `id` with its versions, attachments and its context's CSRF pair; an empty or malformed `id` asks nothing.
 * @throws GatewayDenialError When finance refuses the read (401 or 403).
 */
export async function loadRecord(ctx: ScreenContext, id: string): Promise<RecordData> {
  if (id === '') return { result: noRecord() };
  if (isMalformedId(id)) return { result: { ok: false, alert: invalidParametersAlert() } };
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
    [opt2Label(ctx, 'Title'), wrappable(record.title)],
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
    ['File Name', actionButton(attachment.file_name, url, {}, undefined, { download: true })],
    [opt2Label(ctx, 'Content Type'), attachment.content_type],
    ['Size (bytes)', attachment.size_bytes],
    ['SHA-256', attachment.sha256],
    [opt2Label(ctx, 'Created'), attachment.created],
  ]);
}

/**
 * One POST form carrying the record's CSRF pair, with a button group of the transitions legal from its state for the
 * user's roles, each button posting to its own action; null when none is.
 */
function transitionForm(ctx: ScreenContext, record: FinanceRecordDetail, csrf: SafeHtml): SafeHtml | null {
  const id = record.record_id;
  const buttons: FormButton[] = legalTransitions(ctx, record.state).map(({ action, label }) => ({
    label: label(ctx),
    formAction: financeActionUrl(ctx, action, { id }),
  }));
  const first = buttons[0];
  if (first === undefined) return null;
  return html`<form method="post"${attr('action', first.formAction)}${GUARDED_NATIVE_SUBMIT}>${csrf}<div class="btn-group">${buttons.map(
    submitButton,
  )}</div></form>`;
}

/** The attachment upload form, its file input focused when `focus`; unnamed, as the page's edit form is `form1`. */
function uploadForm(ctx: ScreenContext, actionUrl: string, csrf: SafeHtml, focus: boolean): SafeHtml {
  const label = opt2Label(ctx, 'File');
  const fields = controlGroup(label, textInput('file', '', { type: 'file', required: true, label, focus }));
  return html`<form novalidate="novalidate"${attr('action', actionUrl)} method="post" enctype="multipart/form-data"${GUARDED_SUBMIT}>${fields}${formActions(
    [{ label: 'Upload', primary: true }],
    csrf,
  )}</form>`;
}

/** The upload and edit blocks `shown` offers, a refused form after its alert; amounts kept as sent or typed. */
function preparerForms(
  ctx: ScreenContext,
  record: FinanceRecordDetail,
  csrf: SafeHtml,
  rerender: RecordRerender,
  shown: Readonly<Record<RecordForm, boolean>>,
): SafeHtml {
  const id = record.record_id;
  const values = rerender.edit ?? { title: record.title, amount: record.amount, period: record.period };
  const refusal = rerender.form === 'edit' ? rerender.refusal : undefined;
  const ruleErrors = refusedFields(EDIT_RULES, values, refusal);
  const errors =
    isInvalidParameters(refusal) && Object.keys(ruleErrors).length === 0 ? PERIOD_TOTAL_ERRORS : ruleErrors;
  const alertOf = (form: RecordForm): SafeHtml | undefined => (rerender.form === form ? rerender.alert : undefined);
  const title = opt2Label(ctx, 'Title');
  const editFields = html`${controlGroup(
    title,
    textInput('title', values.title, {
      maxlength: TITLE_MAX_LENGTH,
      required: true,
      label: title,
      error: errors.title,
      focus: focusesFirst(refusal, errors),
    }),
  )}${controlGroup(
    'Amount',
    textInput('amount', values.amount, { required: true, label: 'Amount', error: errors.amount, hint: AMOUNT_HINT }),
  )}${controlGroup(
    'Period',
    textInput('period', values.period, { required: true, label: 'Period', error: errors.period }),
  )}`;
  const uploadRefusal = rerender.form === 'upload' ? rerender.refusal : undefined;
  const upload = uploadForm(ctx, financeActionUrl(ctx, 'upload', { id }), csrf, focusesFirst(uploadRefusal, {}));
  const edit = postForm(financeActionUrl(ctx, 'edit', { id }), editFields, opt2Label(ctx, 'Save'), { hidden: csrf });
  const uploadBlock = shown.upload ? block(html`<h2>Upload Attachment</h2>${alertOf('upload')}${upload}`) : null;
  const editBlock = shown.edit ? block(html`<h2>Edit Record</h2>${alertOf('edit')}${edit}`) : null;
  return html`${uploadBlock}${editBlock}`;
}

/**
 * The record detail: summary, legal transition buttons, versions, attachments and the forms the user may post.
 * `rerender`'s alert precedes the refused form when shown, else leads the detail. Each form ends its block, as legacy
 * headings carry no top margin.
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
  // Upload has no state check in finance; edit is legal only where the lifecycle export allows it.
  const shown: Readonly<Record<RecordForm, boolean>> = {
    upload: canUse(ctx.req, [PREPARER]),
    edit: canEdit(ctx, record.state),
  };
  const forms = preparerForms(ctx, record, csrf, rerender, shown);
  const leading = rerender.form !== undefined && shown[rerender.form] ? undefined : rerender.alert;
  // A fixed header label, as legacy headers carry; the record title is the first summary row.
  return html`${pageHeader('Finance Record', back)}${block(
    html`${leading}${summaryRows(ctx, record)}${transitionForm(ctx, record, csrf)}`,
  )}${block(
    html`<h2>${opt2Label(ctx, 'Version History')}</h2>${versionGrid(ctx, record.versions)}<h2>Attachments</h2>${attachments}`,
  )}${forms}`;
}

/** The record detail inside the shell, with Finance marked in the OPT-2 nav group. */
export function renderRecordView(ctx: ScreenContext, data: RecordData): ShellView {
  return opt2View(FINANCE_MODULE, renderRecord(ctx, data), 'record');
}
