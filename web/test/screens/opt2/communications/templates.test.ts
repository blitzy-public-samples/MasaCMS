// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import {
  loadTemplates,
  saveTemplate,
  saveTemplateAction,
  templatesBody,
  templatesScreen,
} from '@/screens/opt2/communications/templates';
import { messageTemplates, saveTemplateInvalid } from '../../../fixtures/opt2/communications';
import { useTestEnv } from '../../../helpers/env';
import { routeKey } from '../../../helpers/fake-gateway';
import { POSTED_CSRF, bodyModel, communicationsCalls, listAnswer, screenContext, senderRequest } from './context';

const LIST_ROUTE = routeKey('GET', 'communications', '/v1/templates');
const SAVE_ROUTE = routeKey('POST', 'communications', '/v1/templates');

const POSTED_TEMPLATE = Object.freeze({
  name: 'timesheet-overdue',
  subject: 'Timesheet {{periodLabel}} is overdue',
  bodyText: 'Hello {{firstName}},\n\nYour timesheet for {{periodLabel}} is still in draft.',
  bodyHtml: '<p>Hello {{firstName}},</p><p>Your timesheet for {{periodLabel}} is still in draft.</p>',
});

/** A one-template list page `pageindex` of `totalpages`. */
const listPage = (pageindex: number, totalpages: number) => listAnswer([messageTemplates[0]], pageindex, totalpages);

describe('communications templates screen', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('renders the site templates with send links and the new-template form', async () => {
    const ctx = screenContext();
    const view = await templatesScreen.render(ctx, await templatesScreen.load(ctx));

    expect(view.opt2Module).toBe('communications');
    expect(bodyModel(view.body)).toMatchSnapshot();
    expect(communicationsCalls(ctx.gateway)).toEqual([
      { service: 'communications', method: 'GET', path: '/v1/templates' },
    ]);
    expect(ctx.gateway.calls.find((call) => call.service === 'identity')?.json).toEqual({ contexts: [''] });
  });

  it('forwards a positive pageIndex and links the neighbouring pages', async () => {
    const ctx = screenContext(senderRequest({ rc: { pageIndex: '2' } }), { [LIST_ROUTE]: listPage(2, 3) });
    const model = bodyModel(templatesBody(ctx, await loadTemplates(ctx)));

    expect(communicationsCalls(ctx.gateway)[0]?.query).toEqual({ pageIndex: '2' });
    expect(model.links.filter((link) => link.text === 'Previous' || link.text === 'Next')).toEqual([
      { text: 'Previous', href: '/opt2/admin/communications/templates?siteid=tenant-a&pageIndex=1' },
      { text: 'Next', href: '/opt2/admin/communications/templates?siteid=tenant-a&pageIndex=3' },
    ]);
  });

  it.each(['', '0', '-1', '1.5', 'abc', '1e3'])('reads pageIndex %j as the first page', async (pageIndex) => {
    const ctx = screenContext(senderRequest({ rc: { pageIndex } }), { [LIST_ROUTE]: listPage(1, 2) });
    const model = bodyModel(templatesBody(ctx, await loadTemplates(ctx)));

    expect(communicationsCalls(ctx.gateway)[0]?.query).toBeUndefined();
    expect(model.links.filter((link) => link.text === 'Previous' || link.text === 'Next')).toEqual([
      { text: 'Next', href: '/opt2/admin/communications/templates?siteid=tenant-a&pageIndex=2' },
    ]);
  });

  it('shows the empty-list message when the site has no templates', async () => {
    const ctx = screenContext(senderRequest(), { [LIST_ROUTE]: listAnswer([]) });
    const markup = toString(templatesBody(ctx, await loadTemplates(ctx)));

    expect(markup).toContain('<div class="help-block-empty">There are no templates.</div>');
    expect(markup).not.toContain('mura-table-grid');
  });

  it('encodes template text from the service', async () => {
    const hostile = {
      ...messageTemplates[0]!,
      name: '<script>alert(1)</script>',
      subject: '"><img src=x onerror=alert(2)>',
    };
    const ctx = screenContext(senderRequest(), { [LIST_ROUTE]: listAnswer([hostile]) });
    const markup = toString(templatesBody(ctx, await loadTemplates(ctx)));

    expect(markup).toContain('&lt;script&gt;alert&#x28;1&#x29;&lt;&#x2f;script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
  });

  it.each([
    { status: 401, error: GatewayDenialError },
    { status: 403, error: GatewayDenialError },
    { status: 503, error: GatewayUnavailableError },
    { status: 400, error: Error },
  ])('fails the load on a $status answer', async ({ status, error }) => {
    const ctx = screenContext(senderRequest(), { [LIST_ROUTE]: { status, body: saveTemplateInvalid.body } });

    await expect(loadTemplates(ctx)).rejects.toBeInstanceOf(error);
  });
});

describe('communications save-template action', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('stores the posted fields with the posted CSRF pair as headers, then returns to Templates', async () => {
    const ctx = screenContext(senderRequest({ rc: { ...POSTED_TEMPLATE, ...POSTED_CSRF, extra: 'ignored' } }));

    await expect(saveTemplateAction.submit(ctx)).resolves.toEqual({
      kind: 'location',
      location: '/opt2/admin/communications/templates?siteid=tenant-a',
    });
    expect(communicationsCalls(ctx.gateway)).toEqual([
      {
        service: 'communications',
        method: 'POST',
        path: '/v1/templates',
        form: POSTED_TEMPLATE,
        headers: { 'x-csrf_token': POSTED_CSRF.csrf_token, 'x-csrf_token_expires': POSTED_CSRF.csrf_token_expires },
      },
    ]);
  });

  it('sends blank fields and no CSRF headers when nothing was posted', async () => {
    const ctx = screenContext(senderRequest());

    await saveTemplate(ctx);
    expect(communicationsCalls(ctx.gateway)[0]).toEqual({
      service: 'communications',
      method: 'POST',
      path: '/v1/templates',
      form: { name: '', subject: '', bodyText: '', bodyHtml: '' },
    });
  });

  it('re-renders Templates with the service error and the posted values on a 400', async () => {
    const ctx = screenContext(senderRequest({ rc: { ...POSTED_TEMPLATE, name: '<b>bold</b>', ...POSTED_CSRF } }), {
      [SAVE_ROUTE]: saveTemplateInvalid,
    });
    const result = await saveTemplate(ctx);

    if (result.kind !== 'render') throw new Error(`expected a re-render, got ${result.kind}`);
    expect(result.view.opt2Module).toBe('communications');
    const model = bodyModel(result.view.body);
    expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
    expect(model.controls.find((control) => control.name === 'name')?.value).toBe('<b>bold</b>');
    expect(toString(result.view.body)).not.toContain('<b>bold</b>');
    expect(model).toMatchSnapshot();
    expect(ctx.gateway.calls.map((call) => `${call.method} ${call.service}${call.path}`).toSorted()).toEqual([
      'GET communications/v1/templates',
      'POST communications/v1/templates',
      'POST identity/v1/csrf/tokens',
    ]);
  });

  it.each([
    { status: 401, error: GatewayDenialError },
    { status: 503, error: GatewayUnavailableError },
    { status: 500, error: Error },
  ])('fails on a $status answer', async ({ status, error }) => {
    const ctx = screenContext(senderRequest({ rc: POSTED_TEMPLATE }), { [SAVE_ROUTE]: { status } });

    await expect(saveTemplate(ctx)).rejects.toBeInstanceOf(error);
  });
});
