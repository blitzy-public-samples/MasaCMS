// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../../registry';
import {
  actionButton,
  block,
  canUse,
  controlGroup,
  gridTable,
  opt2View,
  pageHeader,
  postForm,
  textInput,
  type GridCell,
} from '../shared';
import {
  FINANCE_MODULE,
  PREPARER,
  TRANSITIONS,
  financeActionUrl,
  noRecord,
  readResult,
  recordsUrl,
  type FinanceRecordDetail,
  type ReadResult,
} from './service';

type Version = FinanceRecordDetail['versions'][number];
type Attachment = FinanceRecordDetail['attachments'][number];

const SUMMARY_HEADERS: readonly string[] = ['Title', 'Amount', 'Period', 'State', 'Version', 'Created', 'Last Update'];
const VERSION_HEADERS: readonly string[] = ['Version', 'Action', 'State', 'Title', 'Amount', 'Period', 'Actor', 'Created'];
const VERSION_TITLE_COLUMN = VERSION_HEADERS.indexOf('Title');
const ATTACHMENT_HEADERS: readonly string[] = ['File Name', 'Content Type', 'Size (bytes)', 'SHA-256', 'Created'];

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

function versionRow(version: Version): GridCell[] {
  return [
    version.version,
    version.action,
    version.state,
    version.title,
    version.amount,
    version.period,
    version.actor_user_id,
    version.created,
  ];
}

function attachmentRow(ctx: ScreenContext, attachment: Attachment): GridCell[] {
  const href = financeActionUrl(ctx, 'download', { id: attachment.record_id, aid: attachment.attachment_id });
  return [
    html`<a${attr('href', href)}>${attachment.file_name}</a>`,
    attachment.content_type,
    attachment.size_bytes,
    attachment.sha256,
    attachment.created,
  ];
}

/** One button per lifecycle action whose role the user holds, each posting the record's CSRF pair. */
function transitionButtons(ctx: ScreenContext, id: string, csrf: SafeHtml): SafeHtml | null {
  const buttons = TRANSITIONS.filter(({ role }) => canUse(ctx.req, [role])).map(({ action, label }) =>
    actionButton(label, financeActionUrl(ctx, action, { id }), {}, csrf),
  );
  return buttons.length === 0 ? null : html`<div class="btn-group">${buttons}</div>`;
}

/** The preparer's edit and upload forms; amounts stay the decimal text finance serialized or the user typed. */
function preparerForms(ctx: ScreenContext, record: FinanceRecordDetail, csrf: SafeHtml, edit?: EditValues): SafeHtml {
  const id = record.record_id;
  const values = edit ?? { title: record.title, amount: record.amount, period: record.period };
  const editFields = html`${controlGroup('Title', textInput('title', values.title, { maxlength: 255, required: true }))}${controlGroup(
    'Amount',
    textInput('amount', values.amount, { required: true }),
  )}${controlGroup('Period', textInput('period', values.period, { required: true }))}`;
  const uploadFields = controlGroup('File', textInput('file', '', { type: 'file', required: true }));
  return html`<h2>Edit Record</h2>${postForm(financeActionUrl(ctx, 'edit', { id }), editFields, 'Save', {
    hidden: csrf,
  })}<h2>Upload Attachment</h2>${postForm(financeActionUrl(ctx, 'upload', { id }), uploadFields, 'Upload', {
    multipart: true,
    hidden: csrf,
  })}`;
}

/**
 * The record detail: summary, transition buttons for the user's roles, version history, attachments with their
 * download links and, for a preparer, the edit and upload forms. `rerender` carries a refused write's alert, which
 * replaces the read's own alert, and the posted edit fields.
 */
export function renderRecord(ctx: ScreenContext, data: RecordData, rerender: RecordRerender = {}): SafeHtml {
  const back = [{ label: 'Finance Records', href: recordsUrl(ctx) }];
  const { result } = data;
  if (!result.ok) return html`${pageHeader('Finance Record', back)}${block(rerender.alert ?? result.alert)}`;
  const record = result.body;
  const csrf = ctx.csrf.render(record.record_id);
  const summary = gridTable(
    SUMMARY_HEADERS,
    [[record.title, record.amount, record.period, record.state, record.version, record.created, record.lastupdate]],
    '',
  );
  const versions = gridTable(VERSION_HEADERS, record.versions.map(versionRow), 'No versions.', {
    varWidthColumn: VERSION_TITLE_COLUMN,
  });
  const attachments = gridTable(
    ATTACHMENT_HEADERS,
    record.attachments.map((attachment) => attachmentRow(ctx, attachment)),
    'No attachments.',
  );
  const forms = canUse(ctx.req, [PREPARER]) ? preparerForms(ctx, record, csrf, rerender.edit) : null;
  return html`${pageHeader(record.title, back)}${block(
    html`${rerender.alert}${summary}${transitionButtons(ctx, record.record_id, csrf)}<h2>Version History</h2>${versions}<h2>Attachments</h2>${attachments}${forms}`,
  )}`;
}

/** The record detail inside the shell, with Finance marked in the OPT-2 nav group. */
export function renderRecordView(ctx: ScreenContext, data: RecordData): ShellView {
  return opt2View(FINANCE_MODULE, renderRecord(ctx, data));
}
