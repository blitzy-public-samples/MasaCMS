// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate } from '@/lib/access-gate';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { findOpt2Action, type Opt2ActionDefinition, type ScreenContext, type SubmitResult } from '@/screens/registry';
import { reportingActions, reportingScreens } from '@/screens/opt2/reporting';
import { exportsBody, exportsScreen, type ExportsData, type QueuePosted } from '@/screens/opt2/reporting/exports';
import { alertBox, noAccessUrl, opt2View } from '@/screens/opt2/shared';
import { loadShellData, renderAdminDocument, serializeAdminDocument, type ShellView } from '@/shell/document';
import { REPORTING_IDS, createExportInvalid, exportJobs } from '../../fixtures/opt2/reporting';
import { makeAdminRequest, opt2RoleRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const LIST_PATH = '/v1/reporting/exports';
const LIST_ROUTE = routeKey('GET', 'reporting', LIST_PATH);
const QUEUE_ROUTE = routeKey('POST', 'reporting', LIST_PATH);
const downloadRoute = (id: string): string => routeKey('GET', 'reporting', `${LIST_PATH}/${id}/download-url`);

/** The reporting post action the admin-actions route serves for `slug`. */
function registeredAction(slug: string): Opt2ActionDefinition {
  const def = findOpt2Action('reporting', slug);
  if (def === undefined) throw new Error(`reporting registers no ${slug} action`);
  return def;
}

const queueAction = registeredAction('queue');
const downloadAction = registeredAction('download');

const LISTED: ExportsData = { jobs: exportJobs, total: exportJobs.length, page: 1 };

const POSTED: QueuePosted = {
  definitionId: REPORTING_IDS.definitionTimesheetStatus,
  format: 'csv',
  asOf: '2026-06-30',
};

/** Exact legacy admin class names the module markup may use, beside the `block`, `btn-` and `alert-` families. */
const LEGACY_CLASSES: ReadonlySet<string> = new Set([
  'mura-header',
  'nav-module-specific',
  'mura-table-grid',
  'btn',
  'alert',
  'var-width',
  'help-block-empty',
  'mura-control-group',
  'mura-primary',
  'mura-actions',
  'form-actions',
  // The list's Previous/Next, as admin/core/views/cusers/inc/dsp_nextn.cfm pages a list.
  'pagination',
]);
const LEGACY_CLASS_FAMILIES: readonly RegExp[] = [/^block(-|$)/, /^btn-/, /^alert-/];

const isLegacyClass = (name: string): boolean =>
  LEGACY_CLASSES.has(name) || LEGACY_CLASS_FAMILIES.some((family) => family.test(name));

/** Distinct class tokens under `#mura-content`, in document order. */
function moduleClasses(page: string): string[] {
  const $ = cheerio.load(page);
  const names = $('#mura-content [class]')
    .toArray()
    .flatMap((el) => ($(el).attr('class') ?? '').split(/\s+/));
  return [...new Set(names.filter((name) => name !== ''))];
}

/** The tenant-a reporting exporter on reporting/`item`. */
function exporter(item: string, rc: Readonly<Record<string, string>> = {}): AdminRequest {
  return opt2RoleRequest(Roles.reportingExporter, { circuit: 'reporting', item, rc });
}

/** Screen context of `req` over a gateway answering the shell, every job on one page, then `routes`. */
function ctxFor(req: AdminRequest, routes: FakeRouteTable = {}): ScreenContext & { gateway: FakeGatewayClient } {
  const listed: FakeReply = { status: 200, body: { data: exportJobs, total: exportJobs.length } };
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [LIST_ROUTE]: listed, ...routes }) });
}

/** reporting's legacy error envelope at `status` with `message`. */
const refusal = (status: number, message: string): FakeReply => ({
  status,
  body: { apiversion: 'v1', method: 'invalid', error: { message, code: 'invalid_request' } },
});

/** The view of a `render` outcome; throws for any other outcome. */
function viewOf(result: SubmitResult): ShellView {
  if (result.kind !== 'render') throw new Error(`Expected a re-render, got ${result.kind}`);
  return result.view;
}

/** The export job list served in the full layout. */
async function screenPage(ctx: ScreenContext): Promise<string> {
  const page = await renderScreenPage(exportsScreen, ctx);
  if (page.kind !== 'document') throw new Error(`The list redirected to ${page.location}`);
  return page.html;
}

