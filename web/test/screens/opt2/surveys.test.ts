// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { runGate, secure } from '@/lib/access-gate';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { Opt2ActionDefinition, ScreenContext, SubmitResult } from '@/screens/registry';
import { alertBox, noAccessUrl, opt2ScreenUrl } from '@/screens/opt2/shared';
import { surveysScreens } from '@/screens/opt2/surveys';
import { scheduleAction, scheduleBody } from '@/screens/opt2/surveys/schedule';
import { bulkTargetAction, targetsBody } from '@/screens/opt2/surveys/targets';
import {
  SURVEY_IDS,
  multiSiteSurvey,
  surveyResponses,
  surveyTargets,
  surveys,
  surveysAnswers,
} from '../../fixtures/opt2/surveys';
import { anonymousRequest, opt2RoleRequest } from '../../helpers/admin-request';
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

/** Admin-bundle `key` in French, as the session locale `fr` resolves it. */
const fr = (key: string): string => rbFor('fr').rbKey(key);

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

describe('survey screen headers', () => {
  const SURVEY_ROUTE = routeKey('GET', 'surveys', `/v1/surveys/${MULTI}` as const);
  const LONG_TITLE = 'Cross-program timesheet experience survey '.repeat(7).slice(0, 255);
  const LABELS = { schedule: 'Schedule', targets: 'Targets', responses: 'Responses' } as const;

  it.each(
    (['schedule', 'targets', 'responses'] as const).flatMap((screen) => [
      { screen, kind: 'fixture', title: multiSiteSurvey.title, breaks: 0 },
      { screen, kind: '255-character', title: LONG_TITLE, breaks: 0 },
      { screen, kind: '255-character unbroken', title: 'A'.repeat(255), breaks: 10 },
    ]),
  )('heads $screen with its fixed label and opens its block with the $kind title', async ({ screen, title, breaks }) => {
    const def = surveysScreens.find((candidate) => candidate.screen === screen);
    if (def === undefined) throw new TypeError(`surveys/${screen} is not registered`);
    const ctx = ctxFor(managerRequest({ surveyid: MULTI }), {
      [SURVEY_ROUTE]: { status: 200, body: { data: { ...multiSiteSurvey, title } } },
    });

    const $ = load(String((await def.render(ctx, await def.load(ctx))).body), null, false);
    const opening = $('.block-content').first().children().first();

    expect($('.mura-header h1').text()).toBe(LABELS[screen]);
    expect($('.mura-header').text()).not.toContain(title);
    expect(opening.is('dl')).toBe(true);
    expect([opening.children('dt').text(), opening.children('dd').text()]).toEqual(['Title', title]);
    expect(opening.children('dd').find('wbr')).toHaveLength(breaks);
  });
});

describe('surveys access', () => {
  const SCREENS = surveysScreens.map((def) => ({ screen: def.screen, def }));

  it.each(SCREENS)(
    'sends an anonymous user from $screen to the login, returning to it, unasked',
    async ({ screen, def }) => {
      const target = `/opt2/admin/surveys/${screen}?siteid=${SITE}&surveyid=${MULTI}`;
      const req = anonymousRequest({ mode: 'opt2', requestTarget: target, rc: { siteid: SITE, surveyid: MULTI } });
      const ctx = ctxFor(req);

      const page = await renderScreenPage(def, ctx);

      expect(page).toEqual(secure(req));
      const returnTo = `returnURL=http%3A%2F%2Flocalhost[^&]*${encodeURIComponent(target)}&`;
      expect(page.kind === 'redirect' ? page.location : '').toMatch(
        new RegExp(`^/admin/\\?muraAction=cLogin\\.main&${returnTo}`),
      );
      expect(surveysCalls(ctx.gateway)).toEqual([]);
    },
  );

  it.each(SCREENS)(
    'sends a token without surveys.manager from $screen to no-access, whatever rc claims',
    async ({ def }) => {
      const ctx = ctxFor(requestFor(Roles.financePreparer, { surveyid: MULTI, ...ROLE_LIKE_RC }));

      const page = await renderScreenPage(def, ctx);

      expect(page).toEqual({ kind: 'redirect', location: noAccessUrl() });
      expect(surveysCalls(ctx.gateway)).toEqual([]);
    },
  );

  it.each(ACTIONS)('gates the $action action by surveys.manager from the token only', async ({ action, def, rc }) => {
    const posted = { siteid: SITE, surveyid: MULTI, ...rc, ...CSRF_POSTED };
    const target = `/opt2/admin-actions/surveys/${action}`;
    const anonymous = anonymousRequest({ mode: 'opt2', requestTarget: target, rc: posted });
    const claiming = requestFor(Roles.financePreparer, { ...posted, ...ROLE_LIKE_RC });

    await expect(runGate(anonymous, def.gate)).resolves.toEqual(secure(anonymous));
    await expect(runGate(claiming, def.gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
    await expect(runGate(managerRequest(posted), def.gate)).resolves.toEqual({ kind: 'allow' });
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

    expect(model.headings).toEqual(['Targets', 'Current Targets']);
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

describe('surveys labels', () => {
  // The unlabelled row-actions toggle, then the menu links.
  const rowLinks = ['', fr('email.schedule'), 'Targets', 'Responses'];
  /** The pager link texts on page 1 of 10: the numbers, then the next-page arrow. */
  const pagerLinks = [...Array.from({ length: 10 }, (_, index) => String(index + 1)), ''];

  it.each([
    {
      screen: 'surveys',
      rc: {},
      routes: { [routeKey('GET', 'surveys', '/v1/surveys')]: { status: 200, body: { data: surveys, total: 500 } } },
      headers: ['', fr('params.title'), fr('email.status'), 'Launch', 'Reminders', fr('params.created')],
      labels: [],
      links: [...rowLinks, ...rowLinks, ...pagerLinks],
    },
    {
      screen: 'responses',
      rc: { surveyid: MULTI },
      routes: {
        [routeKey('GET', 'surveys', `/v1/surveys/${MULTI}/responses`)]: {
          status: 200,
          body: { data: surveyResponses.multiSite, total: 500 },
        },
      },
      headers: ['Submitted', 'Respondent Site', 'Respondent', fr('formbuilder.matrix.answers')],
      labels: [],
      links: ['Surveys', fr('email.schedule'), 'Targets', ...pagerLinks],
    },
  ])('renders the $screen labels from the French admin bundle', async ({ screen, rc, routes, ...expected }) => {
    const def = surveysScreens.find((candidate) => candidate.screen === screen);
    if (def === undefined) throw new TypeError(`surveys/${screen} is not registered`);
    const req = opt2RoleRequest(Roles.surveysManager, { rc: { siteid: SITE, ...rc }, session: { rb: 'fr' } });
    const ctx = ctxFor(req, routes);

    const model = fragmentModel(String((await def.render(ctx, await def.load(ctx))).body));

    expect(fr('email.schedule')).not.toBe('Schedule');
    expect({
      headers: model.tables.flatMap((table) => table.headers),
      labels: model.labels,
      links: model.links.map(({ text }) => text),
    }).toEqual(expected);
  });
});
