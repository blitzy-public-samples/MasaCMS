// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
// reporting/exports: the export job list with state and signed download, over reporting's /v1 API.
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate, secure } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  EXPORTER_ROLES,
  PAGE_SIZE,
  exportsBody,
  exportsScreen,
  loadExports,
  type ExportJob,
  type ExportsData,
} from '@/screens/opt2/reporting/exports';
import { GUARDED_SUBMIT, noAccessUrl, OPT2_LABEL_KEYS, type Opt2LabelName } from '@/screens/opt2/shared';
import { loadShellData, renderAdminDocument, serializeAdminDocument } from '@/shell/document';
import { REPORTING_IDS, exportDefinitionSummaries, exportJobs } from '../../../fixtures/opt2/reporting';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  opt2RoleRequest,
} from '../../../helpers/admin-request';
import { fragmentModel, domModel, normaliseIds, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { fakeGatewayClient, type FakeGatewayClient } from '../../../helpers/fake-gateway';
import {
  CSRF_PAIR,
  CSRF_PATH,
  DEFINITIONS_PATH,
  DEFINITIONS_ROUTE,
  LIST_PATH,
  LIST_ROUTE,
  contextFor,
  jobValues,
  shellAndCsrfRoutes,
} from './support';

/** Display text of each job state. */
const STATE_TEXT: Readonly<Record<ExportJob['state'], string>> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

/** The job grid's headers: the reporting columns, then the Download column. */
const JOB_HEADERS = ['Job', 'Format', 'State', 'Created', 'Started', 'Finished', 'Error', 'Download'];

/** The grid cells of `job` in the reporting column order, its state as badge text, then Download. */
const valuesOf = (job: ExportJob): string[] => [
  job.job_id,
  job.format,
  STATE_TEXT[job.state],
  job.created,
  job.started_at,
  job.finished_at,
  job.error,
  job.state === 'done' ? 'Download' : '',
];

const DONE_JOBS = exportJobs.filter((job) => job.state === 'done');

const control = (partial: Partial<DomControl> & Pick<DomControl, 'name'>): DomControl => ({
  tag: 'input',
  type: 'text',
  value: '',
  checked: false,
  selected: [],
  options: [],
  ...partial,
});

const FORMAT_CONTROL = control({
  tag: 'select',
  name: 'format',
  type: 'select-one',
  options: [
    { value: 'xlsx', label: 'XLSX', selected: false },
    { value: 'csv', label: 'CSV', selected: false },
    { value: 'pdf', label: 'PDF', selected: false },
  ],
});

/** The definition picker offering every listed definition by name, none selected. */
const DEFINITION_CONTROL = control({
  tag: 'select',
  name: 'definitionId',
  type: 'select-one',
  options: exportDefinitionSummaries.map((definition) => ({
    value: definition.definition_id,
    label: definition.name,
    selected: false,
  })),
});

/** Every job on its only page, with every definition. */
const LISTED: ExportsData = { jobs: exportJobs, total: exportJobs.length, page: 1, definitions: exportDefinitionSummaries };

/** The DOM model of the list of `jobs` on its only page, with an empty queue form. */
function listModel(jobs: readonly ExportJob[]): DomModel {
  const done = jobs.filter((job) => job.state === 'done');
  return {
    title: '',
    headings: ['Export Jobs'],
    labels: ['Definition', 'Format', 'As Of (yyyy-mm-dd)'],
    controls: [
      DEFINITION_CONTROL,
      FORMAT_CONTROL,
      control({ name: 'asOf' }),
      control({ name: 'csrf_token', type: 'hidden', value: CSRF_PAIR.token }),
      control({ name: 'csrf_token_expires', type: 'hidden', value: CSRF_PAIR.expires }),
      ...done.map((job) => control({ name: 'jobId', type: 'hidden', value: job.job_id })),
    ],
    buttons: [
      { text: 'Queue Export', type: 'submit', hasOnclick: false },
      ...done.map(() => ({ text: 'Download', type: 'submit', hasOnclick: false })),
    ],
    links: [],
    tables: jobs.length === 0 ? [] : [{ headers: JOB_HEADERS, rows: jobs.map(valuesOf) }],
    alerts: [],
  };
}

/** The tenant-a reporting exporter on reporting/exports. */
function exporterRequest(rc: Readonly<Record<string, string>> = {}): AdminRequest {
  return opt2RoleRequest(Roles.reportingExporter, { circuit: 'reporting', item: 'exports', rc });
}

/** A gateway answering the list with `body` and the definitions, and issuing CSRF pairs. */
function listGateway(body: unknown = { data: exportJobs, total: exportJobs.length }): FakeGatewayClient {
  return fakeGatewayClient({
    ...shellAndCsrfRoutes('tenant-a'),
    [LIST_ROUTE]: { status: 200, body },
    [DEFINITIONS_ROUTE]: { status: 200, body: { data: exportDefinitionSummaries } },
  });
}

/** `exportsBody` over loaded data, as markup. */
async function renderedBody(data: ExportsData, gateway: FakeGatewayClient = listGateway()): Promise<string> {
  const ctx = contextFor(exporterRequest(), gateway);
  await ctx.csrf.prefetch(['']);
  return toString(exportsBody(ctx, data));
}

describe('reporting/exports', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('is a frozen reporting screen gated on the exporter role, over loadExports', () => {
    expect(exportsScreen).toMatchObject({
      module: 'reporting',
      screen: 'exports',
      roles: [Roles.reportingExporter],
      service: 'reporting',
      load: loadExports,
    });
    expect(exportsScreen.roles).toBe(EXPORTER_ROLES);
    expect(typeof exportsScreen.gate).toBe('function');
    expect(Object.isFrozen(exportsScreen)).toBe(true);
    expect(Object.isFrozen(EXPORTER_ROLES)).toBe(true);
  });

  describe('gate', () => {
    it('lets the reporting exporter through', async () => {
      await expect(runGate(exporterRequest(), exportsScreen.gate)).resolves.toEqual({ kind: 'allow' });
    });

    it.each([
      { subject: 'the S2 admin, who has no implicit bypass', req: () => adminS2Request() },
      { subject: 'qa_editor', req: () => editorRequest() },
      { subject: 'a finance preparer', req: () => opt2RoleRequest(Roles.financePreparer) },
    ])('sends $subject to cMessage.noaccess', async ({ req }) => {
      await expect(runGate(req(), exportsScreen.gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
    });

    it('sends an anonymous request to the login form through secure()', async () => {
      const req = anonymousRequest();

      const decision = await runGate(req, exportsScreen.gate);

      expect(decision).toEqual(secure(req));
      expect(decision.kind).toBe('redirect');
    });
  });

  describe('loadExports', () => {
    it("reads the token tenant's first page and definitions and issues the queue form's CSRF pair", async () => {
      const gateway = listGateway();

      const data = await loadExports(contextFor(exporterRequest(), gateway));

      expect(data).toEqual(LISTED);
      expect(gateway.calls).toHaveLength(3);
      expect(gateway.calls).toEqual(
        expect.arrayContaining([
          { service: 'reporting', method: 'GET', path: LIST_PATH, query: { page: '1', pageSize: String(PAGE_SIZE) } },
          { service: 'reporting', method: 'GET', path: DEFINITIONS_PATH },
          { service: 'identity', method: 'POST', path: CSRF_PATH, json: { contexts: [''] } },
        ]),
      );
    });

    it.each([
      { page: '2', expected: 2 },
      { page: '123456789', expected: 123456789 },
      { page: '0', expected: 1 },
      { page: '-3', expected: 1 },
      { page: '01', expected: 1 },
      { page: '1.5', expected: 1 },
      { page: 'abc', expected: 1 },
      { page: '', expected: 1 },
      { page: '1234567890', expected: 1 },
    ])('asks for page $expected when rc.page is "$page"', async ({ page, expected }) => {
      const gateway = listGateway({ data: [], total: 0 });

      const data = await loadExports(contextFor(exporterRequest({ page }), gateway));

      expect(data.page).toBe(expected);
      const list = gateway.calls.find((call) => call.service === 'reporting');
      expect(list?.query).toEqual({ page: String(expected), pageSize: String(PAGE_SIZE) });
    });

    it('reads page 1 after a page past the last', async () => {
      const gateway = listGateway();
      gateway.setRoute(LIST_ROUTE, (request) => ({
        status: 200,
        body: { data: request.query['page'] === '1' ? exportJobs : [], total: 120 },
      }));

      const data = await loadExports(contextFor(exporterRequest({ page: '9999' }), gateway));

      expect(data).toEqual({ ...LISTED, total: 120, page: 1 });
      const pages = gateway.calls
        .filter((call) => call.service === 'reporting' && call.path === LIST_PATH)
        .map((call) => call.query?.['page']);
      expect(pages).toEqual(['9999', '1']);
    });

    it.each(
      [
        { route: LIST_ROUTE, operation: 'listExports' },
        { route: DEFINITIONS_ROUTE, operation: 'listDefinitions' },
      ].flatMap((read) => [
        { ...read, status: 401, type: GatewayDenialError },
        { ...read, status: 403, type: GatewayDenialError },
        { ...read, status: 400, type: Error },
        { ...read, status: 500, type: Error },
      ]),
    )('rejects with $type.name when reporting answers $operation with $status', async ({ route, operation, status, type }) => {
      const gateway = listGateway();
      gateway.setRoute(route, { status, body: {} });

      const failure = await loadExports(contextFor(exporterRequest(), gateway)).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(type);
      expect(failure).toMatchObject({ message: `${operation} answered HTTP ${status}` });
    });

    it.each([
      { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
      {
        outage: 'a 503 answer',
        arrange: (gateway: FakeGatewayClient) => gateway.setRoute(LIST_ROUTE, { status: 503, body: {} }),
      },
      {
        outage: 'a 503 answer to the definitions read',
        arrange: (gateway: FakeGatewayClient) => gateway.setRoute(DEFINITIONS_ROUTE, { status: 503, body: {} }),
      },
    ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
      const gateway = listGateway();
      arrange(gateway);

      await expect(loadExports(contextFor(exporterRequest(), gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
    });
  });

  describe('exportsBody', () => {
    it('renders every job with its state and a Download button for each done job', async () => {
      const body = await renderedBody(LISTED);

      expect(fragmentModel(body)).toEqual(listModel(exportJobs));
      expect(jobValues(body)).toEqual(exportJobs.map(valuesOf));
      expect(DONE_JOBS.map((job) => job.job_id)).toEqual([
        REPORTING_IDS.jobDoneXlsx,
        REPORTING_IDS.jobDoneCsv,
        REPORTING_IDS.jobDonePdf,
      ]);
      const $ = cheerio.load(body, null, false);
      expect($('.label').toArray().map((badge) => $(badge).attr('class'))).toEqual(
        ['success', 'success', 'important', 'success', 'info', 'info'].map((tone) => `label label-${tone}`),
      );
      const downloads = $('table.mura-table-grid > tbody > tr > td:last-child > form').toArray().map((el) => ({
        action: $(el).attr('action'),
        method: $(el).attr('method'),
        onsubmit: $(el).attr('onsubmit'),
        fields: $(el).find('input').toArray().map((input) => [$(input).attr('name'), $(input).attr('value')]),
      }));
      // A download answers a file and leaves the page, so it submits natively, without the legacy spinner.
      expect(downloads).toEqual(
        DONE_JOBS.map((job) => ({
          action: '/opt2/admin-actions/reporting/download?siteid=tenant-a',
          method: 'post',
          onsubmit: undefined,
          fields: [['jobId', job.job_id]],
        })),
      );
    });

    it('posts the queue form to the queue action with the CSRF pair, in legacy admin classes only', async () => {
      const body = await renderedBody(LISTED);
      const $ = cheerio.load(body, null, false);

      expect($('form[name="form1"]').attr('action')).toBe('/opt2/admin-actions/reporting/queue?siteid=tenant-a');
      expect($('form[name="form1"]').attr('method')).toBe('post');
      expect(`<form onsubmit="${$('form[name="form1"]').attr('onsubmit')}">`).toBe(`<form${GUARDED_SUBMIT.value}>`);
      expect($('form[name="form1"] input[type="hidden"]').toArray().map((el) => $(el).attr('name'))).toEqual([
        'csrf_token',
        'csrf_token_expires',
      ]);
      expect(body.startsWith('<div class="mura-header"><h1>Export Jobs</h1></div>')).toBe(true);
      expect($('.mura-actions')).toHaveLength(0);
      expect($('form[name="form1"] > .form-actions > button.btn.mura-primary').text()).toBe('Queue Export');
      expect($('style, link, script, [style]').length).toBe(0);
    });

    it('lists the jobs as one grid after the queue form, its secondary columns hidden on narrow screens', async () => {
      const body = await renderedBody({ ...LISTED, total: 120 });
      const $ = cheerio.load(body, null, false);
      const columns = [
        'var-width',
        undefined,
        undefined,
        'hidden-xs',
        'hidden-xs hidden-sm hidden-md',
        'hidden-xs hidden-sm',
        'hidden-xs',
        undefined,
      ];

      expect($('.block-content .block')).toHaveLength(0);
      expect($('form[name="form1"] + table.mura-table-grid + div.mura-layout-row > ul.pagination.pull-right')).toHaveLength(1);
      for (const [index, expected] of columns.entries()) {
        const cells = $(`table.mura-table-grid tr > :nth-child(${index + 1})`).toArray();
        expect(cells.map((cell) => $(cell).attr('class'))).toEqual(Array(exportJobs.length + 1).fill(expected));
      }
    });

    it('shows the empty-list message when the tenant has no jobs', async () => {
      const body = await renderedBody({ ...LISTED, jobs: [], total: 0 });

      expect(fragmentModel(body)).toEqual(listModel([]));
      expect(body).toContain('<div class="help-block-empty">There are no export jobs.</div>');
    });

    it.each([
      { page: 1, total: 120, links: [['#', '1'], [2, '2'], [3, '3'], [2, '']] },
      { page: 2, total: 120, links: [[1, ''], [1, '1'], ['#', '2'], [3, '3'], [3, '']] },
      { page: 3, total: 120, links: [[2, ''], [1, '1'], [2, '2'], ['#', '3']] },
      { page: 2, total: 100, links: [[1, ''], [1, '1'], ['#', '2']] },
      { page: 1, total: 50, links: [] },
    ])('links page $page of $total jobs to every page of the window', async ({ page, total, links }) => {
      const body = await renderedBody({ ...LISTED, total, page });

      expect(fragmentModel(body).links).toEqual(
        links.map(([to, text]) => ({
          href: to === '#' ? '#' : `/opt2/admin/reporting/exports?siteid=tenant-a&page=${to}`,
          text,
        })),
      );
      expect(body.includes('<ul class="pagination pull-right">')).toBe(links.length > 0);
    });

    it('carries session.siteid, URL-encoded, on every form action and page link', async () => {
      const req = opt2RoleRequest(Roles.reportingExporter, {
        circuit: 'reporting',
        item: 'exports',
        session: { siteid: 'tenant b&c' },
        rc: { siteid: 'default' },
      });
      const ctx = contextFor(req, listGateway());
      await ctx.csrf.prefetch(['']);
      const $ = cheerio.load(toString(exportsBody(ctx, { ...LISTED, total: 120, page: 2 })), null, false);

      const targets = [
        ...$('form').toArray().map((el) => $(el).attr('action')),
        ...$('a')
          .toArray()
          .map((el) => $(el).attr('href'))
          .filter((href) => href !== '#'),
      ];
      expect(targets).toHaveLength(1 + DONE_JOBS.length + 4);
      for (const target of targets) expect(target).toMatch(/\?siteid=tenant\+b%26c(&page=[13])?$/);
    });

    it('encodes service values instead of emitting them as markup', async () => {
      const hostile = { ...exportJobs[0], error: '<img src=x onerror=alert(1)>' } as unknown as ExportJob;

      const body = await renderedBody({ ...LISTED, jobs: [hostile], total: 1 });
      const $ = cheerio.load(body, null, false);

      expect($('img').length).toBe(0);
      expect(jobValues(body)[0]?.[6]).toBe('<img src=x onerror=alert(1)>');
    });
  });

  describe('labels', () => {
    const fr = rbFor('fr');
    const download = (body: string): string =>
      cheerio.load(body, null, false)('table.mura-table-grid td > form button').first().text();
    const header = (body: string, column: number): string | undefined => fragmentModel(body).tables[0]?.headers[column];

    it.each<{ slot: string; name: Opt2LabelName; read: (body: string) => string | undefined }>([
      { slot: 'queue form format', name: 'Format', read: (body) => fragmentModel(body).labels[1] },
      { slot: 'job format header', name: 'Format', read: (body) => header(body, 1) },
      { slot: 'job state header', name: 'State', read: (body) => header(body, 2) },
      { slot: 'job created header', name: 'Created', read: (body) => header(body, 3) },
      { slot: 'Download header', name: 'Download', read: (body) => header(body, 7) },
      { slot: 'Download button', name: 'Download', read: download },
    ])('renders the $slot label from the fr bundle', async ({ name, read }) => {
      const ctx = { ...contextFor(exporterRequest(), listGateway()), rb: fr };
      await ctx.csrf.prefetch(['']);

      const body = toString(exportsBody(ctx, { ...LISTED, total: 120 }));

      expect(read(body)).toBe(fr.rbKey(OPT2_LABEL_KEYS[name]));
    });

    it('words the pager record range from the fr bundle', async () => {
      const ctx = { ...contextFor(exporterRequest(), listGateway()), rb: fr };
      await ctx.csrf.prefetch(['']);

      const body = toString(exportsBody(ctx, { ...LISTED, total: 120, page: 1 }));

      expect(cheerio.load(body, null, false)('p.search-showing').text()).toBe('Affichage des résultats 1-50 sur 120');
    });
  });

  describe('in the shell', () => {
    it('renders inside the full layout with Reporting active in the OPT-2 nav group', async () => {
      const gateway = listGateway();
      const ctx = contextFor(exporterRequest(), gateway);

      const view = await exportsScreen.render(ctx, await exportsScreen.load(ctx));
      const shell = await loadShellData(ctx.req, { gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
      const page = serializeAdminDocument(renderAdminDocument(ctx.req, view, ctx.hooks, shell));
      const $ = cheerio.load(page);

      expect(view.opt2Module).toBe('reporting');
      expect(page).toContain(toString(view.body));
      expect($('#admin-nav-opt2').attr('class')).toBe('open');
      expect($('#admin-nav-opt2 > a').attr('class')).toBe('nav-submenu active');
      expect($('#admin-nav-opt2 ul a.active').toArray().map((el) => $(el).attr('href'))).toEqual([
        '/opt2/admin/reporting/exports?siteid=tenant-a',
      ]);
      const model = normaliseIds(domModel(page));
      expect(model.headings).toContain('Export Jobs');
      expect(jobValues(page)).toEqual(exportJobs.map(valuesOf));
    });
  });
});