/** A re-rendered action outcome in the full layout. */
async function actionPage(ctx: ScreenContext, result: SubmitResult): Promise<string> {
  const shell = await loadShellData(ctx.req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
  return serializeAdminDocument(renderAdminDocument(ctx.req, viewOf(result), ctx.hooks, shell));
}

interface RefusalCase {
  readonly name: string;
  readonly def: Opt2ActionDefinition;
  readonly status: number;
  readonly message: string;
  readonly rc: Readonly<Record<string, string>>;
  readonly route: string;
  readonly posted?: QueuePosted;
}

const queueRefusal = (status: number, message: string): RefusalCase => ({
  name: 'queue',
  def: queueAction,
  status,
  message,
  rc: { ...POSTED },
  route: QUEUE_ROUTE,
  posted: POSTED,
});

const downloadRefusal = (status: number, message: string): RefusalCase => ({
  name: 'download',
  def: downloadAction,
  status,
  message,
  rc: { jobId: REPORTING_IDS.jobRunningXlsx },
  route: downloadRoute(REPORTING_IDS.jobRunningXlsx),
});

/** The alert statuses each operation's contract declares, with the messages reporting answers them with. */
const REFUSALS: readonly RefusalCase[] = [
  queueRefusal(400, 'Invalid parameters'),
  queueRefusal(403, 'Insufficient Account Permissions'),
  queueRefusal(404, 'Not Found'),
  downloadRefusal(400, 'Invalid parameters'),
  downloadRefusal(403, 'Insufficient Account Permissions'),
  downloadRefusal(404, 'Not Found'),
  downloadRefusal(409, 'not-ready'),
];

describe('reporting screens', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  describe('legacy admin classes', () => {
    it.each([
      {
        state: 'a paged job list',
        marker: 'pagination',
        page: () =>
          screenPage(
            ctxFor(exporter('exports', { page: '2' }), {
              [LIST_ROUTE]: { status: 200, body: { data: exportJobs, total: 120 } },
            }),
          ),
      },
      {
        state: 'an empty job list',
        marker: 'help-block-empty',
        page: () =>
          screenPage(ctxFor(exporter('exports'), { [LIST_ROUTE]: { status: 200, body: { data: [], total: 0 } } })),
      },
      {
        state: 'a refused queue',
        marker: 'alert-error',
        page: async () => {
          const ctx = ctxFor(exporter('queue', { ...POSTED }), { [QUEUE_ROUTE]: createExportInvalid });
          return actionPage(ctx, await queueAction.submit(ctx));
        },
      },
    ])('builds $state from legacy admin classes only', async ({ marker, page }) => {
      const classes = moduleClasses(await page());

      expect(classes).toEqual(expect.arrayContaining(['mura-header', 'mura-control-group', marker]));
      expect(classes.filter((name) => !isLegacyClass(name))).toEqual([]);
    });
  });

  describe('request values', () => {
    const ROLE_LIKE_RC = { roles: Roles.reportingExporter, role: Roles.reportingExporter, s2: 'true' };

    it.each([
      ...reportingScreens.map((def) => ({ key: `screen ${def.screen}`, gate: def.gate })),
      ...reportingActions.map((def) => ({ key: `action ${def.action}`, gate: def.gate })),
    ])('grant no role to $key', async ({ gate }) => {
      const req = makeAdminRequest(
        { circuit: 'reporting', item: 'exports', session: { siteid: 'tenant-a' }, rc: ROLE_LIKE_RC },
        'systemUser',
      );

      expect(req.rc).toMatchObject(ROLE_LIKE_RC);
      expect(req.user?.roles).toEqual([Roles.systemUser]);
      await expect(runGate(req, gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
    });
  });

  describe('service refusals', () => {
    it.each(REFUSALS)("re-renders the list with reporting's $status message on $name", async (refused) => {
      const ctx = ctxFor(exporter(refused.def.action, refused.rc), {
        [refused.route]: refusal(refused.status, refused.message),
      });

      const view = viewOf(await refused.def.submit(ctx));

      const alert = alertBox(refused.message);
      const options = refused.posted === undefined ? { alert } : { alert, posted: refused.posted };
      const expected = opt2View('reporting', exportsBody(ctx, LISTED, options));
      // SafeHtml keeps its markup in a private field, which toEqual cannot see.
      expect(view.opt2Module).toBe(expected.opt2Module);
      expect(String(view.body)).toBe(String(expected.body));
      expect(fragmentModel(String(view.body)).alerts).toEqual([
        { text: refused.message, className: 'alert alert-error' },
      ]);
    });
  });

  describe('gateway outage', () => {
    it.each<Pick<RefusalCase, 'name' | 'def' | 'rc'>>([
      { name: 'queue', def: queueAction, rc: { ...POSTED } },
      { name: 'download', def: downloadAction, rc: { jobId: REPORTING_IDS.jobDoneCsv } },
    ])('rejects $name with GatewayUnavailableError after the one refused call', async ({ def, rc }) => {
      const ctx = ctxFor(exporter(def.action, rc));
      ctx.gateway.failWith();

      await expect(def.submit(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
      expect(ctx.gateway.calls).toHaveLength(1);
    });
  });
});
