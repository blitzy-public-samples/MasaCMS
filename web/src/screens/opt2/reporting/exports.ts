// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/reporting';
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  actionButton,
  block,
  controlGroup,
  gridTable,
  opt2ActionUrl,
  opt2Gate,
  opt2Label,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  pagination,
  postForm,
  readPage,
  select,
  stateBadgeOf,
  textInput,
  type GridCell,
  type Label,
  type Opt2Back,
  type SelectOption,
  type StateDisplay,
} from '../shared';

/** An export job as reporting lists it. */
export type ExportJob = components['schemas']['ExportJob'];

export type ExportState = components['schemas']['ExportState'];

/** An export definition as the queue form offers it: its id and name. */
export type ExportDefinitionSummary = components['schemas']['ExportDefinitionSummary'];

/** One page of the tenant's export jobs, with the definitions the queue form offers. */
export interface ExportsData {
  readonly jobs: readonly ExportJob[];
  /** Count of every job of the tenant. */
  readonly total: number;
  /** One-based page number shown. */
  readonly page: number;
  /** Every definition of the tenant, by name. */
  readonly definitions: readonly ExportDefinitionSummary[];
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

/** Label and badge tone of each job state. */
const EXPORT_STATES: Readonly<Record<ExportState, StateDisplay>> = Object.freeze({
  queued: { label: (ctx) => opt2Label(ctx, 'Queued'), tone: 'info' },
  running: { label: () => 'Running', tone: 'info' },
  done: { label: () => 'Done', tone: 'success' },
  failed: { label: () => 'Failed', tone: 'important' },
});

/** `rc.page` as a page number; anything but a positive integer is the first page. */
function pageOf(value: string | undefined): number {
  return value !== undefined && /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : 1;
}

/**
 * The `rc.page` page of the tenant's export jobs and every definition, page 1 when it is past the last, with the
 * queue form's CSRF pair issued; unavailability propagates.
 * @throws GatewayDenialError When reporting refuses the list or the definitions (401 or 403).
 */
export async function loadExports(ctx: ScreenContext): Promise<ExportsData> {
  const [{ answer: response, page }, definitionsResponse] = await Promise.all([
    readPage(
      pageOf(ctx.req.rc.page),
      (target) =>
        ctx.gateway.reporting.call('get', '/v1/reporting/exports', { query: { page: target, pageSize: PAGE_SIZE } }),
      (answer) => (answer.ok ? Math.ceil(answer.body.total / PAGE_SIZE) : undefined),
    ),
    ctx.gateway.reporting.call('get', '/v1/reporting/definitions'),
    ctx.csrf.prefetch([QUEUE_CSRF_CONTEXT]),
  ]);
  const { data, total } = okBody(response, 'reporting', 'listExports');
  const definitions = okBody(definitionsResponse, 'reporting', 'listDefinitions').data;
  return { jobs: data, total, page, definitions };
}

/**
 * Classes of the job grid's columns: the timestamps and error hide on narrow screens, as legacy lists do; the start
 * also below 1200 px, where eight nowrap columns overflow the content beside the sidebar.
 */
const JOB_COLUMN_CLASSES: ReadonlyArray<string | undefined> = [
  undefined,
  undefined,
  undefined,
  'hidden-xs',
  'hidden-xs hidden-sm hidden-md',
  'hidden-xs hidden-sm',
  'hidden-xs',
  undefined,
];

/** The job grid's headers in the reporting column order, then the Download column's. */
function jobHeaders(ctx: ScreenContext): Label[] {
  return [
    'Job',
    opt2Label(ctx, 'Format'),
    opt2Label(ctx, 'State'),
    opt2Label(ctx, 'Created'),
    'Started',
    'Finished',
    'Error',
    opt2Label(ctx, 'Download'),
  ];
}

/** The grid row of `job`: values as stored, the state as its badge, then its Download form when done. */
function jobRow(ctx: ScreenContext, job: ExportJob, downloadUrl: string): GridCell[] {
  // Not an inline signed link: signed URLs expire after 900 s, so each click has the download action fetch a fresh one.
  const download =
    job.state === 'done'
      ? actionButton(opt2Label(ctx, 'Download'), downloadUrl, { jobId: job.job_id }, undefined, { download: true })
      : null;
  return [
    job.job_id,
    job.format,
    stateBadgeOf(ctx, EXPORT_STATES, job.state),
    job.created,
    job.started_at,
    job.finished_at,
    job.error,
    download,
  ];
}

/** Every job in the order reporting lists them, one grid row each, or the empty-list message. */
function jobGrid(ctx: ScreenContext, jobs: readonly ExportJob[], downloadUrl: string): SafeHtml {
  const rows = jobs.map((job) => jobRow(ctx, job, downloadUrl));
  return gridTable(jobHeaders(ctx), rows, EMPTY_MESSAGE, { columnClasses: JOB_COLUMN_CLASSES });
}

/** The queue form: definition picked by name, format and optional business date, posted with the CSRF pair. */
function queueForm(ctx: ScreenContext, posted: QueuePosted, definitions: readonly ExportDefinitionSummary[]): SafeHtml {
  const choices = definitions.map((definition) => ({ value: definition.definition_id, label: definition.name }));
  const definition = controlGroup('Definition', select('definitionId', choices, posted.definitionId));
  const format = controlGroup(opt2Label(ctx, 'Format'), select('format', FORMAT_OPTIONS, posted.format));
  // A text input, as legacy admin CSS styles no date input; reporting rejects any other format with invalidParameters.
  const asOf = controlGroup('As Of (yyyy-mm-dd)', textInput('asOf', posted.asOf, { maxlength: 10 }));
  return postForm(actionUrl(ctx, 'queue'), html`${definition}${format}${asOf}`, 'Queue Export', {
    hidden: ctx.csrf.render(QUEUE_CSRF_CONTEXT, 'form'),
  });
}

/** The export job list body: header, any alert, the queue form, then the jobs with their state and downloads. */
export function exportsBody(ctx: ScreenContext, data: ExportsData, opts: ExportsBodyOptions = {}): SafeHtml {
  const downloadUrl = actionUrl(ctx, 'download');
  const jobs = jobGrid(ctx, data.jobs, downloadUrl);
  return html`${pageHeader('Export Jobs')}${opts.alert}${block(
    html`${queueForm(ctx, opts.posted ?? EMPTY_POSTED, data.definitions)}${jobs}${pagination(ctx, {
      page: data.page,
      totalRecords: data.total,
      recordsPerPage: PAGE_SIZE,
      href: (to) => opt2ScreenUrl('reporting', EXPORTS_SCREEN, { ...siteParams(ctx), page: to }),
    })}`,
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
  render: (ctx: ScreenContext, data: ExportsData) => opt2View('reporting', exportsBody(ctx, data), EXPORTS_SCREEN),
});
