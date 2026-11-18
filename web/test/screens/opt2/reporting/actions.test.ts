// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
// reporting queue and download actions: the write or URL issuance through reporting's /v1 API, then the hand-off.
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { SubmitResult } from '@/screens/registry';
import { downloadAction, queueAction, submitDownload, submitQueue } from '@/screens/opt2/reporting/actions';
import { EXPORTER_ROLES } from '@/screens/opt2/reporting/exports';
import { noAccessUrl } from '@/screens/opt2/shared';
import {
  REPORTING_IDS,
  createExportAccepted,
  createExportInvalid,
  exportDefinitionSummaries,
  exportDownloadUrls,
  exportJobs,
} from '../../../fixtures/opt2/reporting';
import { editorRequest, opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../../helpers/fake-gateway';
import { CSRF_PAIR, DEFINITIONS_ROUTE, LIST_PATH, LIST_ROUTE, contextFor, jobValues, shellAndCsrfRoutes } from './support';

const QUEUE_ROUTE = routeKey('POST', 'reporting', LIST_PATH);
const downloadPath = (id: string): `/${string}` => `${LIST_PATH}/${id}/download-url`;
const downloadRoute = (id: string): string => routeKey('GET', 'reporting', downloadPath(id));

const LIST_LOCATION: SubmitResult = { kind: 'location', location: '/opt2/admin/reporting/exports?siteid=tenant-a' };

const POSTED_CSRF = { csrf_token: CSRF_PAIR.token, csrf_token_expires: CSRF_PAIR.expires } as const;
const CSRF_HEADERS = {
  [CSRF_HEADER_TOKEN.toLowerCase()]: CSRF_PAIR.token,
  [CSRF_HEADER_EXPIRES.toLowerCase()]: CSRF_PAIR.expires,
};

const envelope = (status: number, message: string): FakeReply => ({
  status,
  body: { apiversion: 'v1', method: 'reporting.exports', error: { message, code: 'invalid_request' } },
});

/** The tenant-a reporting exporter posting `rc` to reporting/`action`. */
function exporterPost(action: string, rc: Readonly<Record<string, string>>): AdminRequest {
  return opt2RoleRequest(Roles.reportingExporter, { circuit: 'reporting', item: action, rc });
}

/** A gateway serving the list, definitions, CSRF and shell routes plus `routes`. */
function gatewayWith(routes: Readonly<Record<string, FakeReply>>): FakeGatewayClient {
  return fakeGatewayClient({
    ...shellAndCsrfRoutes('tenant-a'),
    [LIST_ROUTE]: { status: 200, body: { data: exportJobs, total: exportJobs.length } },
    [DEFINITIONS_ROUTE]: { status: 200, body: { data: exportDefinitionSummaries } },
    ...routes,
  });
}

/** The body of a `render` outcome as markup; throws for any other outcome. */
function renderedBody(result: SubmitResult): string {
  if (result.kind !== 'render') throw new Error(`Expected a re-render, got ${result.kind}`);
  expect(result.view.opt2Module).toBe('reporting');
  return toString(result.view.body);
}

describe('reporting actions', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it.each([
    { definition: queueAction, action: 'queue', submit: submitQueue },
    { definition: downloadAction, action: 'download', submit: submitDownload },
  ])('registers $action as a frozen reporting action on the exporter role', ({ definition, action, submit }) => {
    expect(definition).toMatchObject({ module: 'reporting', action, roles: EXPORTER_ROLES, service: 'reporting', submit });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it.each([
    { action: 'queue', gate: queueAction.gate },
    { action: 'download', gate: downloadAction.gate },
  ])('admits only the exporter to $action', async ({ gate }) => {
    await expect(runGate(exporterPost('x', {}), gate)).resolves.toEqual({ kind: 'allow' });
    await expect(runGate(editorRequest(), gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
    await expect(runGate(opt2RoleRequest(Roles.surveysManager), gate)).resolves.toEqual({
      kind: 'redirect',
      location: noAccessUrl(),
    });
  });

  describe('queue', () => {
    const POSTED = { definitionId: REPORTING_IDS.definitionTimesheetStatus, format: 'xlsx', asOf: '2026-06-30' };

    it('queues the posted export with the CSRF pair as headers, then returns to the list', async () => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: { status: 200, body: createExportAccepted } });

      const result = await submitQueue(contextFor(exporterPost('queue', { ...POSTED, ...POSTED_CSRF }), gateway));

      expect(result).toEqual(LIST_LOCATION);
      expect(gateway.calls).toEqual([
        { service: 'reporting', method: 'POST', path: LIST_PATH, json: POSTED, headers: CSRF_HEADERS },
      ]);
    });

    it.each([
      { case: 'an empty as-of date', rc: { ...POSTED, asOf: '' } },
      { case: 'no as-of date', rc: { definitionId: POSTED.definitionId, format: POSTED.format } },
    ])('leaves asOf out for $case, so reporting takes today', async ({ rc }) => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: { status: 200, body: createExportAccepted } });

      await expect(submitQueue(contextFor(exporterPost('queue', rc), gateway))).resolves.toEqual(LIST_LOCATION);
      expect(gateway.calls).toEqual([
        {
          service: 'reporting',
          method: 'POST',
          path: LIST_PATH,
          json: { definitionId: POSTED.definitionId, format: POSTED.format },
        },
      ]);
    });

    it('forwards absent fields as empty values for reporting to reject', async () => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: { status: 404, body: envelope(404, 'Not Found').body } });

      const body = renderedBody(await submitQueue(contextFor(exporterPost('queue', {}), gateway)));

      expect(gateway.calls[0]).toEqual({
        service: 'reporting',
        method: 'POST',
        path: LIST_PATH,
        json: { definitionId: '', format: '' },
      });
      expect(fragmentModel(body).alerts).toEqual([{ text: 'Not Found', className: 'alert alert-error' }]);
    });

    it('re-renders the list with reporting\'s 400 alert and the posted values in the form', async () => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: createExportInvalid });
      const posted = { ...POSTED, format: 'docx' };

      const body = renderedBody(await submitQueue(contextFor(exporterPost('queue', { ...posted, ...POSTED_CSRF }), gateway)));
      const model = fragmentModel(body);

      expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
      expect(model.controls.slice(0, 3).map(({ name, value }) => [name, value])).toEqual([
        ['definitionId', posted.definitionId],
        ['format', ''],
        ['asOf', posted.asOf],
      ]);
      expect(jobValues(body)).toHaveLength(exportJobs.length);
      expect(gateway.calls.map(({ service, method, path }) => `${service} ${method} ${path}`).sort()).toEqual([
        'identity POST /v1/csrf/tokens',
        'reporting GET /v1/reporting/definitions',
        'reporting GET /v1/reporting/exports',
        'reporting POST /v1/reporting/exports',
      ]);
    });

    it.each([
      { field: 'definitionId', index: 0, value: REPORTING_IDS.definitionFinanceRecords },
      { field: 'format', index: 1, value: 'pdf' },
    ])('keeps a posted $field selected on re-render', async ({ field, index, value }) => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: envelope(404, 'Not Found') });

      const body = renderedBody(await submitQueue(contextFor(exporterPost('queue', { ...POSTED, [field]: value }), gateway)));

      expect(fragmentModel(body).controls[index]).toMatchObject({ name: field, value, selected: [value] });
    });

    it('selects no definition for a posted id no option holds, never emitting it as markup', async () => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: createExportInvalid });
      const hostile = '"><script>alert(1)</script>';

      const body = renderedBody(await submitQueue(contextFor(exporterPost('queue', { ...POSTED, definitionId: hostile }), gateway)));
      const $ = cheerio.load(body, null, false);

      expect($('script').length).toBe(0);
      expect($('#definitionId option').toArray().map((el) => $(el).attr('value'))).toEqual(
        exportDefinitionSummaries.map((definition) => definition.definition_id),
      );
      expect($('#definitionId option[selected]').length).toBe(0);
      expect(body).not.toContain('alert(1)');
    });

    it('posts a typed as-of date unchanged and re-renders it in the legacy-styled text input on refusal', async () => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: createExportInvalid });
      const typed = { ...POSTED, asOf: '06/30/2026' };

      const body = renderedBody(await submitQueue(contextFor(exporterPost('queue', { ...typed, ...POSTED_CSRF }), gateway)));
      const $ = cheerio.load(body, null, false);

      expect(gateway.calls.find(({ method, path }) => method === 'POST' && path === LIST_PATH)?.json).toEqual(typed);
      expect($('label[for="asOf"]').text()).toBe('As Of (yyyy-mm-dd)');
      expect($('label[for="asOf"] + #asOf').attr()).toEqual({
        name: 'asOf',
        id: 'asOf',
        type: 'text',
        value: typed.asOf,
        maxlength: '10',
      });
    });

    it.each([
      { status: 401, type: GatewayDenialError },
      { status: 503, type: GatewayUnavailableError },
      { status: 500, type: Error },
    ])('rejects with $type.name when reporting answers $status', async ({ status, type }) => {
      const gateway = gatewayWith({ [QUEUE_ROUTE]: { status, body: {} } });

      await expect(submitQueue(contextFor(exporterPost('queue', POSTED), gateway))).rejects.toBeInstanceOf(type);
    });
  });

  describe('download', () => {
    it("redirects to the done job's signed URL, never fetching the file", async () => {
      const id = REPORTING_IDS.jobDoneXlsx;
      const signed = exportDownloadUrls[id];
      const gateway = gatewayWith({ [downloadRoute(id)]: { status: 200, body: { data: signed } } });

      const result = await submitDownload(contextFor(exporterPost('download', { jobId: id, ...POSTED_CSRF }), gateway));

      expect(result).toEqual({ kind: 'location', location: signed?.url });
      expect(gateway.calls).toEqual([{ service: 'reporting', method: 'GET', path: downloadPath(id) }]);
    });

    it.each([
      { case: "a job that is not done (reporting's 409)", reply: envelope(409, 'not-ready'), alert: 'not-ready' },
      { case: 'an unknown job', reply: envelope(404, 'Not Found'), alert: 'Not Found' },
    ])('re-renders the list with the alert for $case', async ({ reply, alert }) => {
      const id = REPORTING_IDS.jobRunningXlsx;
      const gateway = gatewayWith({ [downloadRoute(id)]: reply });

      const body = renderedBody(await submitDownload(contextFor(exporterPost('download', { jobId: id }), gateway)));
      const model = fragmentModel(body);

      expect(model.alerts).toEqual([{ text: alert, className: 'alert alert-error' }]);
      expect(model.controls.slice(0, 3).map(({ value }) => value)).toEqual(['', '', '']);
      expect(jobValues(body)).toHaveLength(exportJobs.length);
    });

    it.each(['..', '../x', '../../x', 'abc'])(
      're-renders the list for the malformed job id %j with the invalid-parameters alert, issuing no URL',
      async (jobId) => {
        const gateway = gatewayWith({});

        const body = renderedBody(await submitDownload(contextFor(exporterPost('download', { jobId }), gateway)));

        expect(fragmentModel(body).alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
        expect(jobValues(body)).toHaveLength(exportJobs.length);
        expect(gateway.calls.filter(({ path }) => path.includes('download-url'))).toEqual([]);
      },
    );

    it('asks for an empty job id when none is posted', async () => {
      const gateway = gatewayWith({});

      const result = await submitDownload(contextFor(exporterPost('download', {}), gateway));

      expect(gateway.calls[0]).toEqual({ service: 'reporting', method: 'GET', path: downloadPath('') });
      expect(fragmentModel(renderedBody(result)).alerts).toHaveLength(1);
    });

    it.each([
      { status: 401, type: GatewayDenialError },
      { status: 502, type: GatewayUnavailableError },
      { status: 500, type: Error },
    ])('rejects with $type.name when reporting answers $status', async ({ status, type }) => {
      const id = REPORTING_IDS.jobDoneCsv;
      const gateway = gatewayWith({ [downloadRoute(id)]: { status, body: {} } });

      await expect(submitDownload(contextFor(exporterPost('download', { jobId: id }), gateway))).rejects.toBeInstanceOf(
        type,
      );
    });
  });
});
