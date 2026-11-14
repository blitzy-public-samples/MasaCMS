// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/reporting';
import { okBody } from '@/lib/gateway-client';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  actionButton,
  block,
  controlGroup,
  opt2ActionUrl,
  opt2Gate,
  opt2Label,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  postForm,
  select,
  textInput,
  valueRows,
  type Label,
  type Opt2Back,
  type SelectOption,
  type ValueRow,
} from '../shared';

/** An export job as reporting lists it. */
export type ExportJob = components['schemas']['ExportJob'];

/** One page of the tenant's export jobs. */
export interface ExportsData {
  readonly jobs: readonly ExportJob[];
  /** Count of every job of the tenant. */
  readonly total: number;
  /** One-based page number shown. */
  readonly page: number;
}

/** Queue form values a re-render keeps. */
export interface QueuePosted {
  readonly definitionId: string;
  readonly format: string;
  readonly asOf: string;
}

/** Extras of a re-rendered list: the service's alert and the posted queue values. */
export interface ExportsBodyOptions {
  readonly alert?: SafeHtml;
  readonly posted?: QueuePosted;
}

/** Roles reporting requires on every `/v1/reporting` operation. */
export const EXPORTER_ROLES: readonly Role[] = Object.freeze([Roles.reportingExporter]);

/** Slug of the export job list, the OPT-2 nav's reporting landing screen. */
export const EXPORTS_SCREEN = 'exports';

/** Jobs per page of the list. */
export const PAGE_SIZE = 50;

/** CSRF context of the queue form: the legacy fixture checks a POST to `reporting/exports` against its empty route id. */
export const QUEUE_CSRF_CONTEXT = '';

/** `siteid` of every link, form and redirect, as the nav's link carries it, so the gateway mints the session site's token. */
function siteParams(ctx: ScreenContext): { readonly siteid: string } {
  return { siteid: ctx.req.session.siteid };
}

/** The list every reporting action returns to. */
export function exportsBack(ctx: ScreenContext): Opt2Back {
  return { module: 'reporting', screen: EXPORTS_SCREEN, params: siteParams(ctx) };
}

/** URL of reporting post action `action` for the session site. */
function actionUrl(ctx: ScreenContext, action: string): string {
  return opt2ActionUrl('reporting', action, siteParams(ctx));
}

const EMPTY_MESSAGE = 'There are no export jobs.';

const FORMAT_OPTIONS: readonly SelectOption[] = [
  { value: 'xlsx', label: 'XLSX' },
  { value: 'csv', label: 'CSV' },
  { value: 'pdf', label: 'PDF' },
];

const EMPTY_POSTED: QueuePosted = Object.freeze({ definitionId: '', format: '', asOf: '' });

/** `rc.page` as a page number; anything but a positive integer is the first page. */
function pageOf(value: string | undefined): number {
  return value !== undefined && /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : 1;
}

/**
 * The `rc.page` page of the tenant's export jobs, with the queue form's CSRF pair issued; unavailability propagates.
 * @throws GatewayDenialError When reporting refuses the list (401 or 403).
 */
export async function loadExports(ctx: ScreenContext): Promise<ExportsData> {
  const page = pageOf(ctx.req.rc.page);
  const [response] = await Promise.all([
    ctx.gateway.reporting.call('get', '/v1/reporting/exports', { query: { page, pageSize: PAGE_SIZE } }),
    ctx.csrf.prefetch([QUEUE_CSRF_CONTEXT]),
  ]);
  const { data, total } = okBody(response, 'reporting', 'listExports');
  return { jobs: data, total, page };
}

/** The labelled values of `job`, without the start, finish and error a job does not have yet. */
function jobValues(ctx: ScreenContext, job: ExportJob): ValueRow[] {
  const values: ValueRow[] = [
    ['Job', job.job_id],
    [opt2Label(ctx, 'Format'), job.format],
    [opt2Label(ctx, 'State'), job.state],
    [opt2Label(ctx, 'Created'), job.created],
    ['Started', job.started_at],
    ['Finished', job.finished_at],
    ['Error', job.error],
  ];
  return values.filter(([, value]) => value !== '');
}

/** `job` as read-only rows in a block of its own, then its Download form when done; a grid row would overflow. */
function jobBlock(ctx: ScreenContext, job: ExportJob, downloadUrl: string): SafeHtml {
  // Not an inline signed link: signed URLs expire after 900 s, so each click has the download action fetch a fresh one.
  const download =
    job.state === 'done' ? actionButton(opt2Label(ctx, 'Download'), downloadUrl, { jobId: job.job_id }) : null;
  return block(html`${valueRows(jobValues(ctx, job))}${download}`);
}

/** Every job in the order reporting lists them, or the empty-list message. */
function jobBlocks(ctx: ScreenContext, jobs: readonly ExportJob[], downloadUrl: string): SafeHtml {
  if (jobs.length === 0) return html`<div class="help-block-empty">${EMPTY_MESSAGE}</div>`;
  return html`${jobs.map((job) => jobBlock(ctx, job, downloadUrl))}`;
}

/** Previous and Next links around `data.page`; nothing when every job fits on it. */
function pagination(ctx: ScreenContext, { page, total }: ExportsData): SafeHtml | null {
  const link = (label: Label, to: number): SafeHtml =>
    html`<li><a${attr('href', opt2ScreenUrl('reporting', EXPORTS_SCREEN, { ...siteParams(ctx), page: to }))}>${label}</a></li>`;
  const previous = page > 1 ? link('Previous', page - 1) : null;
  const next = page * PAGE_SIZE < total ? link(opt2Label(ctx, 'Next'), page + 1) : null;
  return previous === null && next === null ? null : html`<ul class="pagination">${previous}${next}</ul>`;
}

/** The queue form: definition, format and optional business date, posted with the CSRF pair. */
function queueForm(ctx: ScreenContext, posted: QueuePosted): SafeHtml {
  const definition = controlGroup('Definition ID', textInput('definitionId', posted.definitionId, { maxlength: 35 }));
  const format = controlGroup(opt2Label(ctx, 'Format'), select('format', FORMAT_OPTIONS, posted.format));
  const asOf = controlGroup('As Of', textInput('asOf', posted.asOf, { type: 'date' }));
  return postForm(actionUrl(ctx, 'queue'), html`${definition}${format}${asOf}`, 'Queue Export', {
    hidden: ctx.csrf.render(QUEUE_CSRF_CONTEXT, 'form'),
  });
}

/** The export job list body: header, any alert, the queue form, then the jobs with their state and downloads. */
export function exportsBody(ctx: ScreenContext, data: ExportsData, opts: ExportsBodyOptions = {}): SafeHtml {
  const downloadUrl = actionUrl(ctx, 'download');
  const jobs = jobBlocks(ctx, data.jobs, downloadUrl);
  return html`${pageHeader('Export Jobs')}${opts.alert}${block(
    html`${queueForm(ctx, opts.posted ?? EMPTY_POSTED)}${jobs}${pagination(ctx, data)}`,
  )}`;
}

/** `/opt2/admin/reporting/exports`: the export job list with state and signed download. */
export const exportsScreen: Opt2ScreenDefinition<ExportsData> = Object.freeze({
  module: 'reporting',
  screen: EXPORTS_SCREEN,
  roles: EXPORTER_ROLES,
  service: 'reporting',
  gate: opt2Gate(EXPORTER_ROLES),
  load: loadExports,
  render: (ctx: ScreenContext, data: ExportsData) => opt2View('reporting', exportsBody(ctx, data)),
});
