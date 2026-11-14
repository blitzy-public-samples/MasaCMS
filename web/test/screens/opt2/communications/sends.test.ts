// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { loadSends, sendAction, sendMessage, sendsBody, sendsScreen } from '@/screens/opt2/communications/sends';
import { COMMUNICATIONS_IDS, messageTemplates, messages, sendInvalid } from '../../../fixtures/opt2/communications';
import { fragmentModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { routeKey, type FakeRoute } from '../../../helpers/fake-gateway';
import {
  NOT_FOUND_ANSWER,
  POSTED_CSRF,
  bodyModel,
  communicationsCalls,
  listAnswer,
  screenContext,
  senderRequest,
} from './context';

const MESSAGES_ROUTE = routeKey('GET', 'communications', '/v1/messages');
const SEND_ROUTE = routeKey('POST', 'communications', '/v1/messages');
const TEMPLATES_ROUTE = routeKey('GET', 'communications', '/v1/templates');

/** A template the service lists only on page 2. */
const PAGE_TWO_TEMPLATE = Object.freeze({
  ...messageTemplates[0]!,
  template_id: 'C0330001-0000-0000-0000000000009999',
  name: 'page-two-template',
});

/** Templates over two pages, the fixture templates then {@link PAGE_TWO_TEMPLATE}; `pageTwo` replaces page 2's answer. */
function twoTemplatePages(pageTwo = listAnswer([PAGE_TWO_TEMPLATE], 2, 2)): FakeRoute {
  return (request) => (request.query['pageIndex'] === '2' ? pageTwo : listAnswer(messageTemplates, 1, 2));
}

const EMPTY_SEND = Object.freeze({
  templateId: '',
  to: '',
  from: '',
  variables: '',
  subject: '',
  bodyText: '',
  bodyHtml: '',
});

const POSTED_SEND = Object.freeze({
  ...EMPTY_SEND,
  templateId: COMMUNICATIONS_IDS.templates.surveyReminder,
  to: 'emery.hayes@seed.opt2.test',
  variables: '{"firstName":"Emery","surveyTitle":"Staff Wellbeing Survey","closeDate":"July 3, 2026"}',
});

describe('communications sends screen', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('renders the site sends with delivery-status links and the send form', async () => {
    const ctx = screenContext();
    const view = await sendsScreen.render(ctx, await sendsScreen.load(ctx));

    expect(view.opt2Module).toBe('communications');
    expect(bodyModel(view.body)).toMatchSnapshot();
    expect(communicationsCalls(ctx.gateway).toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { service: 'communications', method: 'GET', path: '/v1/messages' },
      { service: 'communications', method: 'GET', path: '/v1/templates', query: { itemsPerPage: '1000' } },
    ]);
  });

  it('presets the template a templates-screen send link names', async () => {
    const templateId = COMMUNICATIONS_IDS.templates.surveyReminder;
    const ctx = screenContext(senderRequest({ rc: { templateId } }));
    const view = await sendsScreen.render(ctx, await sendsScreen.load(ctx));
    const choice = fragmentModel(toString(view.body)).controls.find((control) => control.name === 'templateId');

    expect(choice?.options.filter((option) => option.selected)).toEqual([
      { value: templateId, label: 'survey-reminder', selected: true },
    ]);
  });

  it('forwards a positive pageIndex for the messages only', async () => {
    const ctx = screenContext(senderRequest({ rc: { pageIndex: '3' } }));
    await loadSends(ctx);

    expect(communicationsCalls(ctx.gateway).map((call) => [call.path, call.query])).toEqual([
      ['/v1/messages', { pageIndex: '3' }],
      ['/v1/templates', { itemsPerPage: '1000' }],
    ]);
  });

  it('shows the id of a template outside the choices and nothing for literal content', async () => {
    const outside = { ...messages[0]!, template_id: 'C0330001-0000-0000-00000000000000FF' };
    const literal = { ...messages[1]!, template_id: '' };
    const ctx = screenContext(senderRequest(), { [MESSAGES_ROUTE]: listAnswer([outside, literal]) });
    const [table] = fragmentModel(toString(sendsBody(ctx, await loadSends(ctx), EMPTY_SEND))).tables;

    expect(table?.rows.map((row) => row[2])).toEqual([outside.template_id, '']);
  });

  it('lists, presets and names a template from a later page, requesting each page once', async () => {
    const ctx = screenContext(senderRequest({ rc: { templateId: PAGE_TWO_TEMPLATE.template_id } }), {
      [TEMPLATES_ROUTE]: twoTemplatePages(),
      [MESSAGES_ROUTE]: listAnswer([{ ...messages[0]!, template_id: PAGE_TWO_TEMPLATE.template_id }]),
    });
    const model = fragmentModel(toString((await sendsScreen.render(ctx, await sendsScreen.load(ctx))).body));
    const choice = model.controls.find((control) => control.name === 'templateId');

    expect(choice?.options.map((option) => option.value)).toEqual([
      '',
      ...messageTemplates.map((template) => template.template_id),
      PAGE_TWO_TEMPLATE.template_id,
    ]);
    expect(choice?.options.filter((option) => option.selected)).toEqual([
      { value: PAGE_TWO_TEMPLATE.template_id, label: 'page-two-template', selected: true },
    ]);
    expect(model.tables[0]?.rows.map((row) => row[2])).toEqual(['page-two-template']);
    expect(
      communicationsCalls(ctx.gateway)
        .filter((call) => call.path === '/v1/templates')
        .map((call) => call.query),
    ).toEqual([{ itemsPerPage: '1000' }, { pageIndex: '2', itemsPerPage: '1000' }]);
  });

  it.each([
    { status: 403, error: GatewayDenialError },
    { status: 503, error: GatewayUnavailableError },
    { status: 400, error: Error },
  ])('fails the load on a $status answer for a later template page', async ({ status, error }) => {
    const ctx = screenContext(senderRequest(), { [TEMPLATES_ROUTE]: twoTemplatePages({ status }) });

    await expect(loadSends(ctx)).rejects.toBeInstanceOf(error);
  });

  it.each([
    { status: 403, error: GatewayDenialError },
    { status: 503, error: GatewayUnavailableError },
    { status: 400, error: Error },
  ])('fails the load on a $status answer', async ({ status, error }) => {
    const ctx = screenContext(senderRequest(), { [MESSAGES_ROUTE]: { status } });

    await expect(loadSends(ctx)).rejects.toBeInstanceOf(error);
  });
});

