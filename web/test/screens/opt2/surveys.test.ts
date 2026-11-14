// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import type { Opt2ActionDefinition, ScreenContext, SubmitResult } from '@/screens/registry';
import { alertBox, noAccessUrl, opt2ScreenUrl } from '@/screens/opt2/shared';
import { surveysScreens } from '@/screens/opt2/surveys';
import { scheduleAction, scheduleBody } from '@/screens/opt2/surveys/schedule';
import { bulkTargetAction, targetsBody } from '@/screens/opt2/surveys/targets';
import { SURVEY_IDS, surveyTargets, surveysAnswers } from '../../fixtures/opt2/surveys';
import { opt2RoleRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRouteTable } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SITE = 'tenant-a';
const MULTI = SURVEY_IDS.multiSiteSurvey;
const BULK_ROUTE = routeKey('POST', 'surveys', `/v1/surveys/${MULTI}/targets/bulk` as const);
const CSRF_POSTED = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
const ROLE_LIKE_RC = { roles: Roles.surveysManager, role: Roles.surveysManager };

/** A request of the tenant-a subject holding `role`, `rc` laid over the session site. */
const requestFor = (role: Role, rc: Record<string, string> = {}): AdminRequest =>
  opt2RoleRequest(role, { rc: { siteid: SITE, ...rc } });

const managerRequest = (rc: Record<string, string> = {}): AdminRequest => requestFor(Roles.surveysManager, rc);

/** The screen context of `req` over the surveys fixtures, `routes` replacing any of them. */
const ctxFor = (req: AdminRequest, routes: FakeRouteTable = {}): ScreenContext & { gateway: FakeGatewayClient } =>
  makeScreenContext({ req, gateway: fakeGatewayClient({ ...surveysAnswers, ...routes }) });

/** The surveys calls `gateway` received. */
const surveysCalls = (gateway: FakeGatewayClient) => gateway.calls.filter(({ service }) => service === 'surveys');

/** The DOM model of a re-rendered submit's body. */
function renderedModel(result: SubmitResult): DomModel {
  if (result.kind !== 'render') throw new Error(`The submit answered ${result.kind}, not a re-render`);
  return fragmentModel(String(result.view.body));
}

/** Every surveys fixture route answering 403. */
const refusedEverywhere: FakeRouteTable = Object.fromEntries(
  Object.keys(surveysAnswers).map((key) => [key, { status: 403 }]),
);

const ACTIONS: ReadonlyArray<{ action: string; def: Opt2ActionDefinition; rc: Record<string, string> }> = [
  { action: 'schedule', def: scheduleAction, rc: { launchAt: '2026-07-01T09:00:00', reminders: '1440' } },
  { action: 'bulk-target', def: bulkTargetAction, rc: { targets: 'tenant-b' } },
];

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('surveys screens in the shell', () => {
  it.each(surveysScreens.map((def) => ({ screen: def.screen, def })))(
    'renders $screen with the OPT-2 group open and only Surveys active',
    async ({ def }) => {
      const page = await renderScreenPage(def, ctxFor(managerRequest({ surveyid: MULTI })));

      if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
      const $ = load(page.html);
      expect($('#admin-nav-opt2').attr('class')).toBe('open');
      expect($('#admin-nav-opt2 > a').attr('class')).toBe('nav-submenu active');
      expect($('#admin-nav-opt2 ul a.active').toArray().map((el) => $(el).attr('href'))).toEqual([
        opt2ScreenUrl('surveys', 'surveys', { siteid: SITE }),
      ]);
    },
  );
});

