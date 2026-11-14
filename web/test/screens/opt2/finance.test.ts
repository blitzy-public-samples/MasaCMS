// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { load } from 'cheerio';
import { Roles, type Role } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { financeActions, financeScreens } from '@/screens/opt2/finance';
import { noAccessUrl, opt2ActionUrl, opt2ScreenUrl } from '@/screens/opt2/shared';
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '@/screens/registry';
import {
  financeAnswers,
  financeRecordDetail,
  financeRecords,
  financeTransitionLegal,
} from '../../fixtures/opt2/finance';
import { opt2RoleRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type FakeRouteTable } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry module loads every circuit; these pages render with the only shell hooks they read.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SITE = TENANT_A.siteId;
const PREPARER: Role = Roles.financePreparer;
const APPROVER: Role = Roles.financeApprover;
const RECORD_ID = financeRecordDetail.record_id;
const RECORD_PATH: `/${string}` = `/v1/finance/records/${RECORD_ID}`;
const LIST_ROUTE = routeKey('GET', 'finance', '/v1/finance/records');
const ROLLUPS_ROUTE = routeKey('GET', 'finance', '/v1/finance/rollups');
const recordRoute = (id: string): string => routeKey('GET', 'finance', `/v1/finance/records/${id}`);

/** Request parameters naming finance roles and S2, as a forged post would carry them. */
const CLAIMED_IN_RC: Readonly<Record<string, string>> = Object.freeze({
  roles: `${PREPARER},${APPROVER}`,
  role: PREPARER,
  s2: '1',
});

/** Exact legacy admin classes; `pagination` is the legacy admin pager's (admin/core/views/cusers/inc/dsp_nextn.cfm). */
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
  'pagination',
]);

const LEGACY_CLASS_PATTERNS: readonly RegExp[] = [/^block(-|$)/, /^btn-/, /^alert-/];

const isLegacyClass = (name: string): boolean =>
  LEGACY_CLASSES.has(name) || LEGACY_CLASS_PATTERNS.some((pattern) => pattern.test(name));

/** Class tokens of `#mura-content` and its descendants, the shell left out. */
function moduleClasses(html: string): string[] {
  const $ = load(html);
  return $('#mura-content')
    .find('[class]')
    .addBack('[class]')
    .toArray()
    .flatMap((element) => ($(element).attr('class') ?? '').split(/\s+/).filter((name) => name !== ''));
}

/** The tenant-a request of `role`'s subject, its token holding `roles`, with `rc` laid over its context. */
function request(role: Role, rc: Readonly<Record<string, string>> = {}, roles: readonly Role[] = [role]): AdminRequest {
  return opt2RoleRequest(role, { rc: { siteid: SITE, ...rc }, user: { roles: [Roles.systemUser, ...roles] } });
}

/** A screen context of `req` over the finance fixture answers, `routes` replacing any of them. */
function ctxFor(req: AdminRequest, routes: FakeRouteTable = {}) {
  const gateway = fakeGatewayClient({ ...financeAnswers, ...routes });
  return { ctx: makeScreenContext({ req, gateway }), gateway };
}

function screen(name: string): Opt2ScreenDefinition {
  const def = financeScreens.find((candidate) => candidate.screen === name);
  if (def === undefined) throw new TypeError(`finance/${name} is not registered`);
  return def;
}

function action(name: string): Opt2ActionDefinition {
  const def = financeActions.find((candidate) => candidate.action === name);
  if (def === undefined) throw new TypeError(`finance/${name} is not registered`);
  return def;
}

/** The admin document of `def` for `req`; throws when the gate or a denial redirects. */
async function documentOf(def: Opt2ScreenDefinition, req: AdminRequest, routes: FakeRouteTable = {}): Promise<string> {
  const page = await renderScreenPage(def, ctxFor(req, routes).ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return page.html;
}

const financeError = (status: number, message: string): FakeReply => ({
  status,
  body: { apiversion: 'v1', method: 'finance.records', error: { code: 'invalid_request', message } },
});

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => restore());