describe('communications send action', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('sends the posted fields with the posted CSRF pair as headers, then returns to Sends', async () => {
    const ctx = screenContext(senderRequest({ rc: { ...POSTED_SEND, ...POSTED_CSRF } }));

    await expect(sendAction.submit(ctx)).resolves.toEqual({
      kind: 'location',
      location: '/opt2/admin/communications/sends?siteid=tenant-a',
    });
    expect(communicationsCalls(ctx.gateway)).toEqual([
      {
        service: 'communications',
        method: 'POST',
        path: '/v1/messages',
        form: POSTED_SEND,
        headers: { 'x-csrf_token': POSTED_CSRF.csrf_token, 'x-csrf_token_expires': POSTED_CSRF.csrf_token_expires },
      },
    ]);
  });

  it.each([
    { case: 'invalid input', answer: sendInvalid, alert: 'Invalid parameters' },
    { case: 'a template outside the site', answer: NOT_FOUND_ANSWER, alert: 'Not Found' },
  ])('re-renders Sends with the service error and the posted values for $case', async ({ answer, alert }) => {
    const ctx = screenContext(senderRequest({ rc: { ...POSTED_SEND, from: '"><script>x</script>' } }), {
      [SEND_ROUTE]: answer,
    });
    const result = await sendMessage(ctx);

    if (result.kind !== 'render') throw new Error(`expected a re-render, got ${result.kind}`);
    const model = bodyModel(result.view.body);
    expect(model.alerts).toEqual([{ text: alert, className: 'alert alert-error' }]);
    expect(model.controls.find((control) => control.name === 'from')?.value).toBe('"><script>x</script>');
    expect(model.controls.find((control) => control.name === 'variables')?.value).toBe(POSTED_SEND.variables);
    expect(toString(result.view.body)).not.toContain('<script>');
    expect(model).toMatchSnapshot();
  });

  it.each([
    { status: 401, error: GatewayDenialError },
    { status: 503, error: GatewayUnavailableError },
    { status: 500, error: Error },
  ])('fails on a $status answer', async ({ status, error }) => {
    const ctx = screenContext(senderRequest({ rc: POSTED_SEND }), { [SEND_ROUTE]: { status } });

    await expect(sendMessage(ctx)).rejects.toBeInstanceOf(error);
  });
});