// Surveys definitions carry no web gate: the service's answer to the token decides access.
describe('surveys access', () => {
  it.each(surveysScreens.map((def) => ({ screen: def.screen, def })))(
    'leaves $screen to the service when rc claims a role the token lacks',
    async ({ def }) => {
      const ctx = ctxFor(requestFor(Roles.financePreparer, { surveyid: MULTI, ...ROLE_LIKE_RC }), refusedEverywhere);

      const page = await renderScreenPage(def, ctx);

      expect(page).toEqual({ kind: 'redirect', location: noAccessUrl() });
      expect(surveysCalls(ctx.gateway).length).toBeGreaterThan(0);
      expect(JSON.stringify(surveysCalls(ctx.gateway))).not.toContain(Roles.surveysManager);
    },
  );

  it.each(ACTIONS)('leaves the $action action to the service when rc claims a role', async ({ def, rc }) => {
    const req = requestFor(Roles.financePreparer, { surveyid: MULTI, ...rc, ...CSRF_POSTED, ...ROLE_LIKE_RC });
    const ctx = ctxFor(req, refusedEverywhere);

    await expect(def.submit(ctx)).rejects.toMatchObject({ name: 'GatewayDenialError', status: 403 });
    expect(JSON.stringify(surveysCalls(ctx.gateway))).not.toContain(Roles.surveysManager);
  });
});

describe('surveys actions', () => {
  it.each(ACTIONS)('propagates an unreachable gateway from the $action action', async ({ def, rc }) => {
    const ctx = ctxFor(managerRequest({ surveyid: MULTI, ...rc, ...CSRF_POSTED }));
    ctx.gateway.failWith();

    await expect(def.submit(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it.each([
    {
      status: 403,
      body: { apiversion: 'v1', method: 'surveys.bulk', error: { message: 'Insufficient Account Permissions' } },
      alert: 'Insufficient Account Permissions',
    },
    { status: 404, body: undefined, alert: 'Not Found' },
    { status: 409, body: { apiversion: 'v1', method: 'surveys.bulk', error: { code: 'conflict' } }, alert: 'conflict' },
  ])('re-renders the readable survey with the posted lines under the $status alert', async ({ status, body, alert }) => {
    const text = ' tenant-a \ntenant-b, Editors';
    const ctx = ctxFor(managerRequest({ surveyid: MULTI, targets: text, ...CSRF_POSTED }), {
      [BULK_ROUTE]: { status, body },
    });

    const model = renderedModel(await bulkTargetAction.submit(ctx));

    expect(model.headings).toEqual(['Targets: Cross-program timesheet experience', 'Current Targets']);
    expect(model.alerts).toEqual([{ text: alert, className: 'alert alert-error' }]);
    expect(model.controls.find(({ name }) => name === 'targets')?.value).toBe(text);
    expect(model.tables[0]?.rows).toHaveLength(surveyTargets.length);
  });

  it('sends bulk targets without CSRF headers when no token was posted', async () => {
    const ctx = ctxFor(managerRequest({ surveyid: MULTI, targets: 'tenant-a\ntenant-b, Editors\n' }));

    const result = await bulkTargetAction.submit(ctx);

    expect(result).toEqual({
      kind: 'location',
      location: opt2ScreenUrl('surveys', 'targets', { siteid: SITE, surveyid: MULTI }),
    });
    expect(surveysCalls(ctx.gateway)).toMatchObject([
      {
        method: 'POST',
        path: `/v1/surveys/${MULTI}/targets/bulk`,
        json: { targets: [{ siteId: 'tenant-a' }, { siteId: 'tenant-b', groupName: 'Editors' }] },
      },
    ]);
    expect(surveysCalls(ctx.gateway)[0]?.headers).toBeUndefined();
  });
});

describe('surveys body helpers', () => {
  it('scheduleBody keeps posted reminders with no launch time', async () => {
    const body = await scheduleBody(ctxFor(managerRequest()), MULTI, { values: { reminders: '60' } });

    const controls = fragmentModel(String(body)).controls.slice(0, 2);
    expect(controls.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'launchAt', value: '' },
      { name: 'reminders', value: '60' },
    ]);
  });

  it('targetsBody without values holds an empty bulk form under the alert', async () => {
    const body = await targetsBody(ctxFor(managerRequest()), MULTI, { alert: alertBox('Rejected') });

    const model = fragmentModel(String(body));
    expect(model.alerts).toEqual([{ text: 'Rejected', className: 'alert alert-error' }]);
    expect(model.controls.find(({ name }) => name === 'targets')?.value).toBe('');
  });
});
