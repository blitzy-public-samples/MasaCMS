// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext, SubmitResult } from '../../registry';
import {
  block,
  controlGroup,
  gridTable,
  opt2View,
  postForm,
  select,
  submitToService,
  textarea,
  textInput,
} from '../shared';
import {
  CSRF_CONTEXT,
  MODULE,
  SENDER_GATE,
  SENDER_ROLES,
  SERVICE,
  actionUrl,
  buttonLink,
  moduleHeader,
  pager,
  postedFields,
  requestedPage,
  screenUrl,
  stateLabel,
  type ListPage,
  type Message,
  type MessageTemplate,
} from './common';

const SCREEN = 'sends';

/** The contract's largest page, so the template choice lists every template the service returns on one page. */
const TEMPLATE_CHOICES = 1000;

const SEND_FIELDS = ['templateId', 'to', 'from', 'variables', 'subject', 'bodyText', 'bodyHtml'] as const;

/** Send form values under the service's field names. */
export type SendForm = Record<(typeof SEND_FIELDS)[number], string>;

/** One page of the site's messages and the templates a send can use. */
export interface SendsData {
  readonly messages: readonly Message[];
  readonly page: ListPage;
  readonly templates: readonly MessageTemplate[];
}

/** The requested page of messages (`listMessages`) and the template choices (`listTemplates`), with the CSRF pair. */
export async function loadSends(ctx: ScreenContext): Promise<SendsData> {
  const { communications } = ctx.gateway;
  const [messages, templates] = await Promise.all([
    communications.call('get', '/v1/messages', { query: { pageIndex: requestedPage(ctx) } }),
    communications.call('get', '/v1/templates', { query: { itemsPerPage: TEMPLATE_CHOICES } }),
    ctx.csrf.tokens(CSRF_CONTEXT),
  ]);
  const page = okBody(messages, SERVICE, 'listMessages').data;
  return { messages: page.items, page, templates: okBody(templates, SERVICE, 'listTemplates').data.items };
}

/** The empty send form, its template preset from the request's `templateId`. */
function requestedForm(ctx: ScreenContext): SendForm {
  const templateId = ctx.req.rc['templateId'] ?? '';
  return { templateId, to: '', from: '', variables: '', subject: '', bodyText: '', bodyHtml: '' };
}

/** Messages list with delivery-status links, then the send form holding `form`, below `alert` when given. */
export function sendsBody(ctx: ScreenContext, data: SendsData, form: SendForm, alert?: SafeHtml): SafeHtml {
  const templateNames = new Map(data.templates.map((template) => [template.template_id, template.name]));
  const rows = data.messages.map((message) => [
    message.to_address,
    message.subject,
    message.template_id === '' ? '' : (templateNames.get(message.template_id) ?? message.template_id),
    stateLabel(message.state),
    message.created,
    message.sent_at,
    buttonLink('Delivery Status', screenUrl(ctx, 'delivery-status', { messageId: message.message_id })),
  ]);
  const headers = ['To', 'Subject', 'Template', 'State', 'Created', 'Sent', 'Actions'];
  const list = gridTable(headers, rows, 'There are no sends.');
  const choices = [
    { value: '', label: 'None (literal content)' },
    ...data.templates.map((template) => ({ value: template.template_id, label: template.name })),
  ];
  const fields = [
    controlGroup('Template', select('templateId', choices, form.templateId)),
    controlGroup('To', textInput('to', form.to, { maxlength: 255, required: true })),
    controlGroup('From', textInput('from', form.from, { maxlength: 255 })),
    controlGroup('Variables (JSON object)', textarea('variables', form.variables, 3)),
    controlGroup('Subject', textInput('subject', form.subject, { maxlength: 255 })),
    controlGroup('Text Body', textarea('bodyText', form.bodyText)),
    controlGroup('HTML Body', textarea('bodyHtml', form.bodyHtml)),
  ];
  const sendForm = postForm(actionUrl(ctx, 'send'), html`${fields}`, 'Send', { hidden: ctx.csrf.render(CSRF_CONTEXT) });
  const listBlock = block(html`${list}${pager(ctx, SCREEN, data.page)}`);
  return html`${moduleHeader(ctx, 'Sends')}${alert}${listBlock}${block(html`<h2>Send Message</h2>${sendForm}`)}`;
}

export const sendsScreen: Opt2ScreenDefinition<SendsData> = Object.freeze({
  module: MODULE,
  screen: SCREEN,
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  load: loadSends,
  render: (ctx: ScreenContext, data: SendsData) => opt2View(MODULE, sendsBody(ctx, data, requestedForm(ctx))),
});

/** Sends the posted message (`sendMessage`), then returns to Sends; a rejection re-renders the posted form. */
export async function sendMessage(ctx: ScreenContext): Promise<SubmitResult> {
  const form: SendForm = postedFields(ctx, SEND_FIELDS);
  return submitToService(
    ctx,
    {
      service: SERVICE,
      call: (gateway, headers) => gateway.communications.call('post', '/v1/messages', { form, headers }),
    },
    { module: MODULE, screen: SCREEN, params: { siteid: ctx.req.session.siteid } },
    async (alert) => sendsBody(ctx, await loadSends(ctx), form, alert),
  );
}

export const sendAction: Opt2ActionDefinition = Object.freeze({
  module: MODULE,
  action: 'send',
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  submit: sendMessage,
});
