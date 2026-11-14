// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { runGate } from '@/lib/access-gate';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { communicationsActions, communicationsScreens } from '@/screens/opt2/communications';
import { deliveryStatusScreen, loadDeliveryStatus } from '@/screens/opt2/communications/delivery-status';
import { loadSends, sendAction, sendMessage, sendsScreen } from '@/screens/opt2/communications/sends';
import {
  loadTemplates,
  saveTemplate,
  saveTemplateAction,
  templatesScreen,
} from '@/screens/opt2/communications/templates';
import { noAccessUrl } from '@/screens/opt2/shared';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext, SubmitResult } from '@/screens/registry';
import { loadShellData, renderAdminDocument, serializeAdminDocument, type ShellView } from '@/shell/document';
import {
  COMMUNICATIONS_IDS,
  communicationsAnswers,
  messageDetail,
  saveTemplateInvalid,
  sendInvalid,
} from '../../fixtures/opt2/communications';
import { makeAdminRequest, opt2RoleRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

type Rc = Readonly<Record<string, string>>;

const SITE = 'tenant-a';

/** The OPT-2 nav group of a sender's communications page: open, with the module's landing link active. */
const COMMUNICATIONS_ACTIVE = Object.freeze({
  className: 'open',
  links: [{ href: `/opt2/admin/communications/templates?siteid=${SITE}`, className: 'active' }],
});

const TEMPLATE_POST: Rc = Object.freeze({
  name: 'timesheet-overdue',
  subject: 'Timesheet {{periodLabel}} is overdue',
  bodyText: 'Hello {{firstName}},\n\nYour timesheet for {{periodLabel}} is still in draft.',
  bodyHtml: '',
});

const SEND_POST: Rc = Object.freeze({
  templateId: COMMUNICATIONS_IDS.templates.surveyReminder,
  to: 'emery.hayes@seed.opt2.test',
  variables: '{"firstName":"Emery","surveyTitle":"Staff Wellbeing Survey","closeDate":"July 3, 2026"}',
});

/** The /v1 answer to a caller without the sender role for the requested site. */
const FORBIDDEN: FakeReply = Object.freeze({
  status: 403,
  body: {
    apiversion: 'v1',
    method: 'invalid',
    error: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
  },
});

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
]);

const LEGACY_CLASS_PATTERNS: readonly RegExp[] = [/^block(-|$)/, /^btn-/, /^alert-/];

const isLegacyClass = (name: string): boolean =>
  LEGACY_CLASSES.has(name) || LEGACY_CLASS_PATTERNS.some((pattern) => pattern.test(name));

/** Class tokens of the elements inside `#mura-content`, in document order. */
function moduleClasses(html: string): string[] {
  const $ = load(html);
  return $('#mura-content [class]')
    .get()
    .flatMap((element) => ($(element).attr('class') ?? '').split(/\s+/).filter((name) => name !== ''));
}

/** The OPT-2 nav group's class and each of its module links with its class. */
function opt2Nav(html: string): { className?: string; links: Array<{ href?: string; className?: string }> } {
  const $ = load(html);
  return {
    className: $('#admin-nav-opt2').attr('class'),
    links: $('#admin-nav-opt2 ul a')
      .get()
      .map((link) => ({ href: $(link).attr('href'), className: $(link).attr('class') })),
  };
}

/** The tenant-a request of a communications sender, with `rc` posted. */
const senderRequest = (rc: Rc = {}): AdminRequest => opt2RoleRequest(Roles.communicationsSender, { rc });

/** A screen context over the communications fixtures and the shell routes, `routes` replacing any of them. */
function ctxFor(req: AdminRequest, routes: FakeRouteTable = {}): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ ...communicationsAnswers, ...routes }) });
}