// List and detail models, action outcomes and role gates are pinned in ./finance/*.test.ts and umbrella.test.ts.
describe('finance screens', () => {
  it.each([
    ['the paged record list', 'records', () => request(PREPARER, { page: '2' }), {
      [LIST_ROUTE]: { status: 200, body: { data: financeRecords, total: 120 } },
    }],
    ['an empty record list', 'records', () => request(APPROVER), {
      [LIST_ROUTE]: { status: 200, body: { data: [], total: 0 } },
      [ROLLUPS_ROUTE]: { status: 200, body: { data: [] } },
    }],
    ['a record list finance refused', 'records', () => request(PREPARER), {
      [LIST_ROUTE]: financeError(400, 'Bad Request'),
      [ROLLUPS_ROUTE]: financeError(400, 'Bad Request'),
    }],
    [
      'a record with every button and form',
      'record',
      () => request(PREPARER, { id: RECORD_ID }, [PREPARER, APPROVER]),
      {},
    ],
    ['a record finance does not know', 'record', () => request(PREPARER, { id: RECORD_ID }), {
      [recordRoute(RECORD_ID)]: financeError(404, 'Not Found'),
    }],
  ])('builds %s from legacy admin classes only', async (_, name, req, routes) => {
    const classes = moduleClasses(await documentOf(screen(name), req(), routes));

    expect(classes.length).toBeGreaterThan(0);
    expect(classes.filter((token) => !isLegacyClass(token))).toEqual([]);
  });

  // Buttons follow the token's roles in every state: finance's transition table alone decides legality (409).
  it.each(
    financeRecords
      .filter(({ state }) => state !== financeRecordDetail.state)
      .flatMap(({ record_id, state }) => [
        {
          state,
          record_id,
          role: PREPARER,
          labels: ['Submit', 'Resubmit', 'Upload', 'Save'],
          actions: ['submit', 'resubmit'],
        },
        { state, record_id, role: APPROVER, labels: ['Approve', 'Reject'], actions: ['approve', 'reject'] },
      ]),
  )('offers $role the buttons of its role in state $state', async (row) => {
    const detail = { ...financeRecordDetail, record_id: row.record_id, state: row.state };
    const $ = load(
      await documentOf(screen('record'), request(row.role, { id: row.record_id }), {
        [recordRoute(row.record_id)]: { status: 200, body: { data: detail } },
      }),
    );

    expect($('#mura-content button').toArray().map((button) => $(button).text())).toEqual(row.labels);
    expect($('#mura-content .btn-group form').toArray().map((form) => $(form).attr('action'))).toEqual(
      row.actions.map((name) => opt2ActionUrl('finance', name, { siteid: SITE, id: row.record_id })),
    );
  });
});

describe('finance roles come from the user token only', () => {
  it.each([
    ...financeScreens.map((def) => [`screen ${def.screen}`, def.gate] as const),
    ...financeActions.map((def) => [`action ${def.action}`, def.gate] as const),
  ])('sends a user claiming finance roles in rc to no-access at %s', async (_, gate) => {
    const req = request(Roles.timesheetsEmployee, { id: RECORD_ID, ...CLAIMED_IN_RC });

    await expect(runGate(req, gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
  });

  it('keeps the upload from an approver claiming the preparer role in rc', async () => {
    const req = request(APPROVER, { id: RECORD_ID, ...CLAIMED_IN_RC });

    await expect(runGate(req, action('upload').gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
  });

  it.each([
    ['an approver', APPROVER, ['Approve', 'Reject']],
    ['a token without finance roles', Roles.timesheetsEmployee, []],
  ])('renders the record for %s with its token buttons and no preparer form', async (_, role, buttons) => {
    const { ctx } = ctxFor(request(role, { id: RECORD_ID, ...CLAIMED_IN_RC }));
    const def = screen('record');
    const $ = load(String((await def.render(ctx, await def.load(ctx))).body), null, false);

    expect($('button').toArray().map((button) => $(button).text())).toEqual(buttons);
    expect($('form[enctype], input[name="title"]')).toHaveLength(0);
  });
});

describe('finance actions', () => {
  const SUBMIT_PATH: `/${string}` = `${RECORD_PATH}/transitions/submit`;
  const DETAIL = opt2ScreenUrl('finance', 'record', { siteid: SITE, id: RECORD_ID });

  it.each([
    ['no CSRF pair', {}, undefined],
    ['an empty token', { [CSRF_FIELD_TOKEN]: '', [CSRF_FIELD_EXPIRES]: FIXED_CSRF.expires }, undefined],
    [
      'a token without its expiry',
      { [CSRF_FIELD_TOKEN]: FIXED_CSRF.token },
      { 'x-csrf_token': FIXED_CSRF.token, 'x-csrf_token_expires': '' },
    ],
  ])('relays %s to finance as the posted CSRF headers', async (_, posted, headers) => {
    const { ctx, gateway } = ctxFor(request(PREPARER, { id: RECORD_ID, ...posted }), {
      [routeKey('POST', 'finance', SUBMIT_PATH)]: { status: 200, body: financeTransitionLegal },
    });

    await expect(action('submit').submit(ctx)).resolves.toEqual({ kind: 'location', location: DETAIL });
    expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([
      { service: 'finance', method: 'POST', path: SUBMIT_PATH, ...(headers === undefined ? {} : { headers }) },
    ]);
  });

  it('asks finance for a download naming no attachment and shows its refusal', async () => {
    const emptyAid: `/${string}` = `${RECORD_PATH}/attachments//download-url`;
    const { ctx, gateway } = ctxFor(request(APPROVER, { id: RECORD_ID }), {
      [routeKey('GET', 'finance', emptyAid)]: financeError(404, 'Not Found'),
    });
    const result = await action('download').submit(ctx);
    if (result.kind !== 'render') throw new Error(`Expected a re-render, got ${result.kind}`);
    const $ = load(String(result.view.body), null, false);

    expect(gateway.calls.filter(({ service }) => service === 'finance').map(({ path }) => path)).toEqual([
      emptyAid,
      RECORD_PATH,
    ]);
    expect(result.view.opt2Module).toBe('finance');
    expect($('.alert').text()).toBe('Not Found');
  });
});
