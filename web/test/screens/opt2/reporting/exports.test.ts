// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
// reporting/exports: the export job list with state and signed download, over reporting's /v1 API.
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate, secure } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import {
  EXPORTER_ROLES,
  PAGE_SIZE,
  exportsBody,
  exportsScreen,
  loadExports,
  type ExportJob,
  type ExportsData,
} from '@/screens/opt2/reporting/exports';
import { noAccessUrl } from '@/screens/opt2/shared';
import { loadShellData, renderAdminDocument, serializeAdminDocument } from '@/shell/document';
import { REPORTING_IDS, exportJobs } from '../../../fixtures/opt2/reporting';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  opt2RoleRequest,
} from '../../../helpers/admin-request';
import { fragmentModel, domModel, normaliseIds, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { fakeGatewayClient, type FakeGatewayClient } from '../../../helpers/fake-gateway';
import { CSRF_PAIR, CSRF_PATH, LIST_PATH, LIST_ROUTE, contextFor, shellAndCsrfRoutes } from './support';

const HEADERS = ['Job', 'Format', 'State', 'Created', 'Started', 'Finished', 'Error', 'Download'];

/** The table row the list renders for `job`: its columns as text, `Download` only when done. */
const rowOf = (job: ExportJob): string[] => [
  job.job_id,
  job.format,
  job.state,
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

/** The DOM model of the list of `jobs` on its only page, with an empty queue form. */
function listModel(jobs: readonly ExportJob[]): DomModel {
  const done = jobs.filter((job) => job.state === 'done');
  return {
    title: '',
    headings: ['Export Jobs'],
    labels: ['Definition ID', 'Format', 'As Of'],
    controls: [
      control({ name: 'definitionId' }),
      FORMAT_CONTROL,
      control({ name: 'asOf', type: 'date' }),
      control({ name: 'csrf_token', type: 'hidden', value: CSRF_PAIR.token }),
      control({ name: 'csrf_token_expires', type: 'hidden', value: CSRF_PAIR.expires }),
      ...done.map((job) => control({ name: 'jobId', type: 'hidden', value: job.job_id })),
    ],
    buttons: [
      { text: 'Queue Export', type: 'submit', hasOnclick: false },
      ...done.map(() => ({ text: 'Download', type: 'submit', hasOnclick: false })),
    ],
    links: [],
    tables: jobs.length === 0 ? [] : [{ headers: HEADERS, rows: jobs.map(rowOf) }],
    alerts: [],
  };
}

/** The tenant-a reporting exporter on reporting/exports. */
function exporterRequest(rc: Readonly<Record<string, string>> = {}): AdminRequest {
  return opt2RoleRequest(Roles.reportingExporter, { circuit: 'reporting', item: 'exports', rc });
}

/** A gateway answering the list with `body` and issuing CSRF pairs. */
function listGateway(body: unknown = { data: exportJobs, total: exportJobs.length }): FakeGatewayClient {
  return fakeGatewayClient({ ...shellAndCsrfRoutes('tenant-a'), [LIST_ROUTE]: { status: 200, body } });
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
    it("reads the token tenant's first page and issues the queue form's CSRF pair", async () => {
      const gateway = listGateway();

      const data = await loadExports(contextFor(exporterRequest(), gateway));

      expect(data).toEqual({ jobs: exportJobs, total: exportJobs.length, page: 1 });
      expect(gateway.calls).toHaveLength(2);
      expect(gateway.calls).toEqual(
        expect.arrayContaining([
          { service: 'reporting', method: 'GET', path: LIST_PATH, query: { page: '1', pageSize: String(PAGE_SIZE) } },
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

    it.each([
      { status: 401, type: GatewayDenialError },
      { status: 403, type: GatewayDenialError },
      { status: 400, type: Error },
      { status: 500, type: Error },
    ])('rejects with $type.name when reporting answers $status', async ({ status, type }) => {
      const gateway = fakeGatewayClient({ ...shellAndCsrfRoutes('tenant-a'), [LIST_ROUTE]: { status, body: {} } });

      const failure = await loadExports(contextFor(exporterRequest(), gateway)).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(type);
      expect(failure).toMatchObject({ message: `listExports answered HTTP ${status}` });
    });

    it.each([
      { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
      {
        outage: 'a 503 answer',
        arrange: (gateway: FakeGatewayClient) => gateway.setRoute(LIST_ROUTE, { status: 503, body: {} }),
      },
    ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
      const gateway = listGateway();
      arrange(gateway);

      await expect(loadExports(contextFor(exporterRequest(), gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
    });
  });

  describe('exportsBody', () => {
    it('renders every job with its state and a Download button for each done job', async () => {
      const body = await renderedBody({ jobs: exportJobs, total: exportJobs.length, page: 1 });

      expect(fragmentModel(body)).toEqual(listModel(exportJobs));
      expect(DONE_JOBS.map((job) => job.job_id)).toEqual([
        REPORTING_IDS.jobDoneXlsx,
        REPORTING_IDS.jobDoneCsv,
        REPORTING_IDS.jobDonePdf,
      ]);
      const $ = cheerio.load(body, null, false);
      const downloads = $('td form').toArray().map((el) => ({
        action: $(el).attr('action'),
        method: $(el).attr('method'),
        fields: $(el).find('input').toArray().map((input) => [$(input).attr('name'), $(input).attr('value')]),
      }));
      expect(downloads).toEqual(
        DONE_JOBS.map((job) => ({
          action: '/opt2/admin-actions/reporting/download?siteid=tenant-a',
          method: 'post',
          fields: [['jobId', job.job_id]],
        })),
      );
    });

    it('posts the queue form to the queue action with the CSRF pair, in legacy admin classes only', async () => {
      const body = await renderedBody({ jobs: exportJobs, total: exportJobs.length, page: 1 });
      const $ = cheerio.load(body, null, false);

      expect($('form[name="form1"]').attr('action')).toBe('/opt2/admin-actions/reporting/queue?siteid=tenant-a');
      expect($('form[name="form1"]').attr('method')).toBe('post');
      expect($('form[name="form1"] input[type="hidden"]').toArray().map((el) => $(el).attr('name'))).toEqual([
        'csrf_token',
        'csrf_token_expires',
      ]);
      expect(body.startsWith('<div class="mura-header"><h1>Export Jobs</h1></div>')).toBe(true);
      expect($('table').attr('class')).toBe('mura-table-grid');
      expect($('style, link, script').length).toBe(0);
    });

    it('shows the empty-list message when the tenant has no jobs', async () => {
      const body = await renderedBody({ jobs: [], total: 0, page: 1 });

      expect(fragmentModel(body)).toEqual(listModel([]));
      expect(body).toContain('<div class="help-block-empty">There are no export jobs.</div>');
    });

    it.each([
      { page: 1, total: 120, links: [{ href: '/opt2/admin/reporting/exports?siteid=tenant-a&page=2', text: 'Next' }] },
      {
        page: 2,
        total: 120,
        links: [
          { href: '/opt2/admin/reporting/exports?siteid=tenant-a&page=1', text: 'Previous' },
          { href: '/opt2/admin/reporting/exports?siteid=tenant-a&page=3', text: 'Next' },
        ],
      },
      { page: 3, total: 120, links: [{ href: '/opt2/admin/reporting/exports?siteid=tenant-a&page=2', text: 'Previous' }] },
      { page: 2, total: 100, links: [{ href: '/opt2/admin/reporting/exports?siteid=tenant-a&page=1', text: 'Previous' }] },
      { page: 1, total: 50, links: [] },
    ])('links page $page of $total jobs to its neighbours', async ({ page, total, links }) => {
      const body = await renderedBody({ jobs: exportJobs, total, page });

      expect(fragmentModel(body).links).toEqual(links);
      expect(body.includes('<ul class="pagination">')).toBe(links.length > 0);
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
      const $ = cheerio.load(toString(exportsBody(ctx, { jobs: exportJobs, total: 120, page: 2 })), null, false);

      const targets = [
        ...$('form').toArray().map((el) => $(el).attr('action')),
        ...$('a').toArray().map((el) => $(el).attr('href')),
      ];
      expect(targets).toHaveLength(1 + DONE_JOBS.length + 2);
      for (const target of targets) expect(target).toMatch(/\?siteid=tenant\+b%26c(&page=[13])?$/);
    });

    it('encodes service values instead of emitting them as markup', async () => {
      const hostile = { ...exportJobs[0], error: '<img src=x onerror=alert(1)>' } as unknown as ExportJob;

      const body = await renderedBody({ jobs: [hostile], total: 1, page: 1 });
      const $ = cheerio.load(body, null, false);

      expect($('img').length).toBe(0);
      expect($('td').eq(6).text()).toBe('<img src=x onerror=alert(1)>');
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
      expect(model.tables).toEqual(normaliseIds(fragmentModel(toString(view.body))).tables);
    });
  });
});