/** The serialized shell document of a screen; throws on a redirect. */
async function pageHtml(def: Opt2ScreenDefinition, ctx: ScreenContext): Promise<string> {
  const page = await renderScreenPage(def, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return page.html;
}

/** The serialized shell document of an action's re-rendered view, as the action handler renders it. */
async function viewHtml(ctx: ScreenContext, view: ShellView): Promise<string> {
  const data = await loadShellData(ctx.req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
  return serializeAdminDocument(renderAdminDocument(ctx.req, view, ctx.hooks, data));
}

/** The registered communications screen a link opens, with the parameters the link carries. */
function linkTarget(href: string): { def: Opt2ScreenDefinition; rc: Rc } {
  const url = new URL(href, 'http://localhost');
  const [, area, kind, module, screen] = url.pathname.split('/');
  const def = communicationsScreens.find((candidate) => candidate.module === module && candidate.screen === screen);
  if (area !== 'opt2' || kind !== 'admin' || def === undefined) {
    throw new Error(`${href} opens no communications screen`);
  }
  return { def, rc: Object.fromEntries(url.searchParams) };
}

/** The registered communications action a form posts to. */
function formTarget(action: string): Opt2ActionDefinition | undefined {
  const [, area, kind, module, slug] = new URL(action, 'http://localhost').pathname.split('/');
  if (area !== 'opt2' || kind !== 'admin-actions') return undefined;
  return communicationsActions.find((candidate) => candidate.module === module && candidate.action === slug);
}

const SCREEN_CASES: ReadonlyArray<{
  name: string;
  def: Opt2ScreenDefinition;
  rc: Rc;
  title: string;
  forms: readonly string[];
}> = [
  { name: 'templates', def: templatesScreen, rc: {}, title: 'Templates', forms: ['save-template'] },
  { name: 'sends', def: sendsScreen, rc: {}, title: 'Sends', forms: ['send'] },
  {
    name: 'delivery-status',
    def: deliveryStatusScreen,
    rc: { messageId: COMMUNICATIONS_IDS.messages.delivered },
    title: 'Delivery Status',
    forms: [],
  },
  { name: 'delivery-status without a message', def: deliveryStatusScreen, rc: {}, title: 'Delivery Status', forms: [] },
];

// 400 and 403 are the rejections createTemplate and sendMessage both declare; neither declares 409.
const REJECTION_CASES: ReadonlyArray<{
  name: string;
  submit: (ctx: ScreenContext) => Promise<SubmitResult>;
  route: string;
  answer: FakeReply;
  rc: Rc;
  field: string;
  title: string;
}> = [
  {
    name: 'save-template 400',
    submit: saveTemplate,
    route: routeKey('POST', 'communications', '/v1/templates'),
    answer: saveTemplateInvalid,
    rc: TEMPLATE_POST,
    field: 'name',
    title: 'Templates',
  },
  {
    name: 'save-template 403',
    submit: saveTemplate,
    route: routeKey('POST', 'communications', '/v1/templates'),
    answer: FORBIDDEN,
    rc: TEMPLATE_POST,
    field: 'name',
    title: 'Templates',
  },
  {
    name: 'send 400',
    submit: sendMessage,
    route: routeKey('POST', 'communications', '/v1/messages'),
    answer: sendInvalid,
    rc: SEND_POST,
    field: 'to',
    title: 'Sends',
  },
  {
    name: 'send 403',
    submit: sendMessage,
    route: routeKey('POST', 'communications', '/v1/messages'),
    answer: FORBIDDEN,
    rc: SEND_POST,
    field: 'to',
    title: 'Sends',
  },
];

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

// Registrations, per-screen markup, paging and CSRF headers are asserted in communications/*.test.ts, not here.
describe('communications screens in the admin shell', () => {
  it.each(SCREEN_CASES)('renders $name from legacy admin classes with Communications active', async (screen) => {
    const html = await pageHtml(screen.def, ctxFor(senderRequest(screen.rc)));
    const classes = moduleClasses(html);

    expect(opt2Nav(html)).toEqual(COMMUNICATIONS_ACTIVE);
    expect(load(html)('#mura-content .mura-header h1').text()).toBe(screen.title);
    expect(classes).toContain('mura-header');
    expect(classes.filter((name) => !isLegacyClass(name))).toEqual([]);
  });

  it.each(REJECTION_CASES)(
    're-renders a $name answer in the shell with the service message and the posted values',
    async ({ submit, route, answer, rc, field, title }) => {
      const ctx = ctxFor(senderRequest(rc), { [route]: answer });
      const result = await submit(ctx);
      if (result.kind !== 'render') throw new Error(`expected a re-render, got ${result.kind}`);
      const html = await viewHtml(ctx, result.view);
      const $ = load(html);
      const message = (answer.body as { error: { message: string } }).error.message;

      expect(opt2Nav(html)).toEqual(COMMUNICATIONS_ACTIVE);
      expect($('#mura-content .mura-header h1').text()).toBe(title);
      expect($('#mura-content .alert').get().map((alert) => [$(alert).attr('class'), $(alert).text()])).toEqual([
        ['alert alert-error', message],
      ]);
      expect($(`#mura-content [name="${field}"]`).val()).toBe(rc[field]);
      expect(moduleClasses(html).filter((name) => !isLegacyClass(name))).toEqual([]);
    },
  );
});

describe('communications screen links', () => {
  it.each(SCREEN_CASES)('links $name only to communications screens and actions the sender reaches', async (screen) => {
    const $ = load(await pageHtml(screen.def, ctxFor(senderRequest(screen.rc))));
    const hrefs = $('#mura-content a[href]')
      .get()
      .map((link) => $(link).attr('href') ?? '');
    const actions = $('#mura-content form')
      .get()
      .map((form) => formTarget($(form).attr('action') ?? '')?.action);

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const target = linkTarget(href);
      const page = await renderScreenPage(target.def, ctxFor(senderRequest(target.rc)));
      expect(page.kind, href).toBe('document');
    }
    expect(actions).toEqual(screen.forms);
  });

  it("presets the Sends template from a template's Send link", async () => {
    const $ = load(await pageHtml(templatesScreen, ctxFor(senderRequest())));
    const href = $('#mura-content table.mura-table-grid tbody tr')
      .filter((_, row) => $(row).find('td').first().text() === 'survey-reminder')
      .find('a')
      .attr('href');
    const target = linkTarget(href ?? '');
    const $sends = load(await pageHtml(target.def, ctxFor(senderRequest(target.rc))));

    expect(target.def).toBe(sendsScreen);
    expect(
      $sends('#mura-content select[name="templateId"] option[selected]')
        .get()
        .map((option) => [$sends(option).attr('value'), $sends(option).text()]),
    ).toEqual([[COMMUNICATIONS_IDS.templates.surveyReminder, 'survey-reminder']]);
  });

  it("lists the delivery history in service order from a send's Delivery Status link", async () => {
    const $ = load(await pageHtml(sendsScreen, ctxFor(senderRequest())));
    const href = $('#mura-content table.mura-table-grid tbody tr')
      .filter((_, row) => $(row).find('td').first().text() === messageDetail.to_address)
      .find('a')
      .attr('href');
    const target = linkTarget(href ?? '');
    const $status = load(await pageHtml(target.def, ctxFor(senderRequest(target.rc))));
    const history = $status('#mura-content table.mura-table-grid').last();

    expect(target).toEqual({
      def: deliveryStatusScreen,
      rc: { siteid: SITE, messageId: COMMUNICATIONS_IDS.messages.delivered },
    });
    expect(
      history
        .find('tbody tr')
        .get()
        .map((row) => $status(row).find('td').first().text()),
    ).toEqual(['Queued', 'Sent', 'Delivered']);
    expect($status('#mura-content .alert')).toHaveLength(0);
  });
});

describe('communications access and availability', () => {
  const CLAIMED_ROLES: Rc = Object.freeze({
    roles: Roles.communicationsSender,
    role: Roles.communicationsSender,
    memberships: Roles.communicationsSender,
    s2: '1',
  });

  it.each([
    ...communicationsScreens.map((def) => ({ key: `screen ${def.screen}`, gate: def.gate })),
    ...communicationsActions.map((def) => ({ key: `action ${def.action}`, gate: def.gate })),
  ])('sends a role-less user claiming the sender role in the request to no-access on $key', async ({ gate }) => {
    const req = makeAdminRequest({ rc: CLAIMED_ROLES, session: { siteid: SITE } }, 'systemUser');

    await expect(runGate(req, gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
  });

  it.each<{ key: string; run: (ctx: ScreenContext) => Promise<unknown>; rc: Rc }>([
    { key: 'screen templates', run: loadTemplates, rc: {} },
    { key: 'screen sends', run: loadSends, rc: {} },
    { key: 'screen delivery-status', run: loadDeliveryStatus, rc: { messageId: messageDetail.message_id } },
    { key: 'action save-template', run: saveTemplateAction.submit, rc: TEMPLATE_POST },
    { key: 'action send', run: sendAction.submit, rc: SEND_POST },
  ])('rejects $key with GatewayUnavailableError when the gateway is unreachable', async ({ run, rc }) => {
    const ctx = ctxFor(senderRequest(rc));
    ctx.gateway.failWith();

    await expect(run(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
